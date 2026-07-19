"""Manage cloudflared / cpolar quick-tunnel subprocesses."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

CLOUDFLARE_URL = re.compile(
    r"https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com", re.IGNORECASE
)
CPOLAR_URL = re.compile(
    r"https?://[a-z0-9][a-z0-9.-]*\.cpolar\.(?:cn|io|top)", re.IGNORECASE
)
CPOLAR_ESTABLISHED = re.compile(
    r"Tunnel established at (https?://\S+)", re.IGNORECASE
)

HOST_GATEWAY = os.environ.get("TUNNEL_HOST_GATEWAY", "host.docker.internal")
CPOLAR_REGION = os.environ.get("CPOLAR_REGION", "cn_vip").strip()


def in_docker() -> bool:
    return os.environ.get("TUNNEL_IN_DOCKER", "").strip().lower() in ("1", "true", "yes")


@dataclass
class TunnelState:
    status: str = "idle"
    provider: str = ""
    target: str = ""
    resolved_addr: str = ""
    public_url: str = ""
    error: str = ""
    logs: list[str] = field(default_factory=list)
    pid: int | None = None


class TunnelManager:
    def __init__(self, max_logs: int = 200) -> None:
        self._lock = threading.Lock()
        self._process: subprocess.Popen[str] | None = None
        self._socat_process: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._state = TunnelState()
        self._max_logs = max_logs

    @property
    def state(self) -> TunnelState:
        with self._lock:
            return TunnelState(
                status=self._state.status,
                provider=self._state.provider,
                target=self._state.target,
                resolved_addr=self._state.resolved_addr,
                public_url=self._state.public_url,
                error=self._state.error,
                logs=list(self._state.logs[-self._max_logs :]),
                pid=self._state.pid,
            )

    def begin_start(self, target: str, provider: str = "cloudflare") -> TunnelState:
        """Spawn tunnel process and return immediately; poll state for the public URL."""
        target = (target or "").strip()
        if not target:
            raise ValueError("请输入要映射的本地地址")

        provider = (provider or "cloudflare").strip().lower()
        if provider not in ("cloudflare", "cpolar"):
            raise ValueError("不支持的穿透方式，请选择 cloudflare 或 cpolar")

        with self._lock:
            if self._process and self._process.poll() is None:
                raise RuntimeError("已有隧道在运行，请先停止当前映射")

            if provider == "cloudflare":
                cmd, env = build_cloudflare_cmd(target)
                resolved_addr = resolve_target_url(target)
                socat_forward = None
            else:
                cmd, env, socat_forward = build_cpolar_cmd(target)
                host, port, _ = parse_target(target)
                if socat_forward:
                    resolved_addr = f"宿主机 localhost:{port}"
                else:
                    resolved_addr = f"127.0.0.1:{port}"

            self._state = TunnelState(
                status="starting",
                provider=provider,
                target=target,
                resolved_addr=resolved_addr,
                logs=[],
            )

            try:
                if socat_forward:
                    gw_host, gw_port = socat_forward
                    self._socat_process = subprocess.Popen(
                        [
                            "socat",
                            f"TCP-LISTEN:{gw_port},fork,reuseaddr",
                            f"TCP:{gw_host}:{gw_port}",
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                else:
                    self._socat_process = None

                self._process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=env,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as exc:
                self._state.status = "error"
                self._state.error = str(exc)
                if self._socat_process and self._socat_process.poll() is None:
                    self._socat_process.terminate()
                self._socat_process = None
                raise

            self._state.pid = self._process.pid
            self._reader = threading.Thread(
                target=self._read_output, args=(provider,), daemon=True
            )
            self._reader.start()

        return self.state

    def start(self, target: str, provider: str = "cloudflare") -> TunnelState:
        self.begin_start(target, provider=provider)

        deadline = time.time() + 90
        while time.time() < deadline:
            state = self.state
            if state.public_url:
                return state
            if state.status == "error":
                raise RuntimeError(state.error or "隧道启动失败")
            if state.status == "stopped":
                raise RuntimeError(state.error or "隧道进程已退出")
            time.sleep(0.25)

        self.stop()
        hint = (
            "请检查 CPOLAR_AUTHTOKEN 是否已在 .env 中配置"
            if provider == "cpolar"
            else "请检查代理/VPN 是否拦截 Cloudflare"
        )
        raise TimeoutError(f"等待公网地址超时，{hint}")

    def stop(self) -> TunnelState:
        with self._lock:
            proc = self._process
            socat = self._socat_process
            self._process = None
            self._socat_process = None

        for child in (socat, proc):
            if child and child.poll() is None:
                child.terminate()
        for child in (socat, proc):
            if child and child.poll() is None:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)

        with self._lock:
            if self._state.status not in ("error",):
                self._state.status = "stopped" if self._state.public_url else "idle"
            if not self._state.public_url and not self._state.error:
                self._state.error = ""
            return TunnelState(
                status=self._state.status,
                provider=self._state.provider,
                target=self._state.target,
                resolved_addr=self._state.resolved_addr,
                public_url=self._state.public_url,
                error=self._state.error,
                logs=list(self._state.logs[-self._max_logs :]),
                pid=None,
            )

    def _read_output(self, provider: str) -> None:
        proc = self._process
        if not proc or not proc.stdout:
            return

        pattern = CPOLAR_URL if provider == "cpolar" else CLOUDFLARE_URL
        https_urls: list[str] = []
        http_urls: list[str] = []

        for line in proc.stdout:
            text = line.rstrip()
            with self._lock:
                self._state.logs.append(text)
                if len(self._state.logs) > self._max_logs:
                    self._state.logs = self._state.logs[-self._max_logs :]

                for match in pattern.finditer(text):
                    url = match.group(0)
                    if url.startswith("https://"):
                        https_urls.append(url)
                    else:
                        http_urls.append(url)

                if provider == "cpolar":
                    established = CPOLAR_ESTABLISHED.search(text)
                    if established:
                        url = established.group(1).rstrip(".,;)")
                        if url.startswith("https://"):
                            https_urls.append(url)
                        else:
                            http_urls.append(url)

                if https_urls or http_urls:
                    self._state.public_url = https_urls[0] if https_urls else http_urls[0]
                    self._state.status = "running"
                    self._state.error = ""

                if provider == "cpolar" and "level=error" in text:
                    self._state.status = "error"
                    if "connection refused" in text.lower():
                        self._state.error = (
                            "cpolar 连接失败，请关闭代理 TUN 模式，或检查本地端口是否已启动"
                        )
                    elif "unavailable" not in text.lower():
                        self._state.error = text.split("msg=", 1)[-1].strip()[:200]

        code = proc.wait()
        with self._lock:
            if code != 0 and not self._state.public_url:
                self._state.status = "error"
                if not self._state.error:
                    tool = "cpolar" if provider == "cpolar" else "cloudflared"
                    self._state.error = f"{tool} 退出 (code {code})"
            elif self._state.status == "running":
                self._state.status = "stopped"


def build_cloudflare_cmd(target: str) -> tuple[list[str], dict[str, str]]:
    cloudflared = find_cloudflared()
    if not cloudflared:
        raise FileNotFoundError(
            "未找到 cloudflared。请安装: winget install Cloudflare.cloudflared"
        )

    env = os.environ.copy()
    no_proxy = (
        "localhost,127.0.0.1,trycloudflare.com,api.trycloudflare.com,"
        "cloudflare.com,.cloudflare.com"
    )
    env["NO_PROXY"] = no_proxy
    env["no_proxy"] = no_proxy

    resolved = resolve_target_url(target)
    cmd = [cloudflared, "tunnel", "--no-autoupdate", "--url", resolved]
    return cmd, env


def build_cpolar_cmd(
    target: str,
) -> tuple[list[str], dict[str, str], tuple[str, int] | None]:
    cpolar = find_cpolar()
    if not cpolar:
        raise FileNotFoundError("未找到 cpolar。请使用 Docker 镜像或安装 cpolar 客户端")

    token = os.environ.get("CPOLAR_AUTHTOKEN", "").strip()
    if not token:
        raise ValueError(
            "未配置 CPOLAR_AUTHTOKEN。请在 tunnel-panel/.env 中填写，"
            "Token 在 https://dashboard.cpolar.com 验证页获取"
        )

    host, port, _scheme = parse_target(target)
    env = os.environ.copy()

    # cpolar 的 addr 只支持端口号；Docker 内用 socat 转发到宿主机
    addr = str(port)
    socat_forward: tuple[str, int] | None = None
    if in_docker() and host == HOST_GATEWAY:
        socat_forward = (HOST_GATEWAY, port)

    config_path = "/tmp/cpolar-panel.yml"
    region_line = f"    region: {CPOLAR_REGION}\n" if CPOLAR_REGION else ""
    config_text = (
        f"authtoken: {token}\n"
        "tunnels:\n"
        "  panel:\n"
        "    proto: http\n"
        f"    addr: {addr}\n"
        f"{region_line}"
    )
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write(config_text)

    cmd = [
        cpolar,
        "start",
        "panel",
        "-config",
        config_path,
        "-log=stdout",
        "-log-level=INFO",
    ]
    return cmd, env, socat_forward


def find_cloudflared() -> str | None:
    path = os.environ.get("CLOUDFLARED_PATH", "").strip()
    if path and os.path.isfile(path):
        return path

    found = shutil.which("cloudflared")
    if found:
        return found

    for candidate in (
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "cloudflared", "cloudflared.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "cloudflared", "cloudflared.exe"),
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def find_cpolar() -> str | None:
    path = os.environ.get("CPOLAR_PATH", "").strip()
    if path and os.path.isfile(path):
        return path

    found = shutil.which("cpolar")
    if found:
        return found

    for candidate in ("/usr/local/bin/cpolar", "/usr/bin/cpolar"):
        if os.path.isfile(candidate):
            return candidate
    return None


def cpolar_configured() -> bool:
    return bool(os.environ.get("CPOLAR_AUTHTOKEN", "").strip()) and find_cpolar() is not None


def resolve_target_url(raw: str) -> str:
    host, port, scheme = parse_target(raw)
    return f"{scheme}://{host}:{port}"


def resolve_target_addr(raw: str) -> str:
    host, port, _scheme = parse_target(raw)
    return f"{host}:{port}"


def parse_target(raw: str) -> tuple[str, int, str]:
    text = raw.strip()
    if not text:
        raise ValueError("无法解析地址，示例: http://localhost:8080")

    # 纯端口号：52262
    if re.fullmatch(r"\d{1,5}", text):
        port = int(text)
        if port < 1 or port > 65535:
            raise ValueError("端口号无效")
        return HOST_GATEWAY, port, "http"

    if "://" not in text:
        text = f"http://{text}"

    parsed = urlparse(text)
    if not parsed.hostname:
        raise ValueError("无法解析地址，示例: http://localhost:8080")

    port = parsed.port
    scheme = parsed.scheme or "http"
    if port is None:
        port = 443 if scheme == "https" else 80

    host = parsed.hostname.lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        host = HOST_GATEWAY if in_docker() else "127.0.0.1"

    return host, port, scheme
