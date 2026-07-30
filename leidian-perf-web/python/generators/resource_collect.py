"""压测窗口内 dbserver 资源采集：Prometheus(node_exporter) + PostgreSQL 统计。"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from generators.db import pg_connection


def _shanghai_display_tz() -> timezone:
    """展示用东八区；无 tzdata 时回退 fixed offset，避免拖垮整个 CLI。"""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Shanghai")
    except Exception:  # noqa: BLE001 — ZoneInfoNotFoundError 等
        return timezone(timedelta(hours=8))


_DISPLAY_TZ = _shanghai_display_tz()

PERF_IDS = (
    "PERF-01",
    "PERF-02",
    "PERF-03",
    "PERF-04",
    "PERF-05",
    "PERF-05-AGG",
    "PERF-05-AGG-MV",
    "PERF-05-1MIN",
    "PERF-06",
)
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


def _perf06_sub_id(tag: str) -> str:
    return f"PERF-06·{tag}"


def _dameng_perf06_sub_id(tag: str) -> str:
    return f"PERF-06-{tag}"


def _is_dameng_perf06_sub_id(sid: str) -> bool:
    return sid.startswith("PERF-06-") and sid != "PERF-06"


def _collect_scenario_ids(scenario_results: list[dict[str, Any]]) -> list[str]:
    """压测历史与资源表对齐：仅含本轮实际跑过的场景；PERF-06 展开为三条子 SQL。"""
    by_id = {r.get("id"): r for r in scenario_results if r.get("id")}
    ids: list[str] = [sid for sid in PERF_SCENARIO_IDS_BASE if sid in by_id]
    dameng_subs = [_dameng_perf06_sub_id(tag) for tag in PERF06_SUB_TAGS if _dameng_perf06_sub_id(tag) in by_id]
    if dameng_subs:
        ids.extend(dameng_subs)
        return ids
    raw06 = by_id.get("PERF-06")
    subs = (raw06 or {}).get("subQueries") or (raw06 or {}).get("sub_queries") or {}
    if subs:
        for tag in PERF06_SUB_TAGS:
            if tag in subs:
                ids.append(_perf06_sub_id(tag))
    elif raw06:
        ids.append("PERF-06")
    return ids


def _resolve_collect_source(by_id: dict[str, Any], sid: str) -> dict[str, Any] | None:
    if _is_dameng_perf06_sub_id(sid):
        return by_id.get(sid)
    if sid.startswith("PERF-06·"):
        tag = sid.split("·", 1)[1]
        parent = by_id.get("PERF-06") or {}
        sub = (parent.get("subQueries") or parent.get("sub_queries") or {}).get(tag) or {}
        if not parent and not sub:
            return None
        merged: dict[str, Any] = dict(parent)
        for key in (
            "startedAt",
            "finishedAt",
            "connPeak",
            "slowSqlCount",
            "slowSqlBenchCount",
            "slowSqlDmCount",
            "slowSqlThresholdMs",
            "slowSqlSource",
            "started_at",
            "finished_at",
            "conn_peak",
            "slow_sql_count",
            "slow_sql_bench_count",
            "slow_sql_dm_count",
            "slow_sql_threshold_ms",
            "slow_sql_source",
        ):
            if sub.get(key) is not None:
                merged[key] = sub[key]
        return merged
    return by_id.get(sid)


class ConnPeakSampler:
    """压测过程中轮询 pg_stat_activity，记录连接数峰值。"""

    def __init__(self, dsn: str, database: str, interval_sec: float = 0.5) -> None:
        self._dsn = dsn
        self._database = database
        self._interval = interval_sec
        self.peak = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _poll_once(self) -> None:
        with pg_connection(self._dsn) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname = %s",
                    (self._database,),
                )
                cnt = int(cur.fetchone()[0])
                if cnt > self.peak:
                    self.peak = cnt

    def start(self) -> None:
        def loop() -> None:
            while not self._stop.is_set():
                try:
                    self._poll_once()
                except Exception:
                    pass
                self._stop.wait(self._interval)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self) -> int:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        try:
            self._poll_once()
        except Exception:
            pass
        return self.peak


def _parse_iso_ts(value: str) -> float:
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _format_display_ts(value: str) -> str:
    """与操作台压测历史列一致：zh-CN 本地时间，如 2026/6/11 15:44:47。"""
    dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(_DISPLAY_TZ)
    return f"{local.year}/{local.month}/{local.day} {local.hour:02d}:{local.minute:02d}:{local.second:02d}"


def _http_get_json(url: str, timeout: float = 15.0) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_prometheus(prometheus_url: str, instance: str | None = None) -> dict[str, Any]:
    base = prometheus_url.rstrip("/")
    try:
        up = _http_get_json(f"{base}/api/v1/query?query=up")
        if up.get("status") != "success":
            return {"ok": False, "error": up.get("error", "Prometheus 查询失败")}
        if instance:
            target_q = urllib.parse.quote(
                f'up{{job="dbserver-node",instance="{instance}"}}', safe=""
            )
            target = _http_get_json(f"{base}/api/v1/query?query={target_q}")
            results = target.get("data", {}).get("result", [])
            if not results or float(results[0].get("value", [0, "0"])[1]) < 1:
                return {
                    "ok": False,
                    "error": f"Prometheus 未抓取到 node_exporter（instance={instance}）",
                }
        return {"ok": True, "url": base}
    except urllib.error.URLError as exc:
        return {"ok": False, "error": f"无法连接 Prometheus: {exc}"}


def _query_range_values(
    prometheus_url: str,
    promql: str,
    start_ts: float,
    end_ts: float,
    step: str = "15s",
) -> list[float]:
    base = prometheus_url.rstrip("/")
    params = urllib.parse.urlencode(
        {
            "query": promql,
            "start": str(start_ts),
            "end": str(end_ts),
            "step": step,
        }
    )
    payload = _http_get_json(f"{base}/api/v1/query_range?{params}")
    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error", "Prometheus range 查询失败"))
    values: list[float] = []
    for series in payload.get("data", {}).get("result", []):
        for _, raw in series.get("values", []):
            try:
                val = float(raw)
                if val == val:  # not NaN
                    values.append(val)
            except (TypeError, ValueError):
                continue
    return values


def _stats(values: list[float]) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    return sum(values) / len(values), max(values)


def collect_window_metrics(
    prometheus_url: str,
    instance: str,
    start_ts: float,
    end_ts: float,
) -> dict[str, Any]:
    if end_ts <= start_ts:
        end_ts = start_ts + 1.0
    inst = instance.replace('"', '\\"')
    cpu_q = (
        f'100 - (avg by (instance) (rate(node_cpu_seconds_total{{mode="idle",instance="{inst}"}}[1m])) * 100)'
    )
    mem_q = (
        f'(1 - (node_memory_MemAvailable_bytes{{instance="{inst}"}} / '
        f'node_memory_MemTotal_bytes{{instance="{inst}"}})) * 100'
    )
    io_q = f'rate(node_disk_io_time_seconds_total{{instance="{inst}"}}[1m])'

    cpu_vals = _query_range_values(prometheus_url, cpu_q, start_ts, end_ts)
    mem_vals = _query_range_values(prometheus_url, mem_q, start_ts, end_ts)
    io_vals = _query_range_values(prometheus_url, io_q, start_ts, end_ts)

    cpu_avg, cpu_peak = _stats(cpu_vals)
    mem_avg, _ = _stats(mem_vals)
    io_avg, io_peak = _stats(io_vals)
    return {
        "cpuAvg": cpu_avg,
        "cpuPeak": cpu_peak,
        "memAvg": mem_avg,
        "diskIoWait": io_avg if io_avg is not None else io_peak,
    }


StatSnapshot = dict[int, tuple[int, float, float]]


def reset_pg_stat_statements(dsn: str) -> None:
    """场景开始前清零统计，使后续计数仅覆盖本场景压测窗口。"""
    with pg_connection(dsn) as conn:
        with conn.cursor() as cur:
            # PG 12+ 签名为 (oid, oid, bigint)；全 0 表示清空全部统计
            cur.execute("SELECT pg_stat_statements_reset(0, 0, 0)")
        conn.commit()


def snapshot_pg_stat_statements(dsn: str) -> StatSnapshot:
    """queryid -> (calls, total_exec_time_ms, max_exec_time_ms)。"""
    with pg_connection(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT queryid, calls, total_exec_time, max_exec_time
                FROM pg_stat_statements
                WHERE queryid IS NOT NULL
                """
            )
            return {
                int(row[0]): (int(row[1]), float(row[2]), float(row[3]))
                for row in cur.fetchall()
                if row[0] is not None
            }


