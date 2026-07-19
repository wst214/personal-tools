"""达梦 DM8 SQL 压测（PERF-01～06）；与 sql_bench.py / PostgreSQL 完全隔离。"""

from __future__ import annotations

import os
import multiprocessing as mp
import queue
import re
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import yaml

from generators.dameng_conn import DamengConn
from generators.dameng_db import (
    DamengConnPeakSampler,
    connect_dm_with_retry,
    dm_bench_arraysize,
    dm_fetch_all,
    dm_fetch_scalar,
    setup_dm_bench_session,
)
from generators.dameng_geo import (
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_load_guard import assert_no_load_in_progress
from generators.dameng_slow_sql import collect_scenario_slow_sql_details, resolve_scenario_slow_sql
from generators.dm_write import dm_scalar, format_dm_literal, run_dm_script
from generators.sql_bench import (
    BENCH_LIGHTNING_SOURCE,
    BENCH_QUALITY_STATUS,
    BENCH_RAW_TOPIC,
    BIZ_ATMOSPHERE_TABLE,
    PERF06_SUB_LABELS,
    BenchContext,
    SCENARIO_ORDER,
    ScenarioResult,
    _is_read_scenario,
    _is_write_scenario,
    _percentile,
    _resolve_concurrency,
    normalize_perf05_agg_bucket_minutes,
    perf05_agg_scenario_name,
)

# PERF-06 enabled with DMGEO2 spatial distance
DAMENG_SKIP_PERF06 = False

_TRANSIENT_DM_CODES = frozenset({-70019, -70028, -70025})
_TRANSIENT_DM_MARKERS = (
    "Invalid handle",
    "Network communication failure",
    "Create SOCKET connection failure",
)
_DM_ERROR_CODE_RE = re.compile(r"\[CODE:(-?\d+)\]", re.I)


def _dm_error_code(exc: Exception) -> int | None:
    code = getattr(exc, "code", None)
    if code is not None:
        try:
            return int(code)
        except (TypeError, ValueError):
            pass
    match = _DM_ERROR_CODE_RE.search(str(exc))
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            pass
    return None


def _is_transient_dm_error(exc: Exception) -> bool:
    code = _dm_error_code(exc)
    if code is not None and code in _TRANSIENT_DM_CODES:
        return True
    text = str(exc)
    return any(marker in text for marker in _TRANSIENT_DM_MARKERS)


def _dm_bench_query_timeout_sec(scenario_id: str) -> float | None:
    """PERF-05 大结果集：默认单请求 120s 上限，可用 DM_BENCH_QUERY_TIMEOUT_SEC 覆盖。"""
    env_raw = os.environ.get("DM_BENCH_QUERY_TIMEOUT_SEC")
    if env_raw is not None and str(env_raw).strip():
        try:
            val = float(env_raw)
            return val if val > 0 else None
        except ValueError:
            pass
    if scenario_id == "PERF-05":
        return 120.0
    return None


def _dm_bench_error_abort_threshold(total_ops: int) -> int:
    """100 条或 5% 先到先停（取较小值）。"""
    rate = float(os.environ.get("DM_BENCH_ERROR_ABORT_RATE", "0.05"))
    cap = int(os.environ.get("DM_BENCH_ERROR_ABORT_MAX", "100"))
    return max(1, min(cap, int(total_ops * rate)))


def _dm_bench_transient_retries() -> int:
    """Disable reconnect by default so broken dmPython workers do not create more sockets."""
    raw = os.environ.get("DM_BENCH_TRANSIENT_RETRIES", "0")
    try:
        return max(0, min(3, int(raw)))
    except ValueError:
        return 0


def _dm_bench_scenario_timeout_sec(scenario_id: str, total_ops: int, iterations: int) -> float:
    """场景级硬超时（thread join）；dmPython 在 execute/fetch 内阻塞时只能靠此兜底。"""
    env_raw = os.environ.get("DM_BENCH_SCENARIO_TIMEOUT_SEC")
    if env_raw is not None and str(env_raw).strip():
        try:
            return max(30.0, float(env_raw))
        except ValueError:
            pass
    if scenario_id == "PERF-05":
        return max(600.0, min(3600.0, iterations * 30.0 + 120.0))
    return max(300.0, min(1800.0, total_ops * 0.05 + 60.0))


def _safe_close_dm(cur: Any, db: Any) -> None:
    if cur is not None:
        try:
            cur.close()
        except Exception:
            pass
    if db is not None:
        try:
            db.close()
        except Exception:
            pass


def _open_worker_session(conn: DamengConn, *, read_only: bool) -> tuple[Any, Any]:
    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=read_only)
    return db, cur


def _cursor_fetch_batch(cur: Any) -> int:
    size = int(getattr(cur, "arraysize", 0) or 0)
    return max(1, size if size > 0 else dm_bench_arraysize())


def _drain_read_cursor(cur: Any, *, deadline: float | None = None) -> None:
    batch = _cursor_fetch_batch(cur)
    while True:
        if deadline is not None and time.perf_counter() > deadline:
            raise TimeoutError("read query exceeded fetch deadline")
        rows = cur.fetchmany(batch)
        if not rows:
            break


def _execute_bench_sql(
    cur: Any,
    db: Any,
    sql: str,
    *,
    read_only: bool,
    query_timeout_sec: float | None,
) -> None:
    # 仅在 execute/fetch 返回之间检查耗时；若 dmPython 在 C 层阻塞，需靠场景级 join 超时。
    deadline = time.perf_counter() + query_timeout_sec if query_timeout_sec else None
    if deadline is not None and time.perf_counter() > deadline:
        raise TimeoutError(f"read query exceeded {query_timeout_sec:.0f}s (before execute)")
    cur.execute(sql)
    if not read_only:
        db.commit()
        return
    try:
        _drain_read_cursor(cur, deadline=deadline)
    except TimeoutError:
        if query_timeout_sec:
            raise TimeoutError(f"read query exceeded {query_timeout_sec:.0f}s (fetch)") from None
        raise


_WRITE_CLEANUP = (
    ("standard_atmosphere_electric_field", f"quality_status = '{BENCH_QUALITY_STATUS}'"),
    ("raw_kafka_message", f"topic = '{BENCH_RAW_TOPIC}'"),
    ("biz_lightning_event", f"source_type = '{BENCH_LIGHTNING_SOURCE}'"),
)


def _load_config(config_dir: Path) -> dict[str, Any]:
    with (config_dir / "sql-bench.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _bench_id(worker: int, seq: int) -> int:
    base = int(time.time() * 1_000_000)
    return base + worker * 10_000 + seq


def _ts_literal(ts: datetime) -> str:
    return format_dm_literal(ts)


def cleanup_bench_writes_dameng(conn: DamengConn, log: Callable[[str], None] | None = None) -> dict[str, int]:
    emit = log or (lambda _m: None)
    deleted: dict[str, int] = {}
    for table, where in _WRITE_CLEANUP:
        before = dm_scalar(conn, f"SELECT count(*) FROM {table} WHERE {where}")
        while True:
            run_dm_script(
                conn,
                f"""
                DELETE FROM {table}
                WHERE ROWID IN (
                    SELECT ROWID FROM {table} WHERE {where} AND ROWNUM <= 50000
                );
                """,
            )
            left = dm_scalar(conn, f"SELECT count(*) FROM {table} WHERE {where}")
            if left <= 0:
                break
        deleted[table] = before
    parts = [f"{t} {n}行" for t, n in deleted.items() if n]
    if parts:
        emit("清理达梦压测写入: " + ", ".join(parts))
    return deleted


def resolve_context_dameng(conn: DamengConn) -> BenchContext:
    atmosphere_count = dm_fetch_scalar(conn, f"SELECT count(*) FROM {BIZ_ATMOSPHERE_TABLE}")
    if atmosphere_count == 0:
        raise RuntimeError("库内无大气电场 biz 数据，请先完成造数")

    rows = dm_fetch_all(
        conn,
        f"""
        SELECT DISTINCT device_addr FROM {BIZ_ATMOSPHERE_TABLE}
        ORDER BY device_addr
        FETCH FIRST 5 ROWS ONLY
        """,
    )
    device_addrs = [str(r[0]) for r in rows]
    if not device_addrs:
        raise RuntimeError("无法解析 device_addr")

    trow = dm_fetch_all(
        conn,
        f"SELECT min(device_upload_time), max(device_upload_time) FROM {BIZ_ATMOSPHERE_TABLE}",
    )[0]
    tmin, tmax = trow[0], trow[1]
    query_end = tmax if isinstance(tmax, datetime) else datetime.now()
    query_start = max(tmin, query_end - timedelta(hours=24)) if isinstance(tmin, datetime) else query_end - timedelta(hours=24)

    proc = dm_fetch_all(
        conn,
        """
        SELECT p.id, p.mine_code, p.strike_start_time, p.strike_end_time,
               p.data_window_start, p.data_window_end,
               m.dispatch_room_lon, m.dispatch_room_lat
        FROM thunderstorm_process p
        JOIN mine_site m ON m.mine_code = p.mine_code
        ORDER BY p.id
        FETCH FIRST 1 ROWS ONLY
        """,
    )[0]
    dw_start = proc[4] or proc[2]
    dw_end = proc[5] or proc[3]
    if dw_start is None or dw_end is None:
        raise RuntimeError("雷暴过程缺少 data_window 或 strike 时间窗")

    raw_count = dm_fetch_scalar(conn, "SELECT count(*) FROM raw_kafka_message")
    lightning_count = dm_fetch_scalar(conn, "SELECT count(*) FROM biz_lightning_event")

    return BenchContext(
        mine_code=str(proc[1]),
        lon=float(proc[6]),
        lat=float(proc[7]),
        device_addrs=device_addrs,
        query_start=query_start,
        query_end=query_end,
        process_id=int(proc[0]),
        process_strike_start=proc[2],
        process_strike_end=proc[3],
        process_data_window_start=dw_start,
        process_data_window_end=dw_end,
        atmosphere_count=atmosphere_count,
        raw_count=raw_count,
        lightning_count=lightning_count,
    )


def _dm_geo_filter(lon: float, lat: float) -> str:
    """
    PERF-06 空间过滤。默认 GeomToGeog + ST_DWithin（无 bbox）；
    环境变量 DM_PERF06_GEO=bbox_geog 时启用 60km lon/lat 预筛。
    """
    mode = os.environ.get("DM_PERF06_GEO", "geog_only").strip().lower()
    if mode in {"bbox_geog", "bbox_dwithin", "bbox"}:
        return dm_within_50km_from_point_relaxed_bbox_dwithin_sql(lon, lat)
    return dm_within_50km_from_point_sql(lon, lat)


def _sql_perf01(ctx: BenchContext, worker: int, seq: int) -> str:
    addr = ctx.device_addrs[seq % len(ctx.device_addrs)]
    ts = ctx.query_end - timedelta(seconds=seq % 3600)
    oid = _bench_id(worker, seq)
    return f"""
    INSERT INTO standard_atmosphere_electric_field (
        id, raw_message_id, device_addr, type_id, command_type, device_upload_time,
        instantaneous_value, average_value, longitude, latitude, quality_status
    ) VALUES (
        {oid}, '[]', {format_dm_literal(addr)}, '01', '01', {_ts_literal(ts)},
        1.23, 1.20, {ctx.lon}, {ctx.lat}, {format_dm_literal(BENCH_QUALITY_STATUS)}
    )
    """


def _sql_perf02(ctx: BenchContext, worker: int, seq: int) -> str:
    ts = ctx.query_end - timedelta(seconds=seq % 1800)
    oid = _bench_id(worker, seq)
    return f"""
    INSERT INTO raw_kafka_message (
        id, topic, partition_no, offset_no, raw_value, source_type,
        receive_time, create_time, update_time
    ) VALUES (
        {oid}, {format_dm_literal(BENCH_RAW_TOPIC)}, {worker % 3}, {oid}, '{{}}',
        {format_dm_literal(BENCH_LIGHTNING_SOURCE)}, {_ts_literal(ts)}, {_ts_literal(ts)}, {_ts_literal(ts)}
    )
    """


def _sql_perf03(ctx: BenchContext, worker: int, seq: int) -> str:
    span = max((ctx.process_strike_end - ctx.process_strike_start).total_seconds(), 1)
    ts = ctx.process_strike_start + timedelta(seconds=seq % int(span))
    lon = ctx.lon + (seq % 10) * 0.001
    lat = ctx.lat + (seq % 10) * 0.001
    oid = _bench_id(worker, seq)
    return f"""
    INSERT INTO biz_lightning_event (
        id, source_type, lightning_type, strike_time, longitude, latitude, risk_level
    ) VALUES (
        {oid}, {format_dm_literal(BENCH_LIGHTNING_SOURCE)}, 'CG', {_ts_literal(ts)},
        {lon}, {lat}, 0
    )
    """


def _sql_perf04(ctx: BenchContext, worker: int, seq: int) -> str:
    addr = ctx.device_addrs[worker % len(ctx.device_addrs)]
    offset = (seq % 20) * 50
    return f"""
    SELECT /*+ INDEX(biz_atmosphere_electric_field_event idx_biz_atm_field_page_cover) */
           id, device_upload_time, instantaneous_value, average_value,
           warning_level, risk_level, event_status
    FROM {BIZ_ATMOSPHERE_TABLE}
    WHERE device_addr = {format_dm_literal(addr)}
      AND device_upload_time >= {_ts_literal(ctx.query_start)}
      AND device_upload_time < {_ts_literal(ctx.query_end)}
    ORDER BY device_upload_time DESC
    OFFSET {offset} ROWS FETCH NEXT 50 ROWS ONLY
    """


def _sql_perf05(ctx: BenchContext, worker: int, seq: int) -> str:
    in_list = ", ".join(format_dm_literal(a) for a in ctx.device_addrs)
    return f"""
    SELECT device_addr, device_upload_time, instantaneous_value, average_value,
           warning_level, rate_change, risk_level
    FROM {BIZ_ATMOSPHERE_TABLE}
    WHERE device_addr IN ({in_list})
      AND device_upload_time >= {_ts_literal(ctx.process_data_window_start)}
      AND device_upload_time < {_ts_literal(ctx.process_data_window_end)}
    ORDER BY device_addr, device_upload_time
    """


def _sql_perf05_agg(ctx: BenchContext, worker: int, seq: int) -> str:
    in_list = ", ".join(format_dm_literal(a) for a in ctx.device_addrs)
    bucket = normalize_perf05_agg_bucket_minutes(ctx.perf05_agg_bucket_minutes)
    return f"""
    WITH base AS (
        SELECT
            device_addr,
            TRUNC(device_upload_time, 'HH24')
                + (FLOOR(TO_NUMBER(TO_CHAR(device_upload_time, 'MI')) / {bucket}) * {bucket}) / 1440 AS bucket_time,
            instantaneous_value,
            average_value,
            warning_level,
            rate_change,
            risk_level
        FROM {BIZ_ATMOSPHERE_TABLE}
        WHERE device_addr IN ({in_list})
          AND device_upload_time >= {_ts_literal(ctx.process_data_window_start)}
          AND device_upload_time < {_ts_literal(ctx.process_data_window_end)}
    )
    SELECT
        device_addr,
        bucket_time AS device_upload_time,
        AVG(instantaneous_value) AS instantaneous_value,
        AVG(average_value) AS average_value,
        MAX(warning_level) AS warning_level,
        AVG(rate_change) AS rate_change,
        MAX(risk_level) AS risk_level,
        COUNT(*) AS point_count
    FROM base
    GROUP BY device_addr, bucket_time
    ORDER BY device_addr, bucket_time
    """


def _sql_perf06_count(ctx: BenchContext, worker: int, seq: int) -> str:
    geo = _dm_geo_filter(ctx.lon, ctx.lat)
    return f"""
    SELECT count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE l.strike_time >= {_ts_literal(ctx.process_strike_start)}
      AND l.strike_time < {_ts_literal(ctx.process_strike_end)}
      AND {geo}
    """


def _sql_perf06_source_dist(ctx: BenchContext, worker: int, seq: int) -> str:
    geo = _dm_geo_filter(ctx.lon, ctx.lat)
    return f"""
    SELECT l.source_type, count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE l.strike_time >= {_ts_literal(ctx.process_strike_start)}
      AND l.strike_time < {_ts_literal(ctx.process_strike_end)}
      AND {geo}
    GROUP BY l.source_type
    """


def _sql_perf06_type_dist(ctx: BenchContext, worker: int, seq: int) -> str:
    geo = _dm_geo_filter(ctx.lon, ctx.lat)
    return f"""
    SELECT l.lightning_type, count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE l.strike_time >= {_ts_literal(ctx.process_strike_start)}
      AND l.strike_time < {_ts_literal(ctx.process_strike_end)}
      AND {geo}
    GROUP BY l.lightning_type
    """


SQL_BUILDERS = {
    "PERF-01": _sql_perf01,
    "PERF-02": _sql_perf02,
    "PERF-03": _sql_perf03,
    "PERF-04": _sql_perf04,
    "PERF-05": _sql_perf05,
    "PERF-05-AGG": _sql_perf05_agg,
}

PERF06_SUB_BUILDERS = {
    "count": _sql_perf06_count,
    "source_dist": _sql_perf06_source_dist,
    "type_dist": _sql_perf06_type_dist,
}


def sql_preview_for_scenario(scenario_id: str, ctx: BenchContext) -> str:
    builder = SQL_BUILDERS.get(scenario_id)
    if builder is None and scenario_id.startswith("PERF-06-"):
        builder = PERF06_SUB_BUILDERS.get(scenario_id[len("PERF-06-") :])
    if not builder:
        return ""
    try:
        return builder(ctx, 0, 0).strip()
    except Exception:
        return ""


def refresh_run_slow_sql_details(
    conn: DamengConn,
    scenario_results: list[dict[str, Any]],
    *,
    ctx: BenchContext | None = None,
    log: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    """为压测结果补全慢 SQL 明细（旧记录或刷新库内视图）。"""
    emit = log or (lambda _m: None)
    bench_ctx = ctx or resolve_context_dameng(conn)
    updated: list[dict[str, Any]] = []
    for raw in scenario_results:
        row = dict(raw)
        sid = str(row.get("id") or "")
        started = row.get("startedAt") or row.get("started_at")
        finished = row.get("finishedAt") or row.get("finished_at")
        if not sid or not started or not finished:
            updated.append(row)
            continue
        threshold = float(row.get("slowSqlThresholdMs") or row.get("slow_sql_threshold_ms") or 500)
        bench_count = row.get("slowSqlBenchCount")
        if bench_count is None:
            bench_count = row.get("slow_sql_bench_count", row.get("slowSqlCount", 0))
        try:
            bench_n = int(bench_count)
        except (TypeError, ValueError):
            bench_n = 0
        dm_count = row.get("slowSqlDmCount", row.get("slow_sql_dm_count", -1))
        try:
            dm_n = int(dm_count)
        except (TypeError, ValueError):
            dm_n = -1
        if bench_n <= 0 and dm_n <= 0:
            row["slowSqlDetails"] = []
            updated.append(row)
            continue
        max_ms = row.get("max_ms", row.get("maxMs"))
        try:
            max_val = float(max_ms) if max_ms is not None else None
        except (TypeError, ValueError):
            max_val = None
        preview = sql_preview_for_scenario(sid, bench_ctx)
        details = collect_scenario_slow_sql_details(
            conn,
            started_at=str(started),
            finished_at=str(finished),
            latencies=None,
            threshold_ms=threshold,
            sql_preview=preview,
            bench_count=bench_n,
            max_ms=max_val,
            log=emit,
        )
        row["sqlPreview"] = preview
        row["sql_preview"] = preview
        row["slowSqlDetails"] = details
        row["slow_sql_details"] = details
        updated.append(row)
    return updated


def _worker_dm(
    conn: DamengConn,
    scenario_id: str,
    kind: str,
    ctx: BenchContext,
    iterations: int,
    warmup: int,
    worker_idx: int,
    latencies: list[float],
    errors: list[str],
    metrics_lock: threading.Lock,
    *,
    stop_event: threading.Event,
    error_abort_threshold: int,
) -> None:
    builder = SQL_BUILDERS[scenario_id]
    read_only = kind != "write"
    query_timeout_sec = _dm_bench_query_timeout_sec(scenario_id)
    max_attempts = 1 + _dm_bench_transient_retries()
    db: Any = None
    cur: Any = None

    def record_error(msg: str) -> None:
        with metrics_lock:
            errors.append(msg)
            if len(errors) >= error_abort_threshold:
                stop_event.set()

    try:
        db, cur = _open_worker_session(conn, read_only=read_only)
    except Exception as exc:  # noqa: BLE001
        record_error(f"worker={worker_idx} connect: {exc} ({iterations} ops skipped)")
        return

    try:
        for seq in range(warmup + iterations):
            if stop_event.is_set():
                break
            is_warmup = seq < warmup
            sql = builder(ctx, worker_idx, seq).strip()
            t0 = time.perf_counter()
            op_ok = False
            last_exc: Exception | None = None
            exit_worker = False

            for attempt in range(max_attempts):
                try:
                    _execute_bench_sql(
                        cur,
                        db,
                        sql,
                        read_only=read_only,
                        query_timeout_sec=query_timeout_sec,
                    )
                    op_ok = True
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if not read_only:
                        try:
                            db.rollback()
                        except Exception:
                            pass
                    if attempt + 1 < max_attempts and _is_transient_dm_error(exc):
                        _safe_close_dm(cur, db)
                        cur, db = None, None
                        try:
                            db, cur = _open_worker_session(conn, read_only=read_only)
                            continue
                        except Exception as conn_exc:  # noqa: BLE001
                            last_exc = conn_exc
                            break
                    break

            if op_ok:
                if not is_warmup:
                    elapsed_ms = (time.perf_counter() - t0) * 1000.0
                    with metrics_lock:
                        latencies.append(elapsed_ms)
                continue

            if last_exc is None:
                continue
            prefix = "abort" if is_warmup else "seq"
            record_error(f"worker={worker_idx} {prefix}={seq}: {last_exc}")
            if isinstance(last_exc, TimeoutError) or _is_transient_dm_error(last_exc):
                exit_worker = True
            if exit_worker:
                break
    finally:
        _safe_close_dm(cur, db)


def _run_simple_scenario_in_process(
    scenario_id: str,
    stage: str,
    conn: DamengConn,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    *,
    concurrency: int | None = None,
    query_concurrency: int | None = None,
    iterations: int | None = None,
    slow_sql_threshold_ms: float = 500.0,
    log: Callable[[str], None] | None = None,
    slow_sql_warned: list[bool] | None = None,
) -> ScenarioResult:
    emit = log or (lambda _m: None)
    kind = str(cfg.get("kind", "read"))
    conc = _resolve_concurrency(cfg, stage, defaults, concurrency, query_concurrency)
    iters = iterations or int(defaults.get("iterations", 50))
    warmup = int(defaults.get("warmup", 5))
    name = (
        perf05_agg_scenario_name(ctx.perf05_agg_bucket_minutes)
        if scenario_id == "PERF-05-AGG"
        else str(cfg.get("name", scenario_id))
    )
    p95_limit = cfg.get("p95_limit_ms")
    p99_limit = cfg.get("p99_limit_ms", p95_limit * 2 if p95_limit else None)

    emit(f"[{scenario_id}] {name} — 并发 {conc} × {iters} 次（达梦 dmPython）")
    started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    latencies: list[float] = []
    errors: list[str] = []
    metrics_lock = threading.Lock()
    stop_event = threading.Event()
    total_ops = conc * iters
    error_abort_threshold = _dm_bench_error_abort_threshold(total_ops)
    scenario_timeout_sec = _dm_bench_scenario_timeout_sec(scenario_id, total_ops, iters)
    threads: list[threading.Thread] = []
    conn_sampler = DamengConnPeakSampler(conn)
    conn_sampler.start()
    t0 = time.perf_counter()
    for w in range(conc):
        t = threading.Thread(
            target=_worker_dm,
            args=(conn, scenario_id, kind, ctx, iters, warmup, w, latencies, errors, metrics_lock),
            kwargs={
                "stop_event": stop_event,
                "error_abort_threshold": error_abort_threshold,
            },
            daemon=True,
        )
        threads.append(t)
        t.start()
        # 错开建连，避免 20 线程同时 connect 触发 -70028
        if w + 1 < conc:
            time.sleep(0.05)
    join_deadline = time.perf_counter() + scenario_timeout_sec
    for t in threads:
        remaining = join_deadline - time.perf_counter()
        if remaining <= 0:
            stop_event.set()
            break
        t.join(timeout=remaining)
    alive = sum(1 for t in threads if t.is_alive())
    if alive:
        stop_event.set()
        with metrics_lock:
            errors.append(
                f"scenario timeout after {scenario_timeout_sec:.0f}s "
                f"({alive} workers still running)"
            )
        emit(
            f"  WARN: 场景超时 {scenario_timeout_sec:.0f}s，"
            f"{alive} 个 worker 未结束（dmPython 可能阻塞在 execute/fetch）"
        )
    duration = time.perf_counter() - t0
    conn_peak = conn_sampler.stop()
    finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    success = len(latencies)
    total = total_ops
    if stop_event.is_set() and errors:
        emit(
            f"  WARN: 错误数≥{error_abort_threshold}，已提前结束 worker（避免 -70019 连锁）"
        )
    avg = sum(latencies) / success if success else 0.0
    p50 = _percentile(latencies, 50)
    p95 = _percentile(latencies, 95)
    p99 = _percentile(latencies, 99)
    tps = success / duration if duration > 0 else 0.0
    slow_bench, slow_dm = resolve_scenario_slow_sql(
        conn,
        started_at=started_at,
        finished_at=finished_at,
        latencies=latencies,
        threshold_ms=slow_sql_threshold_ms,
        log=emit,
        warned_native=slow_sql_warned,
    )
    sql_preview = sql_preview_for_scenario(scenario_id, ctx)
    slow_details = collect_scenario_slow_sql_details(
        conn,
        started_at=started_at,
        finished_at=finished_at,
        latencies=latencies,
        threshold_ms=slow_sql_threshold_ms,
        sql_preview=sql_preview,
        log=emit,
    )

    passed: bool | None = None
    if success == 0 and errors:
        passed = False
    elif success > 0 and (p95_limit is not None or p99_limit is not None):
        p95_ok = p95_limit is None or p95 <= float(p95_limit)
        p99_ok = p99_limit is None or p99 <= float(p99_limit or p95_limit * 2)
        passed = p95_ok and p99_ok and not errors

    note = f"达梦直连 SQL（不经 API/解析）· {kind}"
    if kind == "write":
        note += " · COMMIT 落库（压测后按标记清理）"
    if errors:
        note += f" · {len(errors)} 错误"
    if p95_limit is not None:
        note += f" · P95 阈值 {p95_limit}ms"
    if p99_limit is not None:
        note += f" · P99 阈值 {p99_limit}ms"

    emit(
        f"  完成 {success}/{total}，P50={p50:.1f}ms，P95={p95:.1f}ms，P99={p99:.1f}ms，TPS={tps:.1f}"
        + (f"，{'通过' if passed else '未通过'}" if passed is not None else "")
    )
    if errors:
        for msg in errors[:3]:
            emit(f"  ERROR: {msg}")
        if len(errors) > 3:
            emit(f"  ERROR: ... 另有 {len(errors) - 3} 条")

    result = ScenarioResult(
        id=scenario_id,
        name=name,
        kind=kind,
        stage=stage,
        concurrency=conc,
        iterations=iters,
        total_ops=total,
        success_ops=success,
        error_count=len(errors),
        errors=errors[:5],
        avg_ms=avg,
        p50_ms=p50,
        p95_ms=p95,
        p99_ms=p99,
        min_ms=min(latencies) if latencies else 0.0,
        max_ms=max(latencies) if latencies else 0.0,
        tps=tps,
        duration_sec=duration,
        p95_limit_ms=int(p95_limit) if p95_limit is not None else None,
        p99_limit_ms=int(p99_limit) if p99_limit is not None else None,
        passed=passed,
        note=note,
        started_at=started_at,
        finished_at=finished_at,
        conn_peak=conn_peak,
        slow_sql_count=slow_bench,
        slow_sql_threshold_ms=slow_sql_threshold_ms,
    )
    result.slow_sql_bench_count = slow_bench  # type: ignore[attr-defined]
    result.slow_sql_dm_count = slow_dm  # type: ignore[attr-defined]
    result.slow_sql_source = "bench+dm" if slow_dm >= 0 else "bench"  # type: ignore[attr-defined]
    result.slow_sql_details = slow_details  # type: ignore[attr-defined]
    result.sql_preview = sql_preview  # type: ignore[attr-defined]
    return result


def _dm_bench_process_grace_sec() -> float:
    env_raw = os.environ.get("DM_BENCH_PROCESS_GRACE_SEC")
    if env_raw is not None and str(env_raw).strip():
        try:
            return max(5.0, float(env_raw))
        except ValueError:
            pass
    return 30.0


def _dm_bench_mp_context() -> mp.context.BaseContext:
    default_method = "fork" if hasattr(os, "fork") else "spawn"
    method = os.environ.get("DM_BENCH_MP_START", default_method).strip() or default_method
    try:
        return mp.get_context(method)
    except ValueError:
        return mp.get_context(default_method)


def _ensure_sub_scenario_builder(scenario_id: str) -> None:
    if scenario_id.startswith("PERF-06-") and scenario_id not in SQL_BUILDERS:
        tag = scenario_id[len("PERF-06-") :]
        builder = PERF06_SUB_BUILDERS.get(tag)
        if builder is not None:
            SQL_BUILDERS[scenario_id] = builder  # type: ignore[assignment]


def _scenario_result_failure(
    scenario_id: str,
    stage: str,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    *,
    concurrency: int | None,
    query_concurrency: int | None,
    iterations: int | None,
    slow_sql_threshold_ms: float,
    started_at: str,
    duration_sec: float,
    error: str,
) -> ScenarioResult:
    kind = str(cfg.get("kind", "read"))
    conc = _resolve_concurrency(cfg, stage, defaults, concurrency, query_concurrency)
    iters = iterations or int(defaults.get("iterations", 50))
    p95_limit = cfg.get("p95_limit_ms")
    p99_limit = cfg.get("p99_limit_ms", p95_limit * 2 if p95_limit else None)
    finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    result = ScenarioResult(
        id=scenario_id,
        name=str(cfg.get("name", scenario_id)),
        kind=kind,
        stage=stage,
        concurrency=conc,
        iterations=iters,
        total_ops=conc * iters,
        success_ops=0,
        error_count=1,
        errors=[error],
        avg_ms=0.0,
        p50_ms=0.0,
        p95_ms=0.0,
        p99_ms=0.0,
        min_ms=0.0,
        max_ms=0.0,
        tps=0.0,
        duration_sec=duration_sec,
        p95_limit_ms=int(p95_limit) if p95_limit is not None else None,
        p99_limit_ms=int(p99_limit) if p99_limit is not None else None,
        passed=False,
        note=f"达梦场景进程隔离执行失败 · {kind} · {error}",
        started_at=started_at,
        finished_at=finished_at,
        conn_peak=0,
        slow_sql_count=0,
        slow_sql_threshold_ms=slow_sql_threshold_ms,
    )
    result.slow_sql_bench_count = 0  # type: ignore[attr-defined]
    result.slow_sql_dm_count = -1  # type: ignore[attr-defined]
    result.slow_sql_source = "bench"  # type: ignore[attr-defined]
    result.slow_sql_details = []  # type: ignore[attr-defined]
    result.sql_preview = sql_preview_for_scenario(scenario_id, ctx)  # type: ignore[attr-defined]
    return result


def _dameng_scenario_process_entry(
    out_q: Any,
    conn: DamengConn,
    scenario_id: str,
    stage: str,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    concurrency: int | None,
    query_concurrency: int | None,
    iterations: int | None,
    slow_sql_threshold_ms: float,
    slow_sql_warned: list[bool] | None,
) -> None:
    def emit(msg: str) -> None:
        out_q.put(("log", msg))

    try:
        _ensure_sub_scenario_builder(scenario_id)
        result = _run_simple_scenario_in_process(
            scenario_id,
            stage,
            conn,
            ctx,
            cfg,
            defaults,
            concurrency=concurrency,
            query_concurrency=query_concurrency,
            iterations=iterations,
            slow_sql_threshold_ms=slow_sql_threshold_ms,
            log=emit,
            slow_sql_warned=slow_sql_warned,
        )
        out_q.put(("result", result))
    except BaseException:  # noqa: BLE001
        out_q.put(("error", traceback.format_exc()))


def _drain_scenario_queue(out_q: Any, emit: Callable[[str], None]) -> tuple[ScenarioResult | None, str | None]:
    result: ScenarioResult | None = None
    error_text: str | None = None
    while True:
        try:
            item_type, payload = out_q.get_nowait()
        except queue.Empty:
            break
        if item_type == "log":
            emit(str(payload))
        elif item_type == "result":
            result = payload
        elif item_type == "error":
            error_text = str(payload)
    return result, error_text


def _run_simple_scenario(
    scenario_id: str,
    stage: str,
    conn: DamengConn,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    *,
    concurrency: int | None = None,
    query_concurrency: int | None = None,
    iterations: int | None = None,
    slow_sql_threshold_ms: float = 500.0,
    log: Callable[[str], None] | None = None,
    slow_sql_warned: list[bool] | None = None,
) -> ScenarioResult:
    if os.environ.get("DM_BENCH_PROCESS_ISOLATION", "1").strip().lower() in {"0", "false", "off", "no"}:
        return _run_simple_scenario_in_process(
            scenario_id,
            stage,
            conn,
            ctx,
            cfg,
            defaults,
            concurrency=concurrency,
            query_concurrency=query_concurrency,
            iterations=iterations,
            slow_sql_threshold_ms=slow_sql_threshold_ms,
            log=log,
            slow_sql_warned=slow_sql_warned,
        )

    emit = log or (lambda _m: None)
    _ensure_sub_scenario_builder(scenario_id)
    kind = str(cfg.get("kind", "read"))
    conc = _resolve_concurrency(cfg, stage, defaults, concurrency, query_concurrency)
    iters = iterations or int(defaults.get("iterations", 50))
    total_ops = conc * iters
    scenario_timeout_sec = _dm_bench_scenario_timeout_sec(scenario_id, total_ops, iters)
    hard_timeout_sec = scenario_timeout_sec + _dm_bench_process_grace_sec()
    started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    t0 = time.perf_counter()

    mp_ctx = _dm_bench_mp_context()
    out_q = mp_ctx.Queue()
    proc = mp_ctx.Process(
        target=_dameng_scenario_process_entry,
        args=(
            out_q,
            conn,
            scenario_id,
            stage,
            ctx,
            cfg,
            defaults,
            concurrency,
            query_concurrency,
            iterations,
            slow_sql_threshold_ms,
            slow_sql_warned,
        ),
    )
    proc.daemon = False
    proc.start()

    result: ScenarioResult | None = None
    error_text: str | None = None
    deadline = t0 + hard_timeout_sec
    while True:
        try:
            item_type, payload = out_q.get(timeout=0.2)
        except queue.Empty:
            pass
        else:
            if item_type == "log":
                emit(str(payload))
            elif item_type == "result":
                result = payload
            elif item_type == "error":
                error_text = str(payload)

        extra_result, extra_error = _drain_scenario_queue(out_q, emit)
        if extra_result is not None:
            result = extra_result
        if extra_error is not None:
            error_text = extra_error

        if result is not None or error_text is not None:
            proc.join(timeout=5)
            if proc.is_alive():
                emit(f"  WARN: {scenario_id} 子进程返回后仍未退出，强制终止以释放达梦连接")
                proc.terminate()
                proc.join(timeout=5)
                if proc.is_alive() and hasattr(proc, "kill"):
                    proc.kill()
                    proc.join(timeout=5)
            break

        if not proc.is_alive():
            break

        if time.perf_counter() >= deadline:
            emit(
                f"  WARN: {scenario_id} 场景进程超过 {hard_timeout_sec:.0f}s，"
                "强制终止以释放达梦 socket"
            )
            proc.terminate()
            proc.join(timeout=5)
            if proc.is_alive() and hasattr(proc, "kill"):
                proc.kill()
                proc.join(timeout=5)
            error_text = f"scenario process timeout after {hard_timeout_sec:.0f}s"
            break

    extra_result, extra_error = _drain_scenario_queue(out_q, emit)
    if extra_result is not None:
        result = extra_result
    if extra_error is not None:
        error_text = extra_error

    try:
        out_q.close()
        out_q.join_thread()
    except Exception:
        pass

    duration = time.perf_counter() - t0
    if result is not None:
        return result

    if error_text:
        first_line = error_text.strip().splitlines()[-1] if error_text.strip() else "unknown process error"
        emit(f"  ERROR: {scenario_id} 子进程失败: {first_line}")
        return _scenario_result_failure(
            scenario_id,
            stage,
            ctx,
            cfg,
            defaults,
            concurrency=concurrency,
            query_concurrency=query_concurrency,
            iterations=iterations,
            slow_sql_threshold_ms=slow_sql_threshold_ms,
            started_at=started_at,
            duration_sec=duration,
            error=first_line,
        )

    exit_code = proc.exitcode
    error = f"scenario process exited without result (exitcode={exit_code})"
    emit(f"  ERROR: {scenario_id} {error}")
    return _scenario_result_failure(
        scenario_id,
        stage,
        ctx,
        cfg,
        defaults,
        concurrency=concurrency,
        query_concurrency=query_concurrency,
        iterations=iterations,
        slow_sql_threshold_ms=slow_sql_threshold_ms,
        started_at=started_at,
        duration_sec=duration,
        error=error,
    )


def run_sql_benchmark_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path | None = None,
    scenarios: list[str] | None = None,
    concurrency: int | None = None,
    query_concurrency: int | None = None,
    iterations: int | None = None,
    write_iterations: int | None = None,
    query_iterations: int | None = None,
    slow_sql_threshold_ms: float | None = None,
    perf05_agg_bucket_minutes: int | float | str | None = None,
    log: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    bench_cfg = _load_config(root)
    defaults = bench_cfg.get("defaults", {})
    slow_ms = float(
        slow_sql_threshold_ms
        if slow_sql_threshold_ms is not None
        else defaults.get("slow_sql_threshold_ms", 500)
    )
    agg_bucket = normalize_perf05_agg_bucket_minutes(
        perf05_agg_bucket_minutes
        if perf05_agg_bucket_minutes is not None
        else defaults.get("perf05_agg_bucket_minutes", 10)
    )
    scenario_cfgs = bench_cfg.get("scenarios", {})
    selected = scenarios or list(SCENARIO_ORDER)
    emit = log or (lambda _m: None)

    assert_no_load_in_progress(conn, "执行 SQL 压测")
    emit(f"压测模式: 达梦直连 SQL stage={stage} schema={conn.schema}")
    emit(
        f"慢SQL阈值: ≥{int(slow_ms)}ms（样本=客户端耗时；库内=V$SQL_HISTORY 场景时间窗）"
    )
    emit(f"PERF-05-AGG 聚合间隔: {agg_bucket} 分钟")
    slow_sql_warned = [False]
    cleanup_bench_writes_dameng(conn, log=emit)
    ctx = resolve_context_dameng(conn)
    ctx.perf05_agg_bucket_minutes = agg_bucket
    emit(
        f"数据快照: 大气 biz={ctx.atmosphere_count:,} raw={ctx.raw_count:,} "
        f"闪电={ctx.lightning_count:,} 设备={len(ctx.device_addrs)}台"
    )

    results: list[ScenarioResult] = []
    pending_write = False
    for sid in selected:
        if sid not in scenario_cfgs:
            raise ValueError(f"未知场景: {sid}")
        cfg = scenario_cfgs[sid]
        scenario_iterations = iterations
        if scenario_iterations is None:
            if _is_read_scenario(cfg):
                scenario_iterations = query_iterations
            elif _is_write_scenario(cfg):
                scenario_iterations = write_iterations

        if _is_read_scenario(cfg) and pending_write:
            cleanup_bench_writes_dameng(conn, log=emit)
            pending_write = False
        if sid == "PERF-02" and ctx.raw_count == 0:
            emit(f"[{sid}] 跳过：无 raw 数据")
            continue
        if sid in ("PERF-03", "PERF-06") and ctx.lightning_count == 0:
            emit(f"[{sid}] 跳过：无闪电数据")
            continue

        if sid == "PERF-06" and cfg.get("compound"):
            emit("[PERF-06] 达梦 compound 场景按子查询顺序串行执行（dmPython）")
            for tag, builder in PERF06_SUB_BUILDERS.items():
                sub_cfg = {
                    "kind": "read",
                    "name": PERF06_SUB_LABELS.get(tag, tag),
                    "p95_limit_ms": (cfg.get("sub_queries") or {}).get(tag, {}).get("p95_limit_ms", 1500),
                }
                sub_id = f"PERF-06-{tag}"
                SQL_BUILDERS[sub_id] = builder  # type: ignore[assignment]
                results.append(
                    _run_simple_scenario(
                        sub_id,
                        stage,
                        conn,
                        ctx,
                        sub_cfg,
                        defaults,
                        concurrency=concurrency,
                        query_concurrency=query_concurrency,
                        iterations=scenario_iterations,
                        slow_sql_threshold_ms=slow_ms,
                        log=emit,
                        slow_sql_warned=slow_sql_warned,
                    )
                )
                del SQL_BUILDERS[sub_id]
            continue

        results.append(
            _run_simple_scenario(
                sid,
                stage,
                conn,
                ctx,
                cfg,
                defaults,
                concurrency=concurrency,
                query_concurrency=query_concurrency,
                iterations=scenario_iterations,
                slow_sql_threshold_ms=slow_ms,
                log=emit,
                slow_sql_warned=slow_sql_warned,
            )
        )
        if _is_write_scenario(cfg):
            pending_write = True

    if pending_write:
        cleanup_bench_writes_dameng(conn, log=emit)

    all_pass = all(r.passed for r in results if r.passed is not None)
    any_pass = any(r.passed is not None for r in results)

    return {
        "stage": stage,
        "dialect": "dameng",
        "mode": "sql_direct",
        "context": {
            "mineCode": ctx.mine_code,
            "deviceAddrs": ctx.device_addrs,
            "atmosphereCount": ctx.atmosphere_count,
            "rawCount": ctx.raw_count,
            "lightningCount": ctx.lightning_count,
        },
        "results": [
            {
                **r.__dict__,
                "startedAt": r.started_at,
                "finishedAt": r.finished_at,
                "connPeak": r.conn_peak,
                "slowSqlCount": r.slow_sql_count if r.slow_sql_count >= 0 else None,
                "slowSqlBenchCount": getattr(r, "slow_sql_bench_count", r.slow_sql_count),
                "slowSqlDmCount": getattr(r, "slow_sql_dm_count", -1),
                "slowSqlThresholdMs": int(r.slow_sql_threshold_ms),
                "slowSqlSource": getattr(r, "slow_sql_source", None),
                "slowSqlDetails": getattr(r, "slow_sql_details", []),
                "sqlPreview": sql_preview_for_scenario(r.id, ctx),
            }
            for r in results
        ],
        "section11_4": [r.to_section11_4() for r in results],
        "passed": all_pass if any_pass else None,
    }
