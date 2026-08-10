"""Issue 4：勾选跑批、自动请求与判定条件。"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
sys.path.insert(0, str(WEB))

import case_store  # noqa: E402
import env_store  # noqa: E402
import runner  # noqa: E402


class _MockApi(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: ANN002
        return

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/warning/rules"):
            body = {"code": 0, "data": {"list": [{"id": 42, "ruleName": "x"}], "total": 1}}
        else:
            body = {"code": 404}
            self._json(404, body)
            return
        self._json(200, body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path == "/warning/rules":
            self._json(200, {"code": 0, "data": {"id": 99, "ruleName": "n"}})
            return
        if self.path.endswith("/enable"):
            self._json(200, {"code": 0, "data": {"id": 99, "ruleStatus": "ENABLED"}})
            return
        self._json(404, {"code": 1, "raw": raw.decode("utf-8", errors="replace")})

    def _json(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _start_mock():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _MockApi)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def test_batch_pass_fail_and_reason(tmp_path, monkeypatch):
    httpd, port = _start_mock()
    monkeypatch.setattr(case_store, "CASES_ROOT", tmp_path)
    monkeypatch.setattr(env_store, "DEFAULT_ENV_PATH", tmp_path / "env.json")
    monkeypatch.setattr(runner, "load_env", lambda: env_store.load_env(path=tmp_path / "env.json"))
    monkeypatch.setattr(
        "history_store.RUNS_DIR",
        tmp_path / "runs",
    )

    env_store.save_env({"baseUrl": f"http://127.0.0.1:{port}", "credential": "t"}, path=tmp_path / "env.json")
    case_store.save_case(
        "warn-rule",
        {
            "id": "ok-1",
            "name": "列表应通过",
            "steps": [{"method": "GET", "path": "/warning/rules", "expect": {"status": 200, "fields": {"code": 0}}}],
        },
    )
    case_store.save_case(
        "warn-rule",
        {
            "id": "bad-1",
            "name": "状态码失败",
            "steps": [{"method": "GET", "path": "/warning/rules", "expect": {"status": 201}}],
        },
    )

    run = runner.run_batch([{"module": "warn-rule", "id": "ok-1"}, {"module": "warn-rule", "id": "bad-1"}])
    by_id = {r["caseId"]: r for r in run["results"]}
    assert by_id["ok-1"]["status"] == "passed"
    assert by_id["bad-1"]["status"] == "failed"
    assert "状态码不符" in by_id["bad-1"]["reason"]
    httpd.shutdown()


def test_mutex_rejects_second_run(monkeypatch):
    # 轻量：直接置 busy
    monkeypatch.setattr(runner, "_busy", True)
    try:
        raised = False
        try:
            runner.run_batch([])
        except RuntimeError as e:
            raised = "跑批" in str(e)
        assert raised
    finally:
        monkeypatch.setattr(runner, "_busy", False)