def count_slow_sql_delta(
    before: StatSnapshot,
    after: StatSnapshot,
    threshold_ms: float,
) -> int:
    """无 reset 权限时，用场景前后快照差分估算本场景慢 SQL 条数。"""
    slow = 0
    for qid in set(before) | set(after):
        b_calls, b_total, _b_max = before.get(qid, (0, 0.0, 0.0))
        a_calls, a_total, a_max = after.get(qid, (0, 0.0, 0.0))
        delta_calls = a_calls - b_calls
        if delta_calls <= 0:
            continue
        delta_total = a_total - b_total
        window_mean = delta_total / delta_calls
        if window_mean >= threshold_ms or a_max >= threshold_ms:
            slow += 1
    return slow


class ScenarioSlowSqlTracker:
    """每场景慢 SQL：优先 reset；无权限则场景前后快照差分（仅告警一次）。"""

    def __init__(self) -> None:
        self._reset_ok: bool | None = None
        self._warned_reset = False
        self._snapshot: StatSnapshot | None = None

    def begin(self, dsn: str, log: Callable[[str], None] | None = None) -> None:
        emit = log or (lambda _m: None)
        if self._reset_ok is not False:
            try:
                reset_pg_stat_statements(dsn)
                self._reset_ok = True
                self._snapshot = None
                return
            except Exception as exc:
                self._reset_ok = False
                if not self._warned_reset:
                    emit(
                        "  WARN: pg_stat_statements_reset 无权限，已改用场景快照差分统计慢SQL。"
                        "建议在 dbserver 执行: "
                        "sudo -u postgres psql -d leidian_perf -c "
                        "\"GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid, oid, bigint) TO leidian;\""
                        f" — {exc}"
                    )
                    self._warned_reset = True
        self._snapshot = snapshot_pg_stat_statements(dsn)

    def end(
        self,
        dsn: str,
        threshold_ms: float,
        log: Callable[[str], None] | None = None,
    ) -> int:
        emit = log or (lambda _m: None)
        try:
            if self._reset_ok:
                count = count_slow_sql_statements(dsn, threshold_ms)
                mode = "本场景 pg_stat_statements"
            else:
                after = snapshot_pg_stat_statements(dsn)
                count = count_slow_sql_delta(self._snapshot or {}, after, threshold_ms)
                mode = "场景快照差分"
            emit(f"  慢SQL(≥{int(threshold_ms)}ms): {count} 条（{mode}）")
            return count
        except Exception as exc:  # noqa: BLE001
            emit(f"  慢SQL统计失败: {exc}")
            return -1


