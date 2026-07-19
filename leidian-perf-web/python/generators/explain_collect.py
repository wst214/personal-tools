"""压测后 EXPLAIN 分析：分区裁剪与索引命中（与 Prometheus 采集同次触发）。"""

from __future__ import annotations

import json
from typing import Any, Iterable

from generators.db import pg_connection
from generators.resource_collect import _collect_scenario_ids

# 关注的大表（出现 Seq Scan 时标记索引未命中）
_FACT_TABLE_HINTS = (
    "biz_atmosphere_electric_field_event",
    "biz_lightning_event",
    "standard_atmosphere_electric_field",
    "raw_kafka_message",
)

_WRITE_SCENARIOS = frozenset({"PERF-01", "PERF-02", "PERF-03"})

_INDEX_NODE_TYPES = frozenset(
    {
        "Index Scan",
        "Index Only Scan",
        "Bitmap Index Scan",
        "Bitmap Heap Scan",
    }
)


def _iter_plan_nodes(node: dict[str, Any]) -> Iterable[dict[str, Any]]:
    if not isinstance(node, dict):
        return
    yield node
    for child in node.get("Plans") or []:
        yield from _iter_plan_nodes(child)


def _is_fact_table(rel: str | None) -> bool:
    if not rel:
        return False
    low = rel.lower()
    return any(h in low for h in _FACT_TABLE_HINTS)


def _parse_explain_json(payload: Any) -> dict[str, str]:
    plan_root: dict[str, Any] = {}
    if isinstance(payload, list) and payload:
        plan_root = payload[0] if isinstance(payload[0], dict) else {}
    elif isinstance(payload, dict):
        plan_root = payload

    plan = plan_root.get("Plan") or {}
    nodes = list(_iter_plan_nodes(plan))
    node_types = [str(n.get("Node Type") or "") for n in nodes]
    raw_text = json.dumps(plan_root, ensure_ascii=False).lower()

    has_prune = "partition prune" in raw_text or "partitions pruned" in raw_text
    has_append = any(t == "Append" for t in node_types)
    has_index = any(t in _INDEX_NODE_TYPES for t in node_types)
    fact_seq = [
        n
        for n in nodes
        if n.get("Node Type") == "Seq Scan" and _is_fact_table(n.get("Relation Name"))
    ]

    if has_prune:
        partition_prune = "是"
    elif has_append:
        partition_prune = "未见裁剪"
    else:
        partition_prune = "—"

    if has_index and fact_seq:
        index_hit = "部分"
    elif has_index:
        index_hit = "是"
    elif fact_seq:
        index_hit = "否"
    elif any(t == "Seq Scan" for t in node_types):
        index_hit = "未见索引"
    else:
        index_hit = "—"

    scan_bits: list[str] = []
    for n in nodes:
        nt = n.get("Node Type")
        if not nt or "Scan" not in str(nt):
            continue
        rel = n.get("Relation Name") or n.get("Alias") or ""
        if rel:
            scan_bits.append(f"{nt}({rel})")
        else:
            scan_bits.append(str(nt))
    explain_note = "; ".join(scan_bits[:6]) if scan_bits else "无扫描节点"

    return {
        "partitionPrune": partition_prune,
        "indexHit": index_hit,
        "explainNote": explain_note,
    }


def _explain_one(dsn: str, schema: str, sql: str, params: tuple[Any, ...]) -> dict[str, str]:
    try:
        with pg_connection(dsn, schema=schema) as conn:
            with conn.cursor() as cur:
                cur.execute("SET search_path TO %s, public", (schema,))
                cur.execute(f"EXPLAIN (FORMAT JSON) {sql}", params)
                row = cur.fetchone()
        if not row or not row[0]:
            return {
                "partitionPrune": "失败",
                "indexHit": "失败",
                "explainNote": "EXPLAIN 无结果",
            }
        return _parse_explain_json(row[0])
    except Exception as exc:  # noqa: BLE001
        return {
            "partitionPrune": "失败",
            "indexHit": "失败",
            "explainNote": str(exc)[:200],
        }


def collect_explain_for_run(
    dsn: str,
    schema: str,
    scenario_results: list[dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """按场景 id 返回 EXPLAIN 摘要（PERF-06 按子 SQL 分项）。"""
    from generators.load_guard import assert_no_load_in_progress
    from generators.sql_bench import PERF06_SUB_BUILDERS, SQL_BUILDERS, resolve_context

    assert_no_load_in_progress(dsn, "执行 EXPLAIN 分析")

    ctx = resolve_context(dsn, schema=schema)
    out: dict[str, dict[str, str]] = {}

    for sid in _collect_scenario_ids(scenario_results):
        base_sid = sid.split("·", 1)[0]
        if base_sid in _WRITE_SCENARIOS:
            out[sid] = {
                "partitionPrune": "—",
                "indexHit": "—",
                "explainNote": "写入场景不分析",
            }
            continue

        if sid.startswith("PERF-06·"):
            tag = sid.split("·", 1)[1]
            builder = PERF06_SUB_BUILDERS.get(tag)
        elif base_sid in SQL_BUILDERS:
            builder = SQL_BUILDERS[base_sid]
        else:
            continue

        if not builder:
            out[sid] = {
                "partitionPrune": "—",
                "indexHit": "—",
                "explainNote": "无 SQL 构建器",
            }
            continue

        sql, params = builder(ctx, 0, 0)
        out[sid] = _explain_one(dsn, schema, sql, params)

    return out


def merge_explain_into_resource_rows(
    rows: list[dict[str, Any]],
    explain_by_id: dict[str, dict[str, str]],
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for row in rows:
        sid = str(row.get("id") or "")
        exp = explain_by_id.get(sid) or {}
        note = str(row.get("note") or "")
        explain_note = exp.get("explainNote")
        if explain_note and explain_note not in note:
            note = f"{note} · EXPLAIN: {explain_note}" if note else f"EXPLAIN: {explain_note}"
        merged.append(
            {
                **row,
                "partitionPrune": exp.get("partitionPrune", row.get("partitionPrune", "—")),
                "indexHit": exp.get("indexHit", row.get("indexHit", "—")),
                "note": note,
            }
        )
    return merged
