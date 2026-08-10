"""跑批历史存储。"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from case_store import require_safe_id

TOOL_ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = TOOL_ROOT / "data" / "runs"


def list_runs() -> list[dict[str, Any]]:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for f in sorted(RUNS_DIR.glob("*.json"), reverse=True):
        data = json.loads(f.read_text(encoding="utf-8"))
        rows.append(
            {
                "id": data.get("id") or f.stem,
                "startedAt": data.get("startedAt"),
                "finishedAt": data.get("finishedAt"),
                "summary": data.get("summary") or {},
                "file": f.name,
            }
        )
    return rows


def get_run(run_id: str) -> dict[str, Any]:
    run_id = require_safe_id(run_id, "run id")
    base = RUNS_DIR.resolve()
    path = (RUNS_DIR / f"{run_id}.json").resolve()
    if not path.is_relative_to(base):
        raise ValueError("非法 run id")
    if not path.exists():
        raise FileNotFoundError(run_id)
    return json.loads(path.read_text(encoding="utf-8"))


def save_run(results: list[dict[str, Any]], started_at: str | None = None) -> dict[str, Any]:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    passed = sum(1 for r in results if r.get("status") == "passed")
    failed = sum(1 for r in results if r.get("status") == "failed")
    skipped = sum(1 for r in results if r.get("status") == "skipped")
    payload = {
        "id": run_id,
        "startedAt": started_at or datetime.now(timezone.utc).isoformat(),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "summary": {"total": len(results), "passed": passed, "failed": failed, "skipped": skipped},
        "results": results,
    }
    (RUNS_DIR / f"{run_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload
