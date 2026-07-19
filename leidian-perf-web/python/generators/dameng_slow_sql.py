"""达梦 DM8 场景窗口慢 SQL 统计（V$SQL_HISTORY）；与 PostgreSQL pg_stat_statements 隔离。"""



from __future__ import annotations



from datetime import datetime, timedelta

from typing import Any, Callable



from generators.dameng_conn import DamengConn

from generators.dameng_db import dm_fetch_scalar





def _parse_iso_ts(text: str) -> datetime:

    return datetime.fromisoformat(str(text).replace("Z", "+00:00"))





def _fmt_dm_ts(dt: datetime) -> str:

    """达梦 TO_TIMESTAMP 用本地无时区字符串。"""

    if dt.tzinfo is not None:

        dt = dt.astimezone().replace(tzinfo=None)

    return dt.strftime("%Y-%m-%d %H:%M:%S")





def _monitor_enabled(conn: DamengConn) -> bool:

    try:

        val = dm_fetch_scalar(

            conn,

            """

            SELECT COUNT(*) FROM V$DM_INI

            WHERE UPPER(PARA_NAME) = 'ENABLE_MONITOR'

              AND UPPER(TRIM(PARA_VALUE)) IN ('1', 'TRUE', 'ON', 'YES')

            """,

        )

        if val > 0:

            return True

    except Exception:

        pass

    try:

        val = dm_fetch_scalar(conn, "SELECT COUNT(*) FROM V$SQL_HISTORY WHERE ROWNUM = 1")

        return val >= 0

    except Exception:

        return False





def count_slow_sql_history_window(

    conn: DamengConn,

    started_at: str,

    finished_at: str,

    threshold_ms: float,

    *,

    pad_seconds: int = 1,

) -> int:

    """统计场景时间窗内 TIME_USED >= 阈值的 SQL 条数（达梦 V$SQL_HISTORY；TIME_USED 单位为微秒）。"""

    start_dt = _parse_iso_ts(started_at) - timedelta(seconds=pad_seconds)

    end_dt = _parse_iso_ts(finished_at) + timedelta(seconds=pad_seconds)

    start_s = _fmt_dm_ts(start_dt)

    end_s = _fmt_dm_ts(end_dt)

    threshold_us = int(max(float(threshold_ms), 0.0) * 1000)

    sql = f"""

    SELECT COUNT(*) FROM V$SQL_HISTORY

    WHERE START_TIME >= TO_TIMESTAMP('{start_s}', 'YYYY-MM-DD HH24:MI:SS')

      AND START_TIME <= TO_TIMESTAMP('{end_s}', 'YYYY-MM-DD HH24:MI:SS')

      AND TIME_USED >= {threshold_us}

    """

    return dm_fetch_scalar(conn, sql)





def count_slow_sql_from_latencies(latencies: list[float], threshold_ms: float) -> int:

    """压测客户端样本超阈值次数。"""

    threshold = float(threshold_ms)

    return sum(1 for v in latencies if v >= threshold)


