"""达梦 DM8 EXPLAIN 分析：索引命中与分区裁剪（文本计划解析）。"""

from __future__ import annotations

import re
from typing import Any

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_load_guard import assert_no_load_in_progress
from generators.dameng_sql_bench import (
    PERF06_SUB_BUILDERS,
    SQL_BUILDERS,
    resolve_context_dameng,
)
from generators.explain_collect import merge_explain_into_resource_rows
from generators.resource_collect import _collect_scenario_ids, _is_dameng_perf06_sub_id

_WRITE_SCENARIOS = frozenset({"PERF-01", "PERF-02", "PERF-03"})

_FACT_TABLE_HINTS = (
    "biz_atmosphere_electric_field_event",
    "biz_lightning_event",
    "standard_atmosphere_electric_field",
    "raw_kafka_message",
)

_INDEX_OP_RE = re.compile(r"\b(SSEK2?|CSEK2?|GSEK2?|SSCN2?|BLKUP2?)\b", re.IGNORECASE)
_FULL_SCAN_RE = re.compile(r"\bCSCN2?\b", re.IGNORECASE)
_PARTITION_NAME_RE = re.compile(r"_Y(20\d{2})M(0[1-9]|1[0-2])\b", re.IGNORECASE)
_SCAN_RANGE_RE = re.compile(r"scan_range\s*\[([^\]]+)\]", re.IGNORECASE)


def _is_fact_table(name: str) -> bool:
    low = name.lower()
    return any(h in low for h in _FACT_TABLE_HINTS)


def _resolve_builder(sid: str):
    if _is_dameng_perf06_sub_id(sid):
        return PERF06_SUB_BUILDERS.get(sid[len("PERF-06-") :])
    if sid.startswith("PERF-06·"):
        return PERF06_SUB_BUILDERS.get(sid.split("·", 1)[1])
    base = sid.split("·", 1)[0]
    return SQL_BUILDERS.get(base)


def _parse_explain_text_dm(plan_text: str) -> dict[str, str]:
    text = plan_text or ""
    low = text.lower()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    has_index = bool(_INDEX_OP_RE.search(text))
    has_full = bool(_FULL_SCAN_RE.search(text))
    fact_full = has_full and any(h in low for h in _FACT_TABLE_HINTS)
    fact_index = has_index and any(h in low for h in _FACT_TABLE_HINTS)

    partition_names = set(_PARTITION_NAME_RE.findall(text))
    scan_ranges = _SCAN_RANGE_RE.findall(text)
    narrowed_range = any(
        rng.strip() and rng.strip().lower() not in ("nil", "null", "*", "")
        for rng in scan_ranges
    )

    if len(partition_names) == 1:
        partition_prune = "是"
    elif len(partition_names) > 1:
        partition_prune = "未见裁剪"
    elif narrowed_range:
        partition_prune = "是"
    elif fact_full and not fact_index:
        partition_prune = "未见裁剪"
    else:
        partition_prune = "—"

    if fact_index and fact_full:
        index_hit = "部分"
    elif fact_index or has_index:
        index_hit = "是"
    elif fact_full:
        index_hit = "否"
    elif has_full:
        index_hit = "未见索引"
    else:
        index_hit = "—"

    scan_bits: list[str] = []
    for line in lines:
        if _INDEX_OP_RE.search(line) or _FULL_SCAN_RE.search(line) or "SLCT" in line.upper():
            compact = re.sub(r"\s+", " ", line)
            scan_bits.append(compact[:140])
    explain_note = "; ".join(scan_bits[:6]) if scan_bits else "无扫描节点"

    return {
        "partitionPrune": partition_prune,
        "indexHit": index_hit,
        "explainNote": explain_note,
    }


def _strip_sql_line_comments(sql: str) -> str:
    """去掉整行 -- 注释（含预览头 -- perf06_geo_mode=...），避免 EXPLAIN FOR 单行化后整句被注释掉。"""
    lines: list[str] = []
    for line in (sql or "").splitlines():
        if line.lstrip().startswith("--"):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def _prepare_explain_sql_dameng(sql: str) -> tuple[str, str]:
    """
    准备可 EXPLAIN FOR 的单句 SQL，并附带备注。
    两段式只分析第 1 段 bbox 候选扫描（INSERT…SELECT 中的 SELECT）；
    第 2 段 JOIN+ST_DWithin 在备注中说明。
    """
    note = ""
    raw = sql or ""
    if "--__PERF06_TWO_PHASE__" in raw or "perf06_cand_rowid" in raw.lower():
        note = "two-phase GTT: EXPLAIN phase1(bbox→ROWID); phase2=JOIN+ST_DWithin"
        phase1 = raw.split("--__PERF06_TWO_PHASE__", 1)[0]
        phase1 = _strip_sql_line_comments(phase1)
        # INSERT INTO gtt SELECT … → 只 EXPLAIN SELECT，才能看到索引
        m = re.search(r"\bSELECT\b", phase1, re.IGNORECASE)
        if m:
            return phase1[m.start() :].strip(), note
        return phase1, note
    return _strip_sql_line_comments(raw), note


