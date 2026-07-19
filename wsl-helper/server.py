"""Windows host helper: wake WSL, start sshd, optionally open terminal."""

from __future__ import annotations

import shutil
import subprocess
import sys
from flask import Flask, jsonify, request

app = Flask(__name__)

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def run_cmd(cmd: list[str], timeout: int = 30) -> tuple[int, str, str]:
    kwargs: dict = {}
    if sys.platform == "win32" and _NO_WINDOW:
        kwargs["creationflags"] = _NO_WINDOW
    result = subprocess.run(
        cmd,
        capture_output=True,
        timeout=timeout,
        shell=False,
        encoding="utf-8",
        errors="replace",
        **kwargs,
    )
    stdout = (result.stdout or "").strip()
    stderr = (result.stderr or "").strip()
    return result.returncode, stdout, stderr


def get_wsl_ip() -> str:
    code, out, _ = run_cmd(["wsl.exe", "hostname", "-I"], timeout=15)
    if code != 0 or not out.strip():
        return ""
    return out.strip().split()[0]


def is_ssh_listening() -> bool:
    code, out, _ = run_cmd(
        [
            "wsl.exe",
            "-e",
            "bash",
            "-lc",
            "ss -tln 2>/dev/null | grep -q ':22 ' && echo yes || echo no",
        ],
        timeout=15,
    )
    return code == 0 and out.strip() == "yes"


def ensure_ssh_running() -> tuple[bool, str, list[dict[str, str | int]]]:
    attempts_log: list[dict[str, str | int]] = []

    if is_ssh_listening():
        return True, "SSH 已运行", attempts_log

    start_attempts = [
        (["wsl.exe", "-u", "root", "-e", "systemctl", "start", "ssh.socket"], "ssh.socket"),
        (["wsl.exe", "-u", "root", "-e", "/usr/sbin/sshd"], "sshd"),
        (["wsl.exe", "-u", "root", "-e", "systemctl", "start", "ssh.service"], "ssh.service"),
        (["wsl.exe", "-u", "root", "-e", "service", "ssh", "start"], "service ssh"),
    ]

    last_err = ""
    for cmd, label in start_attempts:
        code, _, err = run_cmd(cmd, timeout=20)
        attempts_log.append({"method": label, "code": code, "error": err})
        if is_ssh_listening():
            return True, f"SSH 已启动（{label}）", attempts_log
        if err:
            last_err = err

    return (
        False,
        f"SSH 未能启动: {last_err or '请先在 WSL 安装 openssh-server'}",
        attempts_log,
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "wsl-helper"})


@app.get("/wsl/info")
def wsl_info():
    code, user, err = run_cmd(["wsl.exe", "-e", "whoami"], timeout=15)
    if code != 0:
        return jsonify({"ok": False, "error": err or "无法读取 WSL 用户名"}), 400
    return jsonify({"ok": True, "username": user, "host": get_wsl_ip()})


@app.post("/wsl/prepare")
def wsl_prepare():
    payload = request.get_json(silent=True) or {}
    open_terminal = bool(payload.get("open_terminal"))

    try:
        run_cmd(["wsl.exe", "-e", "true"], timeout=20)

        ssh_running, message, attempts = ensure_ssh_running()

        terminal_opened = False
        if open_terminal:
            if shutil.which("wt.exe"):
                subprocess.Popen(["wt.exe", "wsl.exe"], shell=False)
                terminal_opened = True
            else:
                subprocess.Popen(["cmd", "/c", "start", "", "wsl.exe"], shell=False)
                terminal_opened = True

        return jsonify(
            {
                "ok": ssh_running,
                "ssh_running": ssh_running,
                "host": get_wsl_ip(),
                "terminal_opened": terminal_opened,
                "message": message,
                "details": {"attempts": attempts},
            }
        )
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5758, debug=False)
