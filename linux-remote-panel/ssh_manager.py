"""SSH connection, command execution, and SFTP file operations."""

from __future__ import annotations

import json
import os
import stat
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import paramiko


BASE_DIR = Path(__file__).resolve().parent
CONFIG_DIR = BASE_DIR / "config"
DATA_DIR = Path(os.environ.get("DATA_DIR", str(CONFIG_DIR)))
USER_COMMANDS_FILE = DATA_DIR / "user_commands.json"
PROFILES_FILE = DATA_DIR / "profiles.json"
WSL_DEFAULTS_FILE = DATA_DIR / "wsl.defaults.json"
DEFAULT_COMMANDS_FILE = CONFIG_DIR / "default_commands.json"


@dataclass
class ConnectionConfig:
    host: str
    port: int = 22
    username: str = "root"
    password: str = ""
    private_key: str = ""
    passphrase: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ConnectionConfig":
        return cls(
            host=data.get("host", ""),
            port=int(data.get("port", 22)),
            username=data.get("username", "root"),
            password=data.get("password", ""),
            private_key=data.get("private_key", ""),
            passphrase=data.get("passphrase", ""),
        )


def normalize_remote_path(path: str) -> str:
    raw = (path or "/").strip().replace("\\", "/")
    if not raw.startswith("/"):
        raw = f"/{raw}"
    parts: list[str] = []
    for segment in raw.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if parts:
                parts.pop()
            continue
        parts.append(segment)
    return "/" + "/".join(parts) if parts else "/"


def join_remote_path(base: str, name: str) -> str:
    base_norm = normalize_remote_path(base).rstrip("/")
    clean_name = name.strip().replace("\\", "/").lstrip("/")
    if ".." in clean_name.split("/"):
        raise ValueError("非法路径")
    if not clean_name:
        return base_norm or "/"
    return normalize_remote_path(f"{base_norm}/{clean_name}")


