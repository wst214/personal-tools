"""Issue 5：预警规则内置用例包。"""
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


class _BizStub(BaseHTTPRequestHandler):
    rules = [{"id": 1, "ruleName": "seed"}]

    def log_message(self, *args):  # noqa: ANN002
        return

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/warning/rules?") or self.path == "/warning/rules":
            self._json(200, {"code": 0, "data": {"list": self.rules, "total": len(self.rules)}})
            return
        if self.path.startswith("/warning/rules/"):
            rid = int(self.path.rsplit("/", 1)[-1])
            self._json(200, {"code": 0, "data": {"id": rid, "ruleName": "seed"}})
            return
        self._json(404, {"code": 1})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        body = json.loads(raw.decode("utf-8") or "{}")
        if self.path == "/warning/rules":
            nid = 100 + len(self.rules)
            self.rules.append({"id": nid, "ruleName": body.get("ruleName")})
            self._json(200, {"code": 0, "data": {"id": nid}})
            return
        if self.path.endswith("/enable"):
            self._json(200, {"code": 0, "data": {"ruleStatus": "ENABLED"}})
            return
        self._json(404, {"code": 1})

    def _json(self, code, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def test_builtin_warn_rule_pack_against_stub(tmp_path, monkeypatch):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _BizStub)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    monkeypatch.setattr(env_store, "DEFAULT_ENV_PATH", tmp_path / "env.json")
    monkeypatch.setattr(runner, "load_env", lambda: env_store.load_env(path=tmp_path / "env.json"))
    monkeypatch.setattr("history_store.RUNS_DIR", tmp_path / "runs")
    env_store.save_env({"baseUrl": f"http://127.0.0.1:{port}", "credential": ""}, path=tmp_path / "env.json")

    # 使用仓库内置用例（真实 cases/warn-rule）
    rows = case_store.list_cases("warn-rule")
    assert rows, "应有内置预警规则用例包"
    refs = [{"module": "warn-rule", "id": r["id"]} for r in rows]
    run = runner.run_batch(refs)
    failed = [r for r in run["results"] if r["status"] == "failed"]
    assert not failed, failed
    assert all(r["status"] == "passed" for r in run["results"])
    httpd.shutdown()
