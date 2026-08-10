"""Issue 7：历史执行记录。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
sys.path.insert(0, str(WEB))

import history_store  # noqa: E402


def test_history_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(history_store, "RUNS_DIR", tmp_path / "runs")
    saved = history_store.save_run(
        [
            {"caseId": "a", "name": "A", "status": "passed", "reason": ""},
            {"caseId": "b", "name": "B", "status": "failed", "reason": "x"},
        ]
    )
    assert saved["id"]
    rows = history_store.list_runs()
    assert any(r["id"] == saved["id"] for r in rows)
    detail = history_store.get_run(saved["id"])
    assert len(detail["results"]) == 2
    assert detail["results"][0]["caseId"] == "a"
    assert detail["summary"]["failed"] == 1
