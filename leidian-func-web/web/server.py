#!/usr/bin/env python3
"""功能测试操作台本地服务。"""
from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

WEB_ROOT = Path(__file__).resolve().parent
TOOL_ROOT = WEB_ROOT.parent
sys.path.insert(0, str(WEB_ROOT))

import case_store  # noqa: E402
import env_store  # noqa: E402
import history_store  # noqa: E402
import runner  # noqa: E402

DEFAULT_PORT = int(os.environ.get("FUNC_WEB_PORT", "8200"))


class Handler(BaseHTTPRequestHandler):
    server_version = "leidian-func-web/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith("/api/"):
                self._api_get(path, parse_qs(parsed.query))
            else:
                self._static(path)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc() + "\n")
            self._json(500, {"ok": False, "error": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json()
            if path == "/api/env":
                self._json(200, {"ok": True, "data": env_store.save_env(body)})
            elif path == "/api/env/create":
                self._json(200, {"ok": True, "data": env_store.create_env(body.get("name") or "新环境")})
            elif path == "/api/env/upsert":
                self._json(200, {"ok": True, "data": env_store.upsert_env(body)})
            elif path == "/api/env/activate":
                self._json(200, {"ok": True, "data": env_store.activate_env(str(body.get("id") or ""))})
            elif path == "/api/env/fetch-token":
                self._json(200, {"ok": True, "data": env_store.fetch_token(body.get("id"))})
            elif path == "/api/env/clear-credential":
                self._json(200, {"ok": True, "data": env_store.clear_credential(str(body.get("id") or ""))})
            elif path == "/api/cases":
                module = body.get("module")
                self._json(200, {"ok": True, "data": case_store.save_case(module, body)})
            elif path == "/api/run":
                refs = body.get("cases") or []
                device_types = body.get("deviceTypes")
                if device_types is not None and not isinstance(device_types, list):
                    raise ValueError("deviceTypes 须为数组")
                # 异步启动；前端轮询 /api/run/progress 看进度与结果
                progress = runner.start_batch(refs, device_types)
                self._json(200, {"ok": True, "data": progress})
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except ValueError as e:
            self._json(400, {"ok": False, "error": str(e)})
        except RuntimeError as e:
            self._json(409, {"ok": False, "error": str(e)})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc() + "\n")
            self._json(500, {"ok": False, "error": str(e)})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "cases":
                case_store.delete_case(parts[2], parts[3])
                self._json(200, {"ok": True})
            elif len(parts) == 4 and parts[0] == "api" and parts[1] == "env" and parts[2] == "items":
                self._json(200, {"ok": True, "data": env_store.delete_env(parts[3])})
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except ValueError as e:
            self._json(400, {"ok": False, "error": str(e)})
        except FileNotFoundError:
            self._json(404, {"ok": False, "error": "case not found"})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc() + "\n")
            self._json(500, {"ok": False, "error": str(e)})

    def _api_get(self, path: str, qs: dict[str, list[str]]) -> None:
        if path == "/api/health":
            self._json(200, {"ok": True, "busy": runner.is_busy()})
            return
        if path == "/api/env":
            self._json(200, {"ok": True, "data": env_store.public_view()})
            return
        if path == "/api/modules":
            self._json(
                200,
                {
                    "ok": True,
                    "data": case_store.list_capabilities(),
                    "labels": case_store.UI_LABELS,
                    "deviceTypes": case_store.list_device_types(),
                    "networks": case_store.list_lightning_networks(),
                },
            )
            return
        if path == "/api/cases":
            capability = (qs.get("capability") or [""])[0]
            if capability:
                self._json(200, {"ok": True, "data": case_store.list_capability_cases(capability)})
                return
            module = (qs.get("module") or [""])[0]
            self._json(200, {"ok": True, "data": case_store.list_cases(module)})
            return
        if path.startswith("/api/cases/"):
            parts = path.strip("/").split("/")
            if len(parts) == 4:
                self._json(200, {"ok": True, "data": case_store.get_case(parts[2], parts[3])})
                return
        if path == "/api/run/progress":
            self._json(200, {"ok": True, "data": runner.get_progress()})
            return
        if path == "/api/runs":
            self._json(200, {"ok": True, "data": history_store.list_runs()})
            return
        if path.startswith("/api/runs/"):
            run_id = path[len("/api/runs/") :]
            self._json(200, {"ok": True, "data": history_store.get_run(run_id)})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def _static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        file_path = (WEB_ROOT / rel).resolve()
        if not file_path.is_relative_to(WEB_ROOT.resolve()):
            self.send_error(404)
            return
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return
        data = file_path.read_bytes()
        ctype = "text/plain"
        suffix = file_path.suffix.lower()
        if suffix == ".html":
            ctype = "text/html; charset=utf-8"
        elif suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > 1_000_000:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _json(self, code: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    host = os.environ.get("FUNC_WEB_HOST", "127.0.0.1")
    port = DEFAULT_PORT
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"leidian-func-web listening on http://{host}:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
