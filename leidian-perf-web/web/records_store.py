"""测试记录持久化：各阶段 §11 数据落盘，刷新页面不丢失。"""

from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
WEB_DIR = Path(__file__).resolve().parent
LEGACY_RECORDS_FILE = DATA_DIR / "stage-records.json"
RECORDS_FILE_POSTGRES = DATA_DIR / "stage-records.postgres.json"
RECORDS_FILE_DAMENG = DATA_DIR / "stage-records.dameng.json"
_lock = threading.RLock()

STAGE_CODES = ("S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9")
DIALECT_CODES = ("postgres", "dameng")


def _empty_stage() -> dict[str, Any]:
    return {
        "updatedAt": None,
        "section11_1": {},
        "section11_2": [],
        "section11_3": [],
        "section11_4": [],
        "benchmarkHistory": [],
        "resourceHistory": [],
        "section11_5": [],
        "section11_6": [],
        "section11_7": [],
        "stageConclusion": None,
        "rawChecks": [],
        "rawBreakdown": {},
    }


def _empty_stages() -> dict[str, Any]:
    return {code: _empty_stage() for code in STAGE_CODES}


def _default_doc() -> dict[str, Any]:
    return {
        "version": 2,
        "dialects": {dialect: {"stages": _empty_stages()} for dialect in DIALECT_CODES},
    }


def _normalize_dialect(dialect: str | None) -> str:
    raw = (dialect or "postgres").strip().lower()
    if raw not in DIALECT_CODES:
        raise ValueError(f"unknown dialect: {raw}")
    return raw


def _assert_dialect_match(expected: str, actual: str | None, *, context: str) -> None:
    if actual is None:
        return
    exp = _normalize_dialect(expected)
    got = _normalize_dialect(actual)
    if exp != got:
        raise ValueError(f"{context}: dialect mismatch (expected={exp}, got={got})")


def env_profile_path(dialect: str | None) -> Path:
    """按方言返回环境信息模板路径（PG 与达梦互不共用）。"""
    normalized = _normalize_dialect(dialect)
    specific = WEB_DIR / f"env-profile.{normalized}.json"
    if specific.exists():
        return specific
    if normalized == "postgres":
        legacy = WEB_DIR / "env-profile.json"
        if legacy.exists():
            return legacy
    return specific


def load_env_profile(dialect: str | None = "postgres") -> dict[str, Any]:
    path = env_profile_path(dialect)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _dialect_stages(doc: dict[str, Any], dialect: str | None) -> dict[str, Any]:
    normalized = _normalize_dialect(dialect)
    if "dialects" not in doc:
        doc["dialects"] = {}
    if normalized not in doc["dialects"]:
        doc["dialects"][normalized] = {"stages": _empty_stages()}
    holder = doc["dialects"][normalized]
    if "stages" not in holder:
        holder["stages"] = _empty_stages()
    return holder["stages"]


def _records_file_for_dialect(dialect: str) -> Path:
    normalized = _normalize_dialect(dialect)
    if normalized == "dameng":
        return RECORDS_FILE_DAMENG
    return RECORDS_FILE_POSTGRES


def _doc_for_single_dialect(dialect: str, stages: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 2,
        "dialects": {
            dialect: {"stages": stages},
        },
    }


def _read_single_dialect_doc(path: Path, dialect: str) -> dict[str, Any]:
    normalized = _normalize_dialect(dialect)
    if not path.exists():
        return _doc_for_single_dialect(normalized, _empty_stages())
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _doc_for_single_dialect(normalized, _empty_stages())
    holder = (data.get("dialects") or {}).get(normalized) or {}
    stages = holder.get("stages") or {}
    merged = _empty_stages()
    for code in STAGE_CODES:
        if isinstance(stages.get(code), dict):
            merged[code].update(stages[code])
    return _doc_for_single_dialect(normalized, merged)