def _truncate_sql(text: str, limit: int = 2000) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def build_bench_slow_samples(
    latencies: list[float],
    threshold_ms: float,
    sql_preview: str,
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """压测客户端超阈样本明细（含场景 SQL 文本）。"""
    threshold = float(threshold_ms)
    slow_vals = sorted((v for v in latencies if v >= threshold), reverse=True)[:limit]
    preview = _truncate_sql(sql_preview)
    return [
        {
            "source": "bench",
            "timeMs": round(float(ms), 1),
            "sqlText": preview,
            "startTime": "",
        }
        for ms in slow_vals
    ]


def list_slow_sql_history_window(
    conn: DamengConn,
    started_at: str,
    finished_at: str,
    threshold_ms: float,
    *,
    pad_seconds: int = 1,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """场景时间窗内库内慢 SQL 明细（V$SQL_HISTORY；TIME_USED 微秒）。"""
    from generators.dameng_db import dm_fetch_all

    start_dt = _parse_iso_ts(started_at) - timedelta(seconds=pad_seconds)
    end_dt = _parse_iso_ts(finished_at) + timedelta(seconds=pad_seconds)
    start_s = _fmt_dm_ts(start_dt)
    end_s = _fmt_dm_ts(end_dt)
    threshold_us = int(max(float(threshold_ms), 0.0) * 1000)
    safe_limit = max(1, min(int(limit), 50))
    sql = f"""
    SELECT TOP {safe_limit}
           TOP_SQL_TEXT, TIME_USED, START_TIME
    FROM V$SQL_HISTORY
    WHERE START_TIME >= TO_TIMESTAMP('{start_s}', 'YYYY-MM-DD HH24:MI:SS')
      AND START_TIME <= TO_TIMESTAMP('{end_s}', 'YYYY-MM-DD HH24:MI:SS')
      AND TIME_USED >= {threshold_us}
    ORDER BY TIME_USED DESC
    """
    rows: list[dict[str, Any]] = []
    for top_sql_text, time_used, start_time in dm_fetch_all(conn, sql):
        try:
            time_ms = round(int(time_used) / 1000.0, 1)
        except (TypeError, ValueError):
            time_ms = 0.0
        rows.append(
            {
                "source": "dm",
                "timeMs": time_ms,
                "sqlText": _truncate_sql(str(top_sql_text or "")),
                "startTime": str(start_time or ""),
            }
        )
    return rows


def collect_scenario_slow_sql_details(
    conn: DamengConn,
    *,
    started_at: str,
    finished_at: str,
    latencies: list[float] | None,
    threshold_ms: float,
    sql_preview: str = "",
    bench_count: int | None = None,
    max_ms: float | None = None,
    log: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    """合并压测样本与库内慢 SQL 明细。"""
    emit = log or (lambda _m: None)
    details: list[dict[str, Any]] = []
    if latencies:
        details.extend(build_bench_slow_samples(latencies, threshold_ms, sql_preview))
    elif bench_count and bench_count > 0 and sql_preview:
        fallback_ms = float(max_ms) if max_ms and max_ms >= float(threshold_ms) else float(threshold_ms)
        details.append(
            {
                "source": "bench",
                "timeMs": round(fallback_ms, 1),
                "sqlText": _truncate_sql(sql_preview),
                "startTime": "",
            }
        )

    if _monitor_enabled(conn):
        try:
            dm_rows = list_slow_sql_history_window(
                conn,
                started_at,
                finished_at,
                threshold_ms,
            )
            details.extend(dm_rows)
            if dm_rows:
                emit(f"  慢SQL明细: 样本 {len(details) - len(dm_rows)} 条 + 库内 {len(dm_rows)} 条")
            elif details:
                emit(f"  慢SQL明细: 样本 {len(details)} 条")
        except Exception as exc:  # noqa: BLE001
            emit(f"  WARN: 慢SQL明细查询失败 — {exc}")
            if details:
                emit(f"  慢SQL明细: 样本 {len(details)} 条（库内不可用）")
    elif details:
        emit(f"  慢SQL明细: 样本 {len(details)} 条（库内监控未就绪）")
    return details





def resolve_scenario_slow_sql(

    conn: DamengConn,

    *,

    started_at: str,

    finished_at: str,

    latencies: list[float],

    threshold_ms: float,

    log: Callable[[str], None] | None = None,

    warned_native: list[bool] | None = None,

) -> tuple[int, int]:

    """

    返回 (压测样本慢次数, 库内 V$SQL_HISTORY 慢次数)。



    - 压测样本：客户端 latencies 中 >= 阈值的次数（与 P95/P99 同源）

    - 库内统计：场景 started_at~finished_at 时间窗内 V$SQL_HISTORY（TIME_USED 微秒）

    - 库内不可用时第二项为 -1

    """

    emit = log or (lambda _m: None)

    bench_count = count_slow_sql_from_latencies(latencies, threshold_ms)

    dm_count = -1



    if _monitor_enabled(conn):

        try:

            dm_count = count_slow_sql_history_window(

                conn,

                started_at,

                finished_at,

                threshold_ms,

            )

            emit(

                f"  慢SQL(≥{int(threshold_ms)}ms): 样本 {bench_count} 条 · "

                f"库内 {dm_count} 条（V$SQL_HISTORY 场景窗口）"

            )

        except Exception as exc:  # noqa: BLE001

            if warned_native is not None and not warned_native[0]:

                emit(f"  WARN: V$SQL_HISTORY 统计失败 — {exc}")

                warned_native[0] = True

            emit(f"  慢SQL(≥{int(threshold_ms)}ms): 样本 {bench_count} 条 · 库内 —")

    else:

        if warned_native is not None and not warned_native[0]:

            emit("  WARN: 达梦 ENABLE_MONITOR/SQL 历史未就绪，库内慢SQL 记为 —")

            warned_native[0] = True

        emit(f"  慢SQL(≥{int(threshold_ms)}ms): 样本 {bench_count} 条 · 库内 —")



    return bench_count, dm_count


