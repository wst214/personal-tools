"""达梦压测资源采集：Prometheus 复用 + 达梦会话峰值；与 PostgreSQL 资源_collect 隔离。"""

from __future__ import annotations

from typing import Any

from generators.dameng_conn import DamengConn
from generators.dameng_db import fetch_active_session_count_dameng
from generators.dameng_explain_collect import (
    collect_explain_for_run_dameng,
    merge_explain_into_resource_rows_dameng,
)
from generators.resource_collect import (
    _collect_scenario_ids,
    _format_display_ts,
    _fmt_float,
    _fmt_pct,
    _is_dameng_perf06_sub_id,
    _parse_iso_ts,
    _resolve_collect_source,
    _resolve_scenario_slow_sql,
    check_prometheus,
    collect_window_metrics,
)


def collect_section11_5_for_run_dameng(
    *,
    prometheus_url: str,
    instance: str,
    scenario_results: list[dict[str, Any]],
    conn: DamengConn,
    slow_sql_ms: float = 500,
    pad_seconds: float = 5.0,
    run_explain: bool = True,
) -> list[dict[str, Any]]:
    health = check_prometheus(prometheus_url, instance)
    if not health.get("ok"):
        raise RuntimeError(health.get("error", "Prometheus 不可用"))

    by_id = {r.get("id"): r for r in scenario_results if r.get("id")}
    rows: list[dict[str, Any]] = []
    session_peak = fetch_active_session_count_dameng(conn)

    for sid in _collect_scenario_ids(scenario_results):
        raw = _resolve_collect_source(by_id, sid)
        if not raw or not raw.get("startedAt") or not raw.get("finishedAt"):
            rows.append(
                {
                    "id": sid,
                    "cpuAvg": "",
                    "cpuPeak": "",
                    "memAvg": "",
                    "diskIoWait": "",
                    "connPeak": "",
                    "slowSqlCount": "",
                    "partitionPrune": "",
                    "indexHit": "",
                    "note": "无压测时间窗口，请先执行 SQL 压测",
                }
            )
            continue

        start_ts = _parse_iso_ts(str(raw["startedAt"])) - pad_seconds
        end_ts = _parse_iso_ts(str(raw["finishedAt"])) + pad_seconds
        metrics = collect_window_metrics(prometheus_url, instance, start_ts, end_ts)
        conn_peak = raw.get("connPeak") or session_peak
        slow_fields = _resolve_scenario_slow_sql(raw, slow_sql_ms)
        threshold = slow_fields["slowSqlThresholdMs"]
        slow_source = raw.get("slowSqlSource") or raw.get("slow_sql_source") or ""
        slow_label = {
            "bench+dm": "样本+库内",
            "v$sql_history": "V$SQL_HISTORY 场景窗口",
            "bench_latency": "压测样本",
            "bench_latency_fallback": "压测样本兜底",
        }.get(str(slow_source), "压测样本")
        sub_label = ""
        if _is_dameng_perf06_sub_id(sid):
            sub_label = str(raw.get("name") or sid[len("PERF-06-") :])
        note = (
            f"Prometheus {_format_display_ts(str(raw['startedAt']))} ~ "
            f"{_format_display_ts(str(raw['finishedAt']))} (instance={instance})"
            f"；慢SQL≥{int(threshold)}ms（{slow_label}）"
        )
        if sub_label:
            note = f"{sub_label} · {note}"
        rows.append(
            {
                "id": sid,
                "cpuAvg": _fmt_pct(metrics.get("cpuAvg")),
                "cpuPeak": _fmt_pct(metrics.get("cpuPeak")),
                "memAvg": _fmt_pct(metrics.get("memAvg")),
                "diskIoWait": _fmt_float(metrics.get("diskIoWait")),
                "connPeak": str(conn_peak) if conn_peak is not None else "—",
                **slow_fields,
                "partitionPrune": "",
                "indexHit": "",
                "note": note,
            }
        )

    if run_explain:
        explain_by_id = collect_explain_for_run_dameng(conn, scenario_results)
        rows = merge_explain_into_resource_rows_dameng(rows, explain_by_id)

    return rows