def _explain_one_dameng(conn: DamengConn, sql: str) -> dict[str, str]:
    explain_sql, phase2_note = _prepare_explain_sql_dameng(sql)
    cleaned = " ".join(explain_sql.split())
    if not cleaned:
        return {
            "partitionPrune": "—",
            "indexHit": "—",
            "explainNote": "空 SQL",
        }
    try:
        # dmPython 下 plain EXPLAIN 报 -2002；达梦需 EXPLAIN FOR
        db = connect_dm_with_retry(conn)
        try:
            cur = setup_dm_bench_session(db, conn, read_only=True)
            try:
                cur.execute(f"EXPLAIN FOR {cleaned}")
                rows = cur.fetchall()
            finally:
                cur.close()
        finally:
            db.close()
        lines: list[str] = []
        for row in rows or []:
            if not row:
                continue
            parts = [str(col).strip() for col in row if col is not None and str(col).strip()]
            if parts:
                lines.append(" ".join(parts))
        if not lines:
            return {
                "partitionPrune": "失败",
                "indexHit": "失败",
                "explainNote": "EXPLAIN 无结果",
            }
        parsed = _parse_explain_text_dm("\n".join(lines))
        if phase2_note:
            note = parsed.get("explainNote") or ""
            parsed["explainNote"] = f"{phase2_note}; {note}" if note else phase2_note
        return parsed
    except Exception as exc:  # noqa: BLE001
        return {
            "partitionPrune": "失败",
            "indexHit": "失败",
            "explainNote": str(exc)[:200],
        }


def _base_scenario_id(sid: str) -> str:
    if _is_dameng_perf06_sub_id(sid) or sid.startswith("PERF-06·"):
        return "PERF-06"
    return sid.split("·", 1)[0]


def _infer_perf06_geo_mode(scenario_results: list[dict[str, Any]]) -> str | None:
    """从压测结果 SQL 预览推断本轮 PERF-06 空间模式（与页面/环境变量一致）。"""
    for raw in scenario_results:
        preview = str(raw.get("sqlPreview") or raw.get("sql_preview") or "")
        if not preview:
            continue
        if (
            "--__PERF06_TWO_PHASE__" in preview
            or "perf06_cand_rowid" in preview.lower()
            or "__CAND_IDS__" in preview
        ):
            return "bbox_then_dwithin"
        # bbox_geog：lon/lat BETWEEN + Haversine（ASIN），无 ST_DWithin
        if "BETWEEN" in preview.upper() and "ASIN" in preview.upper():
            return "bbox_geog"
        if "ST_DWithin" in preview or "ST_GeomToGeog" in preview:
            return "geog_only"
    return None


def _sql_from_scenario_result(raw: dict[str, Any] | None) -> str:
    if not raw:
        return ""
    return str(raw.get("sqlPreview") or raw.get("sql_preview") or "").strip()


def collect_explain_for_run_dameng(
    conn: DamengConn,
    scenario_results: list[dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """按场景 id 返回达梦 EXPLAIN 摘要（PERF-06 按子 SQL）。"""
    assert_no_load_in_progress(conn, "执行 EXPLAIN 分析")
    selected = [
        _base_scenario_id(str(r.get("id") or ""))
        for r in scenario_results
        if r.get("id")
    ]
    ctx = resolve_context_dameng(conn, scenarios=selected or None)
    geo_mode = _infer_perf06_geo_mode(scenario_results)
    if geo_mode:
        ctx.perf06_geo_mode = geo_mode
    by_id = {str(r.get("id")): r for r in scenario_results if r.get("id")}
    out: dict[str, dict[str, str]] = {}

    for sid in _collect_scenario_ids(scenario_results):
        base_sid = _base_scenario_id(sid)
        if base_sid in _WRITE_SCENARIOS:
            out[sid] = {
                "partitionPrune": "—",
                "indexHit": "—",
                "explainNote": "写入场景不分析",
            }
            continue

        # 优先使用压测当时 SQL，避免默认 geog_only 与 bbox 轮次不一致
        sql = _sql_from_scenario_result(by_id.get(sid))
        if not sql:
            builder = _resolve_builder(sid)
            if not builder:
                out[sid] = {
                    "partitionPrune": "—",
                    "indexHit": "—",
                    "explainNote": "无 SQL 构建器",
                }
                continue
            sql = builder(ctx, 0, 0).strip()

        out[sid] = _explain_one_dameng(conn, sql)

    return out


def merge_explain_into_resource_rows_dameng(
    rows: list[dict[str, Any]],
    explain_by_id: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    return merge_explain_into_resource_rows(rows, explain_by_id)
