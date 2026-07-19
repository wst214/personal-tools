"""CLI 压测结果写入 stage-records，并可推送到 perf-web 页面。"""

from __future__ import annotations

import json
import sys
import uuid
from pathlib import Path
from typing import Any
from urllib import error, request

import yaml

_TOOL_ROOT = Path(__file__).resolve().parent.parent.parent


def _import_records_store():
    web_dir = _TOOL_ROOT / "web"
    if str(web_dir) not in sys.path:
        sys.path.insert(0, str(web_dir))
    import records_store

    return records_store


def resolve_benchmark_iteration_fields(
    scenarios: list[str] | None,
    iterations: int | None,
    config_dir: Path,
) -> tuple[int | None, int | None, int | None]:
    """按场景 read/write 类型拆分 iterations / writeIterations / queryIterations。"""
    if iterations is None:
        return None, None, None
    scenario_ids = [s for s in (scenarios or []) if s]
    if not scenario_ids:
        return iterations, None, None

    cfg_path = config_dir / "sql-bench.yaml"
    with cfg_path.open(encoding="utf-8") as f:
        meta = (yaml.safe_load(f) or {}).get("scenarios") or {}

    kinds = {sid: (meta.get(sid) or {}).get("kind") for sid in scenario_ids}
    has_write = any(k == "write" for k in kinds.values())
    has_read = any(k == "read" or sid == "PERF-06" for sid, k in kinds.items())

    if has_write and not has_read:
        return iterations, iterations, None
    if has_read and not has_write:
        return iterations, None, iterations
    return iterations, None, None


def append_benchmark_to_store(
    result: dict[str, Any],
    *,
    dialect: str,
    scenarios: list[str] | None,
    iterations: int | None,
    config_dir: Path,
    run_id: str | None = None,
) -> dict[str, Any]:
    section11_4 = result.get("section11_4") or []
    if not section11_4:
        raise ValueError("benchmark result has no section11_4; nothing to save")

    records_store = _import_records_store()
    stage = str(result.get("stage") or "")
    bench_iterations, write_iterations, query_iterations = resolve_benchmark_iteration_fields(
        scenarios, iterations, config_dir
    )
    return records_store.append_benchmark_run(
        stage,
        section11_4,
        scenarios=scenarios,
        iterations=bench_iterations,
        write_iterations=write_iterations,
        query_iterations=query_iterations,
        passed=result.get("passed"),
        run_id=run_id or uuid.uuid4().hex[:12],
        scenario_results=result.get("results"),
        dialect=dialect,
    )


def push_benchmark_to_web(base_url: str, payload: dict[str, Any]) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/api/records/benchmark"
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"push failed HTTP {exc.code}: {detail}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"push failed: {exc.reason}") from exc


def build_push_payload(
    result: dict[str, Any],
    *,
    dialect: str,
    scenarios: list[str] | None,
    iterations: int | None,
    config_dir: Path,
    run_id: str | None = None,
) -> dict[str, Any]:
    bench_iterations, write_iterations, query_iterations = resolve_benchmark_iteration_fields(
        scenarios, iterations, config_dir
    )
    payload: dict[str, Any] = {
        "stage": result.get("stage"),
        "dialect": dialect,
        "scenarios": scenarios,
        "passed": result.get("passed"),
        "section11_4": result.get("section11_4") or [],
        "results": result.get("results"),
        "runId": run_id,
    }
    if bench_iterations is not None:
        payload["iterations"] = bench_iterations
    if write_iterations is not None:
        payload["writeIterations"] = write_iterations
    if query_iterations is not None:
        payload["queryIterations"] = query_iterations
    return payload


def persist_benchmark_result(
    result: dict[str, Any],
    *,
    dialect: str,
    scenarios: list[str] | None,
    iterations: int | None,
    config_dir: Path,
    save_records: bool = False,
    push_url: str | None = None,
    run_id: str | None = None,
    log=print,
) -> str | None:
    """本地落盘（可选）并推送到 perf-web（可选）。返回 runId。"""
    rid = run_id or uuid.uuid4().hex[:12]
    if not result.get("section11_4"):
        log("WARN: 无 section11_4，跳过记录保存/推送", flush=True)
        return None

    if save_records:
        append_benchmark_to_store(
            result,
            dialect=dialect,
            scenarios=scenarios,
            iterations=iterations,
            config_dir=config_dir,
            run_id=rid,
        )
        records_file = _TOOL_ROOT / "data" / f"stage-records.{dialect}.json"
        log(f"已写入压测记录: {records_file}", flush=True)

    if push_url:
        payload = build_push_payload(
            result,
            dialect=dialect,
            scenarios=scenarios,
            iterations=iterations,
            config_dir=config_dir,
            run_id=rid,
        )
        resp = push_benchmark_to_web(push_url, payload)
        pushed_id = resp.get("runId") or rid
        log(f"已推送到 perf-web ({push_url})，runId={pushed_id}", flush=True)
        return pushed_id

    return rid