class SSHSession:
    def __init__(self) -> None:
        self._client: paramiko.SSHClient | None = None
        self._sftp: paramiko.SFTPClient | None = None
        self._lock = threading.RLock()
        self.config: ConnectionConfig | None = None
        self.cwd: str = "/"

    @property
    def connected(self) -> bool:
        with self._lock:
            client = self._client
            if client is None or self.config is None:
                return False
            transport = client.get_transport()
            return transport is not None and transport.is_active()

    def connect(self, config: ConnectionConfig) -> None:
        client = self._open_client(config)
        cwd = self._detect_home_with_client(client)
        with self._lock:
            self._close_unlocked()
            self._client = client
            self.config = config
            self.cwd = cwd

    def reconnect(self) -> None:
        with self._lock:
            if self.config is None:
                raise RuntimeError("未连接到远程服务器")
            config = self.config
            self._close_unlocked(keep_config=True)
            self._client = self._open_client(config)
            self._reset_sftp_unlocked()

    def disconnect(self) -> None:
        with self._lock:
            self._close_unlocked()

    def ping(self) -> bool:
        with self._lock:
            try:
                self._ensure_alive_unlocked()
                return True
            except Exception:  # noqa: BLE001
                return False

    def _open_client(self, config: ConnectionConfig) -> paramiko.SSHClient:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

        connect_kwargs: dict[str, Any] = {
            "hostname": config.host,
            "port": config.port,
            "username": config.username,
            "timeout": 15,
            "banner_timeout": 15,
            "auth_timeout": 15,
            "allow_agent": False,
            "look_for_keys": False,
        }

        if config.private_key.strip():
            key_path = _resolve_key_path(config.private_key.strip())
            key = _load_private_key(key_path, config.passphrase)
            connect_kwargs["pkey"] = key
        elif config.password:
            connect_kwargs["password"] = config.password
        else:
            raise ValueError("请提供密码或私钥")

        client.connect(**connect_kwargs)
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(30)
        return client

    def _close_unlocked(self, keep_config: bool = False) -> None:
        self._reset_sftp_unlocked()
        if self._client is not None:
            try:
                self._client.close()
            except Exception:  # noqa: BLE001
                pass
            self._client = None
        if not keep_config:
            self.config = None
            self.cwd = "/"

    def _reset_sftp_unlocked(self) -> None:
        if self._sftp is not None:
            try:
                self._sftp.close()
            except Exception:  # noqa: BLE001
                pass
            self._sftp = None

    def _ensure_alive_unlocked(self) -> None:
        if self._client is None or self.config is None:
            raise RuntimeError("未连接到远程服务器")

        transport = self._client.get_transport()
        if transport is None or not transport.is_active():
            self._reconnect_unlocked()
            return

        try:
            transport.send_ignore()
        except Exception as exc:  # noqa: BLE001
            if self._is_connection_error(exc):
                self._reconnect_unlocked()
                return
            raise

    def _reconnect_unlocked(self) -> None:
        if self.config is None:
            raise RuntimeError("未连接到远程服务器")
        config = self.config
        self._close_unlocked(keep_config=True)
        self._client = self._open_client(config)
        self._reset_sftp_unlocked()

    @staticmethod
    def _is_connection_error(exc: BaseException) -> bool:
        if isinstance(exc, (paramiko.SSHException, EOFError, OSError, TimeoutError, ConnectionError)):
            return True
        message = str(exc).lower()
        keywords = (
            "not connected",
            "eof",
            "broken pipe",
            "connection reset",
            "connection lost",
            "socket is closed",
            "server connection dropped",
            "no existing session",
            "error reading ssh protocol banner",
        )
        return any(keyword in message for keyword in keywords)

    def _detect_home_with_client(self, client: paramiko.SSHClient) -> str:
        try:
            _, stdout, _ = client.exec_command("pwd", timeout=10)
            exit_code = stdout.channel.recv_exit_status()
            if exit_code != 0:
                return "/"
            path = stdout.read().decode("utf-8", errors="replace").strip()
            return normalize_remote_path(path) if path else "/"
        except Exception:  # noqa: BLE001
            return "/"

    def _detect_home(self) -> str:
        with self._lock:
            if self._client is None:
                return "/"
            return self._detect_home_with_client(self._client)

    def _get_sftp_unlocked(self) -> paramiko.SFTPClient:
        assert self._client is not None
        if self._sftp is None:
            self._sftp = self._client.open_sftp()
        return self._sftp

    def _get_sftp(self) -> paramiko.SFTPClient:
        with self._lock:
            self._ensure_alive_unlocked()
            return self._get_sftp_unlocked()

    def _run_with_retry(self, action):
        with self._lock:
            self._ensure_alive_unlocked()
            try:
                return action()
            except Exception as exc:  # noqa: BLE001
                if not self._is_connection_error(exc) or self.config is None:
                    self._reset_sftp_unlocked()
                    raise
                self._reconnect_unlocked()
                return action()

    def execute(self, command: str, timeout: int = 120) -> dict[str, Any]:
        def run() -> dict[str, Any]:
            assert self._client is not None
            _, stdout, stderr = self._client.exec_command(command, timeout=timeout)
            exit_code = stdout.channel.recv_exit_status()
            out = stdout.read().decode("utf-8", errors="replace")
            err = stderr.read().decode("utf-8", errors="replace")
            return {
                "command": command,
                "stdout": out,
                "stderr": err,
                "exit_code": exit_code,
                "success": exit_code == 0,
            }

        return self._run_with_retry(run)

    def list_directory(self, path: str | None = None) -> dict[str, Any]:
        target = normalize_remote_path(path or self.cwd)

        def run() -> dict[str, Any]:
            sftp = self._get_sftp_unlocked()
            entries: list[dict[str, Any]] = []
            for attr in sftp.listdir_attr(target):
                is_dir = stat.S_ISDIR(attr.st_mode)
                modified = ""
                if attr.st_mtime:
                    modified = datetime.fromtimestamp(attr.st_mtime, tz=timezone.utc).strftime(
                        "%Y-%m-%d %H:%M"
                    )
                entries.append(
                    {
                        "name": attr.filename,
                        "path": join_remote_path(target, attr.filename),
                        "is_dir": is_dir,
                        "size": attr.st_size or 0,
                        "modified": modified,
                    }
                )
            entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))
            self.cwd = target
            return {"path": target, "entries": entries}

        return self._run_with_retry(run)

    def read_file(self, path: str, max_size: int = 20 * 1024 * 1024) -> tuple[bytes, str]:
        remote_path = normalize_remote_path(path)

        def run() -> tuple[bytes, str]:
            sftp = self._get_sftp_unlocked()
            attr = sftp.stat(remote_path)
            if stat.S_ISDIR(attr.st_mode):
                raise ValueError("不能下载目录")
            if attr.st_size > max_size:
                raise ValueError(f"文件过大（>{max_size // (1024 * 1024)}MB）")
            with sftp.open(remote_path, "rb") as remote_file:
                return remote_file.read(), Path(remote_path).name

        return self._run_with_retry(run)

    def write_file(self, path: str, content: bytes) -> None:
        remote_path = normalize_remote_path(path)

        def run() -> None:
            sftp = self._get_sftp_unlocked()
            with sftp.open(remote_path, "wb") as remote_file:
                remote_file.write(content)

        self._run_with_retry(run)

    def delete_path(self, path: str) -> None:
        remote_path = normalize_remote_path(path)

        def run() -> None:
            sftp = self._get_sftp_unlocked()
            attr = sftp.stat(remote_path)
            if stat.S_ISDIR(attr.st_mode):
                raise ValueError("暂不支持删除目录，请使用终端命令")
            sftp.remove(remote_path)

        self._run_with_retry(run)

    def system_snapshot(self) -> dict[str, str]:
        commands = {
            "hostname": "hostname",
            "uptime": "uptime -p 2>/dev/null || uptime",
            "load": "cat /proc/loadavg 2>/dev/null || uptime | awk -F'load average:' '{print $2}'",
            "memory": "free -h | awk 'NR<=2'",
            "disk": "df -hT | awk 'NR==1 || /\\/$/ {print}'",
            "docker": "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -8",
        }
        snapshot: dict[str, str] = {}
        for key, command in commands.items():
            try:
                result = self.execute(command, timeout=20)
                text = (result["stdout"] or result["stderr"] or "").strip()
                snapshot[key] = text or "—"
            except Exception as exc:  # noqa: BLE001
                snapshot[key] = str(exc)
        return snapshot


def _resolve_key_path(key_path: str) -> str:
    path = expand_user_path(key_path)
    if os.path.isfile(path):
        return path
    keys_dir = Path(os.environ.get("SSH_KEYS_DIR", "/ssh-keys"))
    alt = keys_dir / Path(path).name
    if alt.is_file():
        return str(alt)
    return path


def _load_private_key(key_path: str, passphrase: str) -> paramiko.PKey:
    password = passphrase or None
    loaders = [
        paramiko.RSAKey.from_private_key_file,
        paramiko.Ed25519Key.from_private_key_file,
        paramiko.ECDSAKey.from_private_key_file,
    ]
    last_error: Exception | None = None
    for loader in loaders:
        try:
            return loader(key_path, password=password)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
    raise ValueError(f"无法加载私钥: {last_error}")


def load_commands() -> dict[str, Any]:
    with DEFAULT_COMMANDS_FILE.open(encoding="utf-8") as f:
        data = json.load(f)

    if USER_COMMANDS_FILE.exists():
        with USER_COMMANDS_FILE.open(encoding="utf-8") as f:
            user_data = json.load(f)
        data = _merge_commands(data, user_data)
    return data


def save_user_commands(data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with USER_COMMANDS_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _merge_commands(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    categories = {c["id"]: c for c in base.get("categories", [])}
    for category in extra.get("categories", []):
        cid = category.get("id")
        if cid in categories:
            existing_ids = {b["id"] for b in categories[cid].get("buttons", [])}
            for button in category.get("buttons", []):
                if button.get("id") not in existing_ids:
                    categories[cid]["buttons"].append(button)
        else:
            categories[cid] = category
    return {"categories": list(categories.values())}


def load_profiles() -> list[dict[str, Any]]:
    if not PROFILES_FILE.exists():
        return []
    with PROFILES_FILE.open(encoding="utf-8") as f:
        return json.load(f)


def load_wsl_defaults() -> dict[str, Any]:
    if not WSL_DEFAULTS_FILE.exists():
        return {}
    with WSL_DEFAULTS_FILE.open(encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def save_profiles(profiles: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    sanitized = []
    for profile in profiles:
        item = dict(profile)
        item.pop("password", None)
        item.pop("passphrase", None)
        sanitized.append(item)
    with PROFILES_FILE.open("w", encoding="utf-8") as f:
        json.dump(sanitized, f, ensure_ascii=False, indent=2)


def expand_user_path(path: str) -> str:
    return os.path.expanduser(path.strip())
