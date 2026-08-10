"""Issue 6：预警抑制管理用例包（含跳过）。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
sys.path.insert(0, str(WEB))

import case_store  # noqa: E402
import env_store  # noqa: E402
import runner  # noqa: E402


def test_suppress_pack_defaults_to_skip(tmp_path, monkeypatch):
    monkeypatch.setattr(env_store, "DEFAULT_ENV_PATH", tmp_path / "env.json")
    monkeypatch.setattr(runner, "load_env", lambda: env_store.load_env(path=tmp_path / "env.json"))
    monkeypatch.setattr("history_store.RUNS_DIR", tmp_path / "runs")
    env_store.save_env({"baseUrl": "http://127.0.0.1:1", "credential": ""}, path=tmp_path / "env.json")

    rows = case_store.list_cases("warn-suppress")
    assert rows, "应有预警抑制管理用例包"
    assert all(r["skip"] for r in rows)
    refs = [{"module": "warn-suppress", "id": r["id"]} for r in rows]
    run = runner.run_batch(refs)
    assert all(r["status"] == "skipped" for r in run["results"])
    assert all(r.get("reason") for r in run["results"])
    assert run["summary"]["failed"] == 0


def test_suppress_executes_when_not_skipped(tmp_path, monkeypatch):
    """接口可用且取消跳过时，应给出通过或失败（非跳过）。"""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Stub(BaseHTTPRequestHandler):
        def log_message(self, *a):  # noqa: ANN002
            return

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            data = json.dumps({"code": 0, "data": {"id": 1}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    monkeypatch.setattr(case_store, "CASES_ROOT", tmp_path)
    monkeypatch.setattr(env_store, "DEFAULT_ENV_PATH", tmp_path / "env.json")
    monkeypatch.setattr(runner, "load_env", lambda: env_store.load_env(path=tmp_path / "env.json"))
    monkeypatch.setattr("history_store.RUNS_DIR", tmp_path / "runs")
    env_store.save_env({"baseUrl": f"http://127.0.0.1:{port}", "credential": ""}, path=tmp_path / "env.json")
    case_store.save_case(
        "warn-suppress",
        {
            "id": "ws-live",
            "name": "可执行",
            "skip": False,
            "steps": [
                {
                    "method": "POST",
                    "path": "/warning/suppressions",
                    "body": {"siteId": 1},
                    "expect": {"status": 200, "fields": {"code": 0}},
                }
            ],
        },
    )
    run = runner.run_batch([{"module": "warn-suppress", "id": "ws-live"}])
    assert run["results"][0]["status"] == "passed"
    httpd.shutdown()