def _write_single_dialect_doc(path: Path, dialect: str, doc: dict[str, Any]) -> None:
    normalized = _normalize_dialect(dialect)
    stages = _dialect_stages(doc, normalized)
    single = _doc_for_single_dialect(normalized, stages)
    path.write_text(json.dumps(single, ensure_ascii=False, indent=2), encoding="utf-8")


def load_records() -> dict[str, Any]:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        migrated = False
        data = _default_doc()
        pg_doc = _read_single_dialect_doc(RECORDS_FILE_POSTGRES, "postgres")
        dm_doc = _read_single_dialect_doc(RECORDS_FILE_DAMENG, "dameng")
        data["dialects"]["postgres"]["stages"] = _dialect_stages(pg_doc, "postgres")
        data["dialects"]["dameng"]["stages"] = _dialect_stages(dm_doc, "dameng")

        # 兼容旧版单文件：若新分文件尚不存在，则一次性拆分迁移
        if (
            LEGACY_RECORDS_FILE.exists()
            and (not RECORDS_FILE_POSTGRES.exists() or not RECORDS_FILE_DAMENG.exists())
        ):
            try:
                legacy = json.loads(LEGACY_RECORDS_FILE.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                legacy = {}
            if "stages" in legacy and "dialects" not in legacy:
                data["dialects"]["postgres"]["stages"].update(legacy.get("stages") or {})
                data["legacyTopLevelStages"] = legacy.get("stages") or {}
                migrated = True
            else:
                legacy_dialects = legacy.get("dialects") or {}
                pg_stages = (legacy_dialects.get("postgres") or {}).get("stages") or {}
                dm_stages = (legacy_dialects.get("dameng") or {}).get("stages") or {}
                if pg_stages:
                    data["dialects"]["postgres"]["stages"].update(pg_stages)
                    migrated = True
                if dm_stages:
                    data["dialects"]["dameng"]["stages"].update(dm_stages)
                    migrated = True

        for dialect in DIALECT_CODES:
            _dialect_stages(data, dialect)

        for dialect in DIALECT_CODES:
            stages = _dialect_stages(data, dialect)
            for code in STAGE_CODES:
                stages.setdefault(code, _empty_stage())
                entry = stages[code]
                before_bench = len(entry.get("benchmarkHistory", []))
                _ensure_benchmark_history(entry)
                if len(entry.get("benchmarkHistory", [])) > before_bench:
                    migrated = True
                if _repair_benchmark_history_perf06(entry):
                    migrated = True
                if _repair_benchmark_slow_sql_details(entry):
                    migrated = True
                before_res = len(entry.get("resourceHistory", []))
                _ensure_resource_history(entry)
                if _repair_resource_history_perf06(entry):
                    migrated = True
                if len(entry.get("resourceHistory", [])) > before_res:
                    migrated = True
                entry.setdefault("stageConclusion", None)
                if entry.get("stageConclusion") is None and entry.get("section11_7"):
                    for row in entry["section11_7"]:
                        if row.get("stage") == code:
                            entry["stageConclusion"] = row
                            migrated = True
                            break
        if migrated:
            save_records(data)
        return _apply_env_profile(data)


def _ensure_benchmark_history(entry: dict[str, Any]) -> None:
    """补齐 benchmarkHistory；将旧版仅 section11_4 的数据迁移为一条历史记录。"""
    entry.setdefault("benchmarkHistory", [])
    legacy = entry.get("section11_4") or []
    if entry["benchmarkHistory"] or not legacy:
        return
    decided = [r for r in legacy if r.get("passed") is not None]
    entry["benchmarkHistory"].append(
        {
            "runId": "legacy",
            "runAt": entry.get("updatedAt"),
            "iterations": None,
            "scenarios": [r["id"] for r in legacy if r.get("id")],
            "passed": all(r.get("passed") for r in decided) if decided else None,
            "results": list(legacy),
            "note": "从旧版 section11_4 自动迁移",
        }
    )
    entry.setdefault("legacySnapshots", {})
    entry["legacySnapshots"].setdefault("section11_4", list(legacy))


def save_records(doc: dict[str, Any]) -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _write_single_dialect_doc(RECORDS_FILE_POSTGRES, "postgres", doc)
        _write_single_dialect_doc(RECORDS_FILE_DAMENG, "dameng", doc)


def _merge_section11_1(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    """合并环境信息：非空新值覆盖；不用空字符串冲掉已填项。"""
    out = {**existing}
    for key, val in incoming.items():
        if val is not None and str(val).strip():
            out[key] = val
        elif key not in out:
            out[key] = val
    return out


def _apply_env_profile(doc: dict[str, Any]) -> dict[str, Any]:
    """仅将各方言自己的 env-profile 合并进对应 dialect 分区，禁止跨方言污染。"""
    for dialect in DIALECT_CODES:
        profile = load_env_profile(dialect)
        if not profile:
            continue
        for entry in _dialect_stages(doc, dialect).values():
            entry["section11_1"] = _merge_section11_1(entry.get("section11_1", {}), profile)
    return doc


def _report_section_has_data(section: str, rows: list[dict[str, Any]]) -> bool:
    """报告模板中的 §11.4/5/6 占位行不算有效数据，避免刷新前置检查时冲掉压测/采集结果。"""
    if not rows:
        return False
    if section == "section11_4":
        return any(
            r.get("passed") is not None and str(r.get("avgMs", "")).strip()
            for r in rows
        )
    if section == "section11_5":
        return any(
            str(r.get("cpuAvg", "")).strip() or str(r.get("cpuPeak", "")).strip()
            for r in rows
        )
    if section == "section11_6":
        return any(str(r.get("scene", "")).strip() for r in rows)
    return True


def _is_perf06_sub_id(sid: str) -> bool:
    return sid.startswith("PERF-06-") or sid.startswith("PERF-06·")


def _expand_benchmark_merge_ids(
    sid: str,
    display_by_id: dict[str, dict[str, Any]],
    raw_by_id: dict[str, dict[str, Any]],
) -> list[str]:
    """达梦 PERF-06 存为 PERF-06-count 等子 ID，合并历史时需从 PERF-06 展开。"""
    if sid in display_by_id or sid in raw_by_id:
        return [sid]
    if sid != "PERF-06":
        return []
    keys = set(display_by_id) | set(raw_by_id)
    ordered = [sub for sub in DAMENG_PERF06_SUB_IDS if sub in keys]
    if ordered:
        return ordered
    dotted = [sub for sub in PERF06_RESOURCE_SUB_IDS if sub in keys]
    if dotted:
        return dotted
    return sorted(k for k in keys if _is_perf06_sub_id(k))


def _repair_benchmark_history_perf06(entry: dict[str, Any]) -> bool:
    """从 section11_4 补全历史中缺失的达梦 PERF-06 子场景。"""
    section = {r["id"]: r for r in entry.get("section11_4") or [] if r.get("id")}
    if not section:
        return False
    changed = False
    for run in entry.get("benchmarkHistory") or []:
        scenarios = run.get("scenarios") or []
        if "PERF-06" not in scenarios:
            continue
        results = list(run.get("results") or [])
        result_ids = {r.get("id") for r in results if r.get("id")}
        if any(_is_perf06_sub_id(rid) for rid in result_ids if rid != "PERF-06"):
            continue
        raw_by_id = {r["id"]: r for r in results if r.get("id")}
        merged: list[dict[str, Any]] = []
        for sid in scenarios:
            for expanded in _expand_benchmark_merge_ids(sid, section, raw_by_id):
                if expanded in section or expanded in raw_by_id:
                    merged.append(
                        _merge_benchmark_history_row(
                            section.get(expanded, raw_by_id.get(expanded, {})),
                            raw_by_id.get(expanded),
                        )
                    )
            if sid in section or sid in raw_by_id:
                if sid not in {m.get("id") for m in merged}:
                    merged.append(
                        _merge_benchmark_history_row(
                            section.get(sid, raw_by_id.get(sid, {})),
                            raw_by_id.get(sid),
                        )
                    )
        if not merged:
            continue
        if [r.get("id") for r in merged] != [r.get("id") for r in results]:
            run["results"] = merged
            changed = True
    return changed


def _merge_benchmark_history_row(
    display: dict[str, Any], raw: dict[str, Any] | None
) -> dict[str, Any]:
    """历史记录同时保留采集时间窗字段与表格展示字段。"""
    merged = {**(raw or {}), **display}
    if raw:
        for key in (
            "startedAt",
            "finishedAt",
            "connPeak",
            "slowSqlCount",
            "slowSqlBenchCount",
            "slowSqlDmCount",
            "slowSqlThresholdMs",
            "slowSqlSource",
            "slowSqlDetails",
            "sqlPreview",
            "started_at",
            "finished_at",
            "conn_peak",
            "slow_sql_count",
            "slow_sql_bench_count",
            "slow_sql_dm_count",
            "slow_sql_threshold_ms",
            "slow_sql_source",
            "slow_sql_details",
            "sql_preview",
        ):
            if raw.get(key) is not None:
                merged[key] = raw[key]
    return merged


def _volume_rows_have_actual(rows: list[dict[str, Any]]) -> bool:
    return any(r.get("actual") is not None for r in rows)


def _validation_has_results(groups: list[dict[str, Any]]) -> bool:
    return any(g.get("passed") is not None for g in groups)


def merge_stage_report(stage: str, report: dict[str, Any], dialect: str = "postgres") -> dict[str, Any]:
    """将一次校验/造数报告合并进该档位持久记录（仅写入有效快照，占位模板不覆盖历史）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    normalized = _normalize_dialect(dialect)
    _assert_dialect_match(normalized, report.get("dialect"), context="merge_stage_report")
    doc = load_records()
    stages = _dialect_stages(doc, normalized)
    entry = stages[stage]
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    entry["updatedAt"] = now
    if report.get("section11_1"):
        entry["section11_1"] = _merge_section11_1(entry.get("section11_1", {}), report["section11_1"])
    profile = load_env_profile(normalized)
    if profile:
        entry["section11_1"] = _merge_section11_1(entry.get("section11_1", {}), profile)
    if report.get("section11_2") and _volume_rows_have_actual(report["section11_2"]):
        entry["section11_2"] = report["section11_2"]
    if report.get("rawBreakdown") and _volume_rows_have_actual(report.get("section11_2") or []):
        entry["rawBreakdown"] = report["rawBreakdown"]
    validated = _validation_has_results(report.get("section11_3") or [])
    if report.get("section11_3") and validated:
        entry["section11_3"] = report["section11_3"]
    if report.get("rawChecks") and validated:
        entry["rawChecks"] = report["rawChecks"]
    if report.get("section11_7") and validated:
        entry["section11_7"] = report["section11_7"]
        for row in report["section11_7"]:
            if row.get("stage") == stage:
                entry["stageConclusion"] = row
                break
    if report.get("section11_4") and _report_section_has_data(
        "section11_4", report["section11_4"]
    ):
        entry["section11_4"] = report["section11_4"]
    if report.get("section11_5") and _report_section_has_data(
        "section11_5", report["section11_5"]
    ):
        entry["section11_5"] = report["section11_5"]
    if report.get("section11_6") and _report_section_has_data(
        "section11_6", report["section11_6"]
    ):
        entry["section11_6"] = report["section11_6"]
    save_records(doc)
    return doc


def merge_benchmark_results(
    stage: str,
    section11_4: list[dict[str, Any]],
    dialect: str = "postgres",
) -> dict[str, Any]:
    """更新 section11_4 为各场景最新结果（供报告模板引用）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    existing = {row.get("id"): row for row in entry.get("section11_4", []) if row.get("id")}
    for row in section11_4:
        existing[row["id"]] = row
    entry["section11_4"] = [existing[sid] for sid in sorted(existing.keys())]
    entry["updatedAt"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    save_records(doc)
    return doc


PERF_SCENARIO_IDS_BASE = (
    "PERF-01",
    "PERF-02",
    "PERF-03",
    "PERF-04",
    "PERF-05",
    "PERF-05-AGG",
    "PERF-05-AGG-MV",
    "PERF-05-1MIN",
)
PERF06_SUB_TAGS = ("count", "source_dist", "type_dist")
PERF06_RESOURCE_SUB_IDS = tuple(f"PERF-06·{tag}" for tag in PERF06_SUB_TAGS)
# 达梦压测将 PERF-06 拆为独立子场景 ID（与 PG compound 行不同）
DAMENG_PERF06_SUB_IDS = tuple(f"PERF-06-{tag}" for tag in PERF06_SUB_TAGS)
PERF_SCENARIO_IDS = PERF_SCENARIO_IDS_BASE + PERF06_RESOURCE_SUB_IDS


def _resource_row_has_data(row: dict[str, Any]) -> bool:
    return bool(
        str(row.get("cpuAvg", "")).strip()
        or str(row.get("cpuPeak", "")).strip()
        or str(row.get("memAvg", "")).strip()
    )


def _empty_section11_5_row(sid: str) -> dict[str, Any]:
    return {
        "id": sid,
        "cpuAvg": "",
        "cpuPeak": "",
        "memAvg": "",
        "diskIoWait": "",
        "connPeak": "",
        "slowSqlCount": "",
        "slowSqlBenchCount": "",
        "slowSqlDmCount": "",
        "partitionPrune": "",
        "indexHit": "",
        "note": "压测后一键采集（Prometheus + 慢SQL + EXPLAIN）",
    }


def _order_resource_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {r.get("id"): r for r in rows if r.get("id")}
    ordered: list[str] = []
    for sid in PERF_SCENARIO_IDS_BASE:
        if sid in by_id:
            ordered.append(sid)
    if any(sid in by_id for sid in DAMENG_PERF06_SUB_IDS):
        for sid in DAMENG_PERF06_SUB_IDS:
            if sid in by_id:
                ordered.append(sid)
    elif any(sid in by_id for sid in PERF06_RESOURCE_SUB_IDS):
        for sid in PERF06_RESOURCE_SUB_IDS:
            if sid in by_id:
                ordered.append(sid)
    elif "PERF-06" in by_id:
        ordered.append("PERF-06")
    if not ordered:
        return list(rows)
    return [by_id[sid] for sid in ordered]


def _slow_sql_fields_from_benchmark(raw: dict[str, Any], default_ms: float = 500.0) -> dict[str, Any]:
    threshold = raw.get("slowSqlThresholdMs") or raw.get("slow_sql_threshold_ms") or default_ms
    try:
        threshold = int(float(threshold))
    except (TypeError, ValueError):
        threshold = int(default_ms)

    def _pick(*keys: str, allow_negative: bool = False) -> int | None:
        for key in keys:
            val = raw.get(key)
            if val is None or str(val).strip() == "":
                continue
            try:
                n = int(val)
            except (TypeError, ValueError):
                continue
            if allow_negative or n >= 0:
                return n
        return None

    bench = _pick("slowSqlBenchCount", "slow_sql_bench_count")
    if bench is None:
        bench = _pick("slowSqlCount", "slow_sql_count")
    dm = _pick("slowSqlDmCount", "slow_sql_dm_count", allow_negative=True)
    bench_display = str(bench) if bench is not None and bench >= 0 else "—"
    dm_display = str(dm) if dm is not None and dm >= 0 else "—"
    return {
        "slowSqlBenchCount": bench_display,
        "slowSqlDmCount": dm_display,
        "slowSqlCount": bench_display,
        "slowSqlThresholdMs": threshold,
    }


def _repair_benchmark_slow_sql_details(entry: dict[str, Any]) -> bool:
    """无明细时，用压测记录中的 sqlPreview + max_ms 补样本侧慢 SQL（不连库）。"""
    changed = False
    for run in entry.get("benchmarkHistory") or []:
        for row in run.get("results") or []:
            if row.get("slowSqlDetails") or row.get("slow_sql_details"):
                continue
            bench = row.get("slowSqlBenchCount", row.get("slow_sql_bench_count", row.get("slowSqlCount")))
            try:
                bench_n = int(bench)
            except (TypeError, ValueError):
                bench_n = 0
            if bench_n <= 0:
                continue
            preview = str(row.get("sqlPreview") or row.get("sql_preview") or "").strip()
            if not preview:
                continue
            max_ms = row.get("max_ms", row.get("maxMs"))
            try:
                time_ms = round(float(max_ms), 1) if max_ms is not None else float(
                    row.get("slowSqlThresholdMs") or row.get("slow_sql_threshold_ms") or 500
                )
            except (TypeError, ValueError):
                time_ms = 500.0
            detail = {
                "source": "bench",
                "timeMs": time_ms,
                "sqlText": preview,
                "startTime": "",
            }
            row["slowSqlDetails"] = [detail]
            row["slow_sql_details"] = [detail]
            changed = True
    return changed


def _repair_resource_history_perf06(entry: dict[str, Any]) -> bool:
    """从关联压测轮次补全配套采集中缺失的达梦 PERF-06 子场景行。"""
    benchmark_by_run = {
        r.get("runId"): r for r in entry.get("benchmarkHistory") or [] if r.get("runId")
    }
    if not benchmark_by_run:
        return False
    changed = False
    for collect in entry.get("resourceHistory") or []:
        run_id = collect.get("runId")
        if not run_id:
            continue
        run = benchmark_by_run.get(run_id)
        if not run:
            continue
        bench_by_id = {r.get("id"): r for r in run.get("results") or [] if r.get("id")}
        if not any(sid in bench_by_id for sid in DAMENG_PERF06_SUB_IDS):
            continue
        results = list(collect.get("results") or [])
        present = {r.get("id") for r in results if r.get("id")}
        missing = [sid for sid in DAMENG_PERF06_SUB_IDS if sid in bench_by_id and sid not in present]
        if not missing:
            continue
        for sid in missing:
            raw = bench_by_id[sid]
            slow_fields = _slow_sql_fields_from_benchmark(raw)
            results.append(
                {
                    "id": sid,
                    "cpuAvg": "",
                    "cpuPeak": "",
                    "memAvg": "",
                    "diskIoWait": "",
                    "connPeak": str(raw.get("connPeak") or raw.get("conn_peak") or "—"),
                    **slow_fields,
                    "partitionPrune": "",
                    "indexHit": "",
                    "note": (
                        f"{raw.get('name') or sid} · 已从压测记录补全"
                        "（请重新点「采集资源与执行计划」以获取 Prometheus 指标）"
                    ),
                }
            )
        collect["results"] = _order_resource_rows(results)
        changed = True
    if changed:
        _rebuild_section11_5_from_history(entry)
    return changed


def _ensure_resource_history(entry: dict[str, Any]) -> None:
    """补齐 resourceHistory；将旧版仅 section11_5 的数据迁移为一条历史记录。"""
    entry.setdefault("resourceHistory", [])
    legacy = entry.get("section11_5") or []
    if entry["resourceHistory"] or not any(_resource_row_has_data(r) for r in legacy):
        return
    entry["resourceHistory"].append(
        {
            "collectId": "legacy",
            "collectedAt": entry.get("updatedAt"),
            "runId": None,
            "results": list(legacy),
            "note": "从旧版 section11_5 自动迁移",
        }
    )
    entry.setdefault("legacySnapshots", {})
    entry["legacySnapshots"].setdefault("section11_5", list(legacy))


def _rebuild_section11_5_from_history(entry: dict[str, Any]) -> None:
    """按剩余采集历史中最新一轮重建 section11_5（供报告模板引用）。"""
    history = sorted(
        entry.get("resourceHistory") or [],
        key=lambda r: _parse_run_at_ms(r.get("collectedAt")),
    )
    if not history:
        entry["section11_5"] = [_empty_section11_5_row(sid) for sid in PERF_SCENARIO_IDS]
        return
    entry["section11_5"] = _order_resource_rows(history[-1].get("results") or [])


def append_resource_collect(
    stage: str,
    rows: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    collect_id: str | None = None,
    dialect: str = "postgres",
) -> dict[str, Any]:
    """追加一次资源采集记录（不覆盖历史）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    if not rows:
        return load_records()
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    _ensure_resource_history(entry)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    collect = {
        "collectId": collect_id or uuid.uuid4().hex[:12],
        "collectedAt": now,
        "runId": run_id,
        "results": _order_resource_rows(rows),
    }
    entry.setdefault("resourceHistory", []).append(collect)
    entry["section11_5"] = list(collect["results"])
    entry["updatedAt"] = now
    save_records(doc)
    return doc


def merge_section11_5(
    stage: str,
    rows: list[dict[str, Any]],
    dialect: str = "postgres",
) -> dict[str, Any]:
    """兼容旧调用：转为追加采集历史。"""
    return append_resource_collect(stage, rows, dialect=dialect)


def delete_all_resource_collects(stage: str, dialect: str = "postgres") -> dict[str, Any]:
    """删除当前档位全部资源采集历史（不可恢复）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    entry["resourceHistory"] = []
    _rebuild_section11_5_from_history(entry)
    entry["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_records(doc)
    return doc


def delete_resource_collects(
    stage: str,
    collect_ids: list[str],
    dialect: str = "postgres",
) -> dict[str, Any]:
    """删除指定 collectId 的资源采集历史（整轮删除，不可恢复）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    if not collect_ids:
        raise ValueError("collectIds 不能为空")
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    remove = {cid for cid in collect_ids if cid}
    if not remove:
        raise ValueError("collectIds 无效")
    before = len(entry.get("resourceHistory") or [])
    entry["resourceHistory"] = [
        r
        for r in entry.get("resourceHistory") or []
        if r.get("collectId") not in remove
    ]
    deleted = before - len(entry["resourceHistory"])
    if deleted == 0:
        raise ValueError("未找到要删除的资源采集记录")
    _rebuild_section11_5_from_history(entry)
    entry["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_records(doc)
    return doc


def patch_benchmark_run_results(
    stage: str,
    run_id: str,
    results: list[dict[str, Any]],
    *,
    dialect: str = "postgres",
) -> dict[str, Any]:
    """更新指定压测轮次的 results（如补全慢 SQL 明细）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    normalized = _normalize_dialect(dialect)
    doc = load_records()
    entry = _dialect_stages(doc, normalized)[stage]
    patched = False
    for run in entry.get("benchmarkHistory") or []:
        if run.get("runId") != run_id:
            continue
        run["results"] = list(results)
        patched = True
        break
    if not patched:
        raise ValueError(f"benchmark run not found: {run_id}")
    existing = {row.get("id"): row for row in entry.get("section11_4", []) if row.get("id")}
    for row in results:
        sid = row.get("id")
        if sid:
            existing[sid] = {**existing.get(sid, {}), **row}
    entry["section11_4"] = [existing[sid] for sid in sorted(existing.keys())]
    entry["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_records(doc)
    return doc


def append_benchmark_run(
    stage: str,
    section11_4: list[dict[str, Any]],
    *,
    scenarios: list[str] | None = None,
    iterations: int | None = None,
    write_iterations: int | None = None,
    query_iterations: int | None = None,
    passed: bool | None = None,
    run_id: str | None = None,
    scenario_results: list[dict[str, Any]] | None = None,
    dialect: str = "postgres",
) -> dict[str, Any]:
    """追加一次 SQL 压测记录（不覆盖历史）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    normalized = _normalize_dialect(dialect)
    if not section11_4:
        return load_records()
    doc = load_records()
    stages = _dialect_stages(doc, normalized)
    entry = stages[stage]
    _ensure_benchmark_history(entry)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    display_by_id = {r["id"]: r for r in section11_4 if r.get("id")}
    raw_rows = scenario_results or list(section11_4)
    raw_by_id = {r["id"]: r for r in raw_rows if r.get("id")}
    scenario_ids = scenarios or [r["id"] for r in section11_4 if r.get("id")]
    merged_results: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sid in scenario_ids:
        for expanded in _expand_benchmark_merge_ids(sid, display_by_id, raw_by_id):
            if expanded in seen:
                continue
            if expanded in display_by_id or expanded in raw_by_id:
                merged_results.append(
                    _merge_benchmark_history_row(
                        display_by_id.get(expanded, raw_by_id.get(expanded, {})),
                        raw_by_id.get(expanded),
                    )
                )
                seen.add(expanded)
    if not merged_results:
        merged_results = list(raw_rows)

    run = {
        "runId": run_id or uuid.uuid4().hex[:12],
        "runAt": now,
        "iterations": iterations,
        "writeIterations": write_iterations,
        "queryIterations": query_iterations,
        "scenarios": scenarios or [r["id"] for r in section11_4 if r.get("id")],
        "passed": passed,
        "results": merged_results,
    }
    entry.setdefault("benchmarkHistory", []).append(run)
    existing = {row.get("id"): row for row in entry.get("section11_4", []) if row.get("id")}
    for row in section11_4:
        existing[row["id"]] = row
    entry["section11_4"] = [existing[sid] for sid in sorted(existing.keys())]
    entry["updatedAt"] = now
    save_records(doc)
    return doc


def _parse_run_at_ms(value: Any) -> float:
    if not value:
        return 0.0
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text).timestamp()
    except (TypeError, ValueError):
        return 0.0


def _rebuild_section11_4_from_history(entry: dict[str, Any]) -> None:
    """按剩余历史中各场景最新一次结果重建 section11_4。"""
    history = sorted(
        entry.get("benchmarkHistory") or [],
        key=lambda r: _parse_run_at_ms(r.get("runAt")),
    )
    latest_by_id: dict[str, dict[str, Any]] = {}
    for run in history:
        for row in run.get("results") or []:
            sid = row.get("id")
            if sid:
                latest_by_id[sid] = row
    entry["section11_4"] = [latest_by_id[sid] for sid in sorted(latest_by_id.keys())]


def delete_all_benchmark_runs(stage: str, dialect: str = "postgres") -> dict[str, Any]:
    """删除当前档位全部压测历史（不可恢复）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    entry["benchmarkHistory"] = []
    _rebuild_section11_4_from_history(entry)
    entry["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_records(doc)
    return doc


def delete_benchmark_runs(
    stage: str,
    run_ids: list[str],
    dialect: str = "postgres",
) -> dict[str, Any]:
    """删除指定 runId 的压测历史（整轮删除，不可恢复）。"""
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    if not run_ids:
        raise ValueError("runIds 不能为空")
    doc = load_records()
    stages = _dialect_stages(doc, dialect)
    entry = stages[stage]
    remove = {rid for rid in run_ids if rid}
    if not remove:
        raise ValueError("runIds 无效")
    before = len(entry.get("benchmarkHistory") or [])
    entry["benchmarkHistory"] = [
        r for r in entry.get("benchmarkHistory") or [] if r.get("runId") not in remove
    ]
    deleted = before - len(entry["benchmarkHistory"])
    if deleted == 0:
        raise ValueError("未找到要删除的压测记录")
    _rebuild_section11_4_from_history(entry)
    entry["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    save_records(doc)
    return doc


def patch_stage_section(
    stage: str,
    section: str,
    data: Any,
    dialect: str = "postgres",
) -> dict[str, Any]:
    if stage not in STAGE_CODES:
        raise ValueError(f"unknown stage: {stage}")
    normalized = _normalize_dialect(dialect)
    doc = load_records()
    stages = _dialect_stages(doc, normalized)
    entry = stages[stage]
    entry[section] = data
    entry["updatedAt"] = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    save_records(doc)
    return doc