def count_slow_sql_statements(dsn: str, threshold_ms: float = 500.0) -> int:
    """统计当前 pg_stat_statements 快照中超过阈值的 SQL 条数（需先 reset）。"""
    with pg_connection(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT count(*) FROM pg_stat_statements
                WHERE calls > 0
                  AND (mean_exec_time >= %s OR max_exec_time >= %s)
                """,
                (threshold_ms, threshold_ms),
            )
            row = cur.fetchone()
            return int(row[0]) if row else 0


def _pick_slow_sql_int(raw: dict[str, Any], *keys: str, allow_negative: bool = False) -> int | None:
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


def _resolve_scenario_slow_sql(raw: dict[str, Any], default_threshold_ms: float) -> dict[str, Any]:
    """从压测结果读取场景内慢 SQL 计数（样本 + 库内双口径）。"""
    threshold = raw.get("slowSqlThresholdMs")
    if threshold is None:
        threshold = raw.get("slow_sql_threshold_ms")
    if threshold is None:
        threshold = default_threshold_ms
    threshold = float(threshold)

    bench = _pick_slow_sql_int(raw, "slowSqlBenchCount", "slow_sql_bench_count")
    if bench is None:
        bench = _pick_slow_sql_int(raw, "slowSqlCount", "slow_sql_count")
    dm = _pick_slow_sql_int(raw, "slowSqlDmCount", "slow_sql_dm_count", allow_negative=True)

    bench_display = str(bench) if bench is not None and bench >= 0 else "—"
    dm_display = str(dm) if dm is not None and dm >= 0 else "—"
    return {
        "slowSqlBenchCount": bench_display,
        "slowSqlDmCount": dm_display,
        "slowSqlCount": bench_display,
        "slowSqlThresholdMs": int(threshold),
    }


def _fmt_pct(val: float | None) -> str:
    return f"{val:.1f}%" if val is not None else "—"


def _fmt_float(val: float | None, digits: int = 3) -> str:
    return f"{val:.{digits}f}" if val is not None else "—"


def collect_section11_5_for_run(
    *,
    prometheus_url: str,
    instance: str,
    scenario_results: list[dict[str, Any]],
    dsn: str,
    database: str,
    slow_sql_ms: float = 500.0,
    pad_seconds: float = 5.0,
    schema: str = "perf",
    run_explain: bool = True,
) -> list[dict[str, Any]]:
    """按各场景时间窗从 Prometheus 采集；可选同次 EXPLAIN 分析分区裁剪与索引命中。"""
    health = check_prometheus(prometheus_url, instance)
    if not health.get("ok"):
        raise RuntimeError(health.get("error", "Prometheus 不可用"))

    by_id = {r.get("id"): r for r in scenario_results if r.get("id")}
    rows: list[dict[str, Any]] = []

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
                    "note": "无压测时间窗口，请先执行 SQL 压测",
                }
            )
            continue

        start_ts = _parse_iso_ts(str(raw["startedAt"])) - pad_seconds
        end_ts = _parse_iso_ts(str(raw["finishedAt"])) + pad_seconds
        metrics = collect_window_metrics(prometheus_url, instance, start_ts, end_ts)
        conn = raw.get("connPeak")
        slow_fields = _resolve_scenario_slow_sql(raw, slow_sql_ms)
        threshold = slow_fields["slowSqlThresholdMs"]
        sub_label = ""
        if sid.startswith("PERF-06·"):
            tag = sid.split("·", 1)[1]
            parent = by_id.get("PERF-06") or {}
            subs = parent.get("subQueries") or parent.get("sub_queries") or {}
            sub_label = str((subs.get(tag) or {}).get("label") or tag)
        elif _is_dameng_perf06_sub_id(sid):
            sub_label = str((by_id.get(sid) or {}).get("name") or sid[len("PERF-06-") :])
        note = (
            f"Prometheus {_format_display_ts(str(raw['startedAt']))} ~ "
            f"{_format_display_ts(str(raw['finishedAt']))} (instance={instance})"
            f"；慢SQL≥{int(threshold)}ms（场景内 pg_stat_statements）"
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
                "connPeak": str(conn) if conn is not None else "—",
                **slow_fields,
                "note": note,
            }
        )

    if run_explain:
        from generators.explain_collect import collect_explain_for_run, merge_explain_into_resource_rows

        explain_by_id = collect_explain_for_run(dsn, schema, scenario_results)
        rows = merge_explain_into_resource_rows(rows, explain_by_id)

    return rows


