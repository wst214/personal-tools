"""Call Windows host WSL helper from Docker container."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

WSL_HELPER_URL = os.environ.get("WSL_HELPER_URL", "http://host.docker.internal:5758").rstrip("/")
WSL_HELPER_TIMEOUT = int(os.environ.get("WSL_HELPER_TIMEOUT", "30"))


def call_helper(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    url = f"{WSL_HELPER_URL}{path}"
    data = None
    headers: dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=WSL_HELPER_TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {"ok": True}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        if "Internal Server Error" in detail:
            raise RuntimeError("WSL 助手执行失败，请重启 wsl-helper\\start.ps1 后重试") from exc
        raise RuntimeError(detail or f"WSL 助手请求失败 ({exc.code})") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "WSL 助手未运行。请在本机 PowerShell 执行: mytools\\wsl-helper\\start.ps1"
        ) from exc
