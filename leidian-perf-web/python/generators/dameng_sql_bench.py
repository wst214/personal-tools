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
    dm_bbox_prefilter_for_point,
    dm_haversine_meters_sql,
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
    apply_write_pace_from_devices,
    expand_bench_device_addrs,
    LatencyStats,
    _is_read_scenario,
    _is_write_scenario,
    _maybe_force_cross_month_query_window,
    _percentile,
    _resolve_concurrency,
    _resolve_write_ts_base,
    _perf05_one_minute_window,
    bench_curve_device_addrs,
    clip_process_data_window,
    normalize_perf05_agg_bucket_minutes,
    normalize_perf06_geo_mode,
    normalize_scenario_ids,
    perf05_agg_scenario_name,
    resolve_bench_device_limit,
    resolve_curve_device_addrs,
    resolve_scenario_iterations,
    resolve_write_pace_interval_sec,
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
    """场景级硬超时（thread join）；dmPython 在 execute/fetch 内阻塞时只能靠此兜底。

    满密档多设备查询单次可达数百毫秒～数秒，旧公式 total_ops*0.05 在次数较少时
    会落在 300s 下限，导致 AGG/1MIN 尚未跑完就被判超时。默认放宽到至少 30 分钟。
    """
    env_raw = os.environ.get("DM_BENCH_SCENARIO_TIMEOUT_SEC")
    if env_raw is not None and str(env_raw).strip():
        try:
            return max(30.0, float(env_raw))
        except ValueError:
            pass
    # 按「每 worker 次数」估墙钟：重查询按约 3s/次留余量
    per_worker = max(int(iterations), 1)
    if scenario_id in ("PERF-05", "PERF-05-AGG", "PERF-05-1MIN"):
        return max(1800.0, min(7200.0, per_worker * 5.0 + 600.0))
    # 其它场景：至少 30 分钟；上限 2 小时
    return max(1800.0, min(7200.0, float(total_ops) * 0.2 + 300.0))


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
        # 显式丢弃批次，避免 20 并发大结果集在客户端堆峰值内存
        del rows


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

    two_phase = _split_perf06_two_phase_sql(sql) if read_only else None
    if two_phase is not None:
        phase1_insert, phase2 = two_phase
        # 真两段：GTT 落候选 ROWID，再 JOIN+ST_DWithin（禁止拼进同一条可合并 SQL）
        _prepare_perf06_cand_gtt(cur)
        if deadline is not None and time.perf_counter() > deadline:
            raise TimeoutError(f"read query exceeded {query_timeout_sec:.0f}s (before phase1)")
        cur.execute(phase1_insert)
        _discard_cursor_result(cur)
        if deadline is not None and time.perf_counter() > deadline:
            raise TimeoutError(f"read query exceeded {query_timeout_sec:.0f}s (before phase2)")
        cur.execute(phase2)
        try:
            _drain_read_cursor(cur, deadline=deadline)
        except TimeoutError:
            if query_timeout_sec:
                raise TimeoutError(
                    f"read query exceeded {query_timeout_sec:.0f}s (phase2 fetch)"
                ) from None
            raise
        return

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
    (
        "standard_atmosphere_electric_field",
        f"quality_status = '{BENCH_QUALITY_STATUS}'",
        "device_upload_time",
        "idx_std_atm_field_upload_time",
    ),
    (
        "raw_kafka_message",
        f"topic = '{BENCH_RAW_TOPIC}'",
        "receive_time",
        "idx_raw_kafka_message_topic_time",
    ),
    (
        "biz_lightning_event",
        f"source_type = '{BENCH_LIGHTNING_SOURCE}'",
        None,
        None,
    ),
)


def _load_config(config_dir: Path) -> dict[str, Any]:
    with (config_dir / "sql-bench.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _bench_id(worker: int, seq: int) -> int:
    base = int(time.time() * 1_000_000)
    return base + worker * 10_000 + seq


def _ts_literal(ts: datetime) -> str:
    return format_dm_literal(ts)


def _bench_cleanup_time_floor(
    config_dir: Path | None,
    stage: str | None,
) -> datetime | None:
    """满密 + write_after_atmosphere 时返回大气窗终点；否则不加时间下界。"""
    if not stage:
        return None
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    vol_path = root / "volume-profiles.yaml"
    if not vol_path.exists():
        return None
    with vol_path.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    profile = (cfg.get("stages") or {}).get(stage) or {}
    if not (profile.get("write_after_atmosphere") and profile.get("atmosphere_full_1hz")):
        return None
    return _resolve_write_ts_base(config_dir, stage, datetime(1970, 1, 1))


def cleanup_bench_writes_dameng(
    conn: DamengConn,
    log: Callable[[str], None] | None = None,
    *,
    time_floor: datetime | None = None,
) -> dict[str, int]:
    """按压测标记清理写入残留。

    大表禁止 COUNT(*)。满密档写入落在读窗之后：对大气/raw 附加时间下界，
    走 upload_time / topic+time 索引，避免对 2 亿+ 造数行做 quality/topic 全表扫。
    """
    emit = log or (lambda _m: None)
    floor_note = (
        f"，时间≥{_ts_literal(time_floor)}"
        if time_floor is not None
        else "（未给时间下界，大表探活可能很慢）"
    )
    emit(f"清理达梦压测写入残留（EXISTS+分批删除，跳过 COUNT{floor_note}）…")
    deleted: dict[str, int] = {}
    t_all = time.perf_counter()
    for table, mark_where, time_col, index_name in _WRITE_CLEANUP:
        t0 = time.perf_counter()
        where = mark_where
        if time_floor is not None and time_col:
            where = f"{where} AND {time_col} >= {_ts_literal(time_floor)}"
        hint = f"/*+ INDEX({table} {index_name}) */ " if index_name and time_floor is not None else ""
        if not _dm_exists(
            conn, f"SELECT {hint}1 FROM {table} WHERE {where} AND ROWNUM <= 1"
        ):
            deleted[table] = 0
            emit(f"  {table}: 无残留 ({_step_ms(t0)})")
            continue
        removed = 0
        while True:
            run_dm_script(
                conn,
                f"""
                DELETE FROM {table}
                WHERE ROWID IN (
                    SELECT {hint}ROWID FROM {table} WHERE {where} AND ROWNUM <= 50000
                );
                """,
            )
            still = _dm_exists(
                conn, f"SELECT {hint}1 FROM {table} WHERE {where} AND ROWNUM <= 1"
            )
            if still:
                removed += 50000
                continue
            removed = removed + 1 if removed == 0 else removed
            break
        deleted[table] = removed
        emit(f"  {table}: 已清理约 {removed} 行 ({_step_ms(t0)})")
    emit(f"清理完成 ({_step_ms(t_all)})")
    return deleted


def _load_atmosphere_device_addrs(config_dir: Path | None = None, limit: int = 5) -> list[str]:
    """造数配置里的电场仪地址（避免大表 DISTINCT）。"""
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    with (root / "mine-sites.yaml").open(encoding="utf-8") as f:
        mine_cfg = yaml.safe_load(f) or {}
    addrs: list[str] = []
    for item in mine_cfg.get("atmosphere_devices") or []:
        addr = str(item.get("device_addr") or "").strip()
        if addr:
            addrs.append(addr)
        if len(addrs) >= limit:
            break
    return addrs


def _dm_exists(conn: DamengConn, sql: str) -> bool:
    rows = dm_fetch_all(conn, sql)
    return bool(rows)


def _step_ms(started: float) -> str:
    return f"{(time.perf_counter() - started) * 1000:.0f}ms"


def resolve_context_dameng(
    conn: DamengConn,
    *,
    config_dir: Path | None = None,
    log: Callable[[str], None] | None = None,
    scenarios: list[str] | None = None,
    stage: str | None = None,
    device_limit_override: int | None = None,
) -> BenchContext:
    """
    解析压测上下文（设备/过程窗/跳过标志）。

    大表禁止 COUNT/DISTINCT/MAX：设备来自 mine-sites；时间窗用过程 data_window；
    有无数据用 EXISTS；可按 scenarios 跳过无关探活。
    """
    emit = log or (lambda _m: None)
    selected = [str(s) for s in (scenarios or [])]
    need_atm = (not selected) or any(
        s in {"PERF-01", "PERF-04", "PERF-05", "PERF-05-AGG", "PERF-05-1MIN"}
        or s.startswith("PERF-05")
        for s in selected
    )
    need_raw = (not selected) or any(s in {"PERF-02"} for s in selected)
    need_lightning = (not selected) or any(
        s in {"PERF-03", "PERF-06"} or str(s).startswith("PERF-06") for s in selected
    )

    emit("解析压测上下文（快速模式：跳过全表 COUNT/DISTINCT/MAX）…")
    t0 = time.perf_counter()

    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    bench_cfg = _load_config(root)
    device_limit = resolve_bench_device_limit(
        bench_cfg.get("scenarios") or {},
        selected,
        stage=stage,
        config_dir=config_dir,
        device_limit_override=device_limit_override,
    )
    device_addrs = expand_bench_device_addrs(
        _load_atmosphere_device_addrs(config_dir, limit=max(device_limit, 5)),
        device_limit,
    )
    if not device_addrs:
        raise RuntimeError("mine-sites.yaml 未配置 atmosphere_devices")
    # 读写一致：曲线查询与写入轮转共用同一设备池
    curve_addrs = resolve_curve_device_addrs(device_addrs)
    src = "页面指定" if device_limit_override is not None else "档位/场景"
    emit(f"  [1/4] 配置设备 {len(device_addrs)} 台（读写同池 · {src}）({_step_ms(t0)})")

    # 过程窗：小表，优先取；PERF-04 时间窗直接复用过程窗末尾，避免大表 MAX
    t1 = time.perf_counter()
    proc_rows = dm_fetch_all(
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
    )
    if not proc_rows:
        raise RuntimeError("缺少 thunderstorm_process，请先造数")
    proc = proc_rows[0]
    dw_start = proc[4] or proc[2]
    dw_end = proc[5] or proc[3]
    if dw_start is None or dw_end is None:
        raise RuntimeError("雷暴过程缺少 data_window 或 strike 时间窗")
    query_end = dw_end if isinstance(dw_end, datetime) else datetime.now()
    query_start = query_end - timedelta(hours=24)
    query_start, query_end = _maybe_force_cross_month_query_window(
        config_dir, stage, query_start, query_end
    )
    # PERF-05* 过程窗截到 2h；PERF-04 等仍用上面未截断的 query_* 
    dw_start, dw_end = clip_process_data_window(dw_start, dw_end)
    emit(f"  [2/4] 过程 id={proc[0]} ({_step_ms(t1)})")

    atmosphere_count = 0
    if need_atm:
        t2 = time.perf_counter()
        probe_addr = format_dm_literal(device_addrs[0])
        has_atm = _dm_exists(
            conn,
            f"""
            SELECT /*+ INDEX({BIZ_ATMOSPHERE_TABLE} idx_biz_atm_field_addr_time) */ 1
            FROM {BIZ_ATMOSPHERE_TABLE}
            WHERE device_addr = {probe_addr}
              AND ROWNUM <= 1
            """,
        )
        if not has_atm:
            raise RuntimeError(
                f"库内无大气电场 biz 数据（已检查 device_addr={device_addrs[0]}），请先完成造数"
            )
        atmosphere_count = 1
        emit(f"  [3/4] 大气探活 ok ({_step_ms(t2)})")
    else:
        emit("  [3/4] 跳过大气探活（当前场景不需要）")

    t3 = time.perf_counter()
    has_raw = True
    has_lightning = True
    if need_raw:
        has_raw = _dm_exists(conn, "SELECT 1 FROM raw_kafka_message WHERE ROWNUM <= 1")
    if need_lightning:
        has_lightning = _dm_exists(
            conn, "SELECT 1 FROM biz_lightning_event WHERE ROWNUM <= 1"
        )
    raw_count = 1 if has_raw else 0
    lightning_count = 1 if has_lightning else 0
    raw_label = ("有" if has_raw else "无") if need_raw else "跳过"
    ln_label = ("有" if has_lightning else "无") if need_lightning else "跳过"
    emit(
        f"  [4/4] raw={raw_label} 闪电={ln_label} ({_step_ms(t3)})；"
        f"上下文合计 {_step_ms(t0)}"
    )

    write_ts_base = _resolve_write_ts_base(config_dir, stage, query_end)
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
        write_ts_base=write_ts_base,
        curve_device_addrs=curve_addrs,
    )


def _dm_geo_filter(lon: float, lat: float, mode: str | None = None) -> str:
    """
    PERF-06 空间过滤。默认 GeomToGeog + ST_DWithin（geog_only）；
    mode=bbox_geog 时返回扁平 bbox+ST_DWithin（诊断用）；压测 SQL 见 _sql_perf06_*。
    """
    resolved = normalize_perf06_geo_mode(mode)
    if resolved == "bbox_geog":
        return dm_within_50km_from_point_relaxed_bbox_dwithin_sql(lon, lat)
    return dm_within_50km_from_point_sql(lon, lat)


# 达梦：同一语句含 ST_DWithin 时优化器常忽略复合索引、只走 strike_time。
# bbox_geog 改为 INDEX(cover) + Haversine≤50km（本库样本与 ST_DWithin 计数一致）。
# bbox_then_dwithin：真两段（禁止同句/子查询）——
#   1) INSERT GTT：时间窗+bbox，INDEX(cover)，只取 ROWID（二级索引叶子自带，免为拿 id 回表）
#   2) JOIN GTT + ST_DWithin 精筛（精确椭球；候选再多也不拼巨型 IN 列表）
_PERF06_BBOX_INDEX_HINT = (
    "/*+ INDEX(biz_lightning_event idx_biz_lightning_perf06_cover) */"
)
_PERF06_TWO_PHASE_MARK = "--__PERF06_TWO_PHASE__"
_PERF06_CAND_GTT = "perf06_cand_rowid"


def _perf06_strike_time_pred(ctx: BenchContext) -> str:
    return (
        f"l.strike_time >= {_ts_literal(ctx.process_strike_start)} "
        f"AND l.strike_time < {_ts_literal(ctx.process_strike_end)}"
    )


def _perf06_bbox_pred(ctx: BenchContext) -> str:
    return dm_bbox_prefilter_for_point(ctx.lon, ctx.lat)


def _perf06_bbox_haversine_pred(ctx: BenchContext) -> str:
    hav = dm_haversine_meters_sql(
        "l.longitude",
        "l.latitude",
        f"{ctx.lon:.8f}",
        f"{ctx.lat:.8f}",
    )
    return f"{_perf06_bbox_pred(ctx)} AND {hav} <= 50000"


def _perf06_dwithin_pred(ctx: BenchContext) -> str:
    """与 geog_only 相同的椭球 50km 谓词（含 lightning_point IS NOT NULL）。"""
    return dm_within_50km_from_point_sql(ctx.lon, ctx.lat)


def _discard_cursor_result(cur: Any) -> None:
    """DML/DDL 后尽量清掉结果集，避免影响下一次 execute。"""
    try:
        cur.fetchall()
    except Exception:
        pass


def _prepare_perf06_cand_gtt(cur: Any) -> None:
    """
    会话级 GTT：结构全局一次创建，数据按会话隔离。
    ON COMMIT PRESERVE ROWS：读场景 autocommit=True 时仍能跨语句保留候选。
    每次压测 op 开头 DELETE 清空本会话旧候选。
    """
    try:
        cur.execute(f"DELETE FROM {_PERF06_CAND_GTT}")
        _discard_cursor_result(cur)
        return
    except Exception:
        pass
    try:
        cur.execute(
            f"""
            CREATE GLOBAL TEMPORARY TABLE {_PERF06_CAND_GTT} (
                rid ROWID
            ) ON COMMIT PRESERVE ROWS
            """
        )
        _discard_cursor_result(cur)
    except Exception:
        # 并发 worker 可能已建好表结构
        pass
    cur.execute(f"DELETE FROM {_PERF06_CAND_GTT}")
    _discard_cursor_result(cur)


def _perf06_phase1_insert_rowid_sql(ctx: BenchContext) -> str:
    """第 1 段：bbox 候选 ROWID 写入 GTT（与精筛分开执行，避免优化器合并）。"""
    return f"""
    INSERT INTO {_PERF06_CAND_GTT} (rid)
    SELECT {_PERF06_BBOX_INDEX_HINT} l.ROWID
    FROM biz_lightning_event l
    WHERE {_perf06_strike_time_pred(ctx)}
      AND {_perf06_bbox_pred(ctx)}
    """.strip()


def _perf06_two_phase_sql(phase1: str, phase2: str) -> str:
    return f"{phase1.strip()}\n{_PERF06_TWO_PHASE_MARK}\n{phase2.strip()}"


def _split_perf06_two_phase_sql(sql: str) -> tuple[str, str] | None:
    if _PERF06_TWO_PHASE_MARK not in sql:
        return None
    phase1, phase2 = sql.split(_PERF06_TWO_PHASE_MARK, 1)
    return phase1.strip(), phase2.strip()


def _perf06_phase2_join_pred() -> str:
    return f"INNER JOIN {_PERF06_CAND_GTT} t ON l.ROWID = t.rid"


def _sql_perf01(ctx: BenchContext, worker: int, seq: int) -> str:
    addr = ctx.device_addrs[seq % len(ctx.device_addrs)]
    base = ctx.write_ts_base or ctx.query_end
    ts = base + timedelta(seconds=(seq % 3600) + 1)
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
    base = ctx.write_ts_base or ctx.query_end
    ts = base + timedelta(seconds=(seq % 1800) + 1)
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
    in_list = ", ".join(format_dm_literal(a) for a in bench_curve_device_addrs(ctx))
    return f"""
    SELECT device_addr, device_upload_time, instantaneous_value, average_value,
           warning_level, rate_change, risk_level
    FROM {BIZ_ATMOSPHERE_TABLE}
    WHERE device_addr IN ({in_list})
      AND device_upload_time >= {_ts_literal(ctx.process_data_window_start)}
      AND device_upload_time < {_ts_literal(ctx.process_data_window_end)}
    ORDER BY device_addr, device_upload_time
    """


def _perf05_agg_bucket_expr(bucket_minutes: int) -> str:
    """达梦时间桶表达式。1 分钟用 TRUNC(...,'MI')；其余用小时截断+分钟整除。"""
    bucket = normalize_perf05_agg_bucket_minutes(bucket_minutes)
    if bucket == 1:
        return "TRUNC(device_upload_time, 'MI')"
    return (
        "TRUNC(device_upload_time, 'HH24') "
        f"+ (FLOOR(TO_NUMBER(TO_CHAR(device_upload_time, 'MI')) / {bucket}) * {bucket}) / 1440"
    )


def _sql_perf05_agg(ctx: BenchContext, worker: int, seq: int) -> str:
    """
    过程窗内只按时间桶聚合（跨设备合成一条曲线，不 GROUP BY device_addr）。
    走瘦覆盖索引 idx_biz_atm_field_agg_cover；1 分钟桶用 TRUNC('MI')。
    WHERE 仍按 curve_device_addrs 过滤，扫描量随台数变，结果行≈时间桶数。
    """
    in_list = ", ".join(format_dm_literal(a) for a in bench_curve_device_addrs(ctx))
    bucket = normalize_perf05_agg_bucket_minutes(ctx.perf05_agg_bucket_minutes)
    bucket_expr = _perf05_agg_bucket_expr(bucket)
    return f"""
    SELECT /*+ INDEX(biz_atmosphere_electric_field_event idx_biz_atm_field_agg_cover) */
           {bucket_expr} AS device_upload_time,
           AVG(instantaneous_value) AS instantaneous_value,
           AVG(average_value) AS average_value,
           MAX(warning_level) AS warning_level,
           AVG(rate_change) AS rate_change,
           MAX(risk_level) AS risk_level,
           COUNT(*) AS point_count
    FROM {BIZ_ATMOSPHERE_TABLE}
    WHERE device_addr IN ({in_list})
      AND device_upload_time >= {_ts_literal(ctx.process_data_window_start)}
      AND device_upload_time < {_ts_literal(ctx.process_data_window_end)}
    GROUP BY {bucket_expr}
    ORDER BY device_upload_time
    """


def _sql_perf05_agg_mv(ctx: BenchContext, worker: int, seq: int) -> str:
    """对照：读物化视图 biz_atm_field_agg_1min（需库内已建；与 PG 对照场景同名）。"""
    del worker, seq
    return f"""
    SELECT bucket_time AS device_upload_time,
           avg_inst AS instantaneous_value,
           avg_avg AS average_value,
           max_warning_level AS warning_level,
           avg_rate_change AS rate_change,
           max_risk_level AS risk_level,
           point_count
    FROM biz_atm_field_agg_1min
    WHERE bucket_time >= {_ts_literal(ctx.process_data_window_start)}
      AND bucket_time < {_ts_literal(ctx.process_data_window_end)}
    ORDER BY bucket_time
    """


def _sql_perf05_1min(ctx: BenchContext, worker: int, seq: int) -> str:
    """单台设备、过程窗开头连续 1 分钟的秒级明细（与多台曲线查询区分）。"""
    addrs = bench_curve_device_addrs(ctx)
    addr = addrs[worker % len(addrs)]
    win_start, win_end = _perf05_one_minute_window(ctx, worker, seq)
    return f"""
    SELECT device_addr, device_upload_time, instantaneous_value, average_value,
           warning_level, rate_change, risk_level
    FROM {BIZ_ATMOSPHERE_TABLE}
    WHERE device_addr = {format_dm_literal(addr)}
      AND device_upload_time >= {_ts_literal(win_start)}
      AND device_upload_time < {_ts_literal(win_end)}
    ORDER BY device_upload_time
    """


def _sql_perf06_count(ctx: BenchContext, worker: int, seq: int) -> str:
    del worker, seq
    mode = normalize_perf06_geo_mode(getattr(ctx, "perf06_geo_mode", None))
    if mode == "bbox_geog":
        return f"""
        SELECT {_PERF06_BBOX_INDEX_HINT} count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_bbox_haversine_pred(ctx)}
        """
    if mode == "bbox_then_dwithin":
        phase2 = f"""
        SELECT count(*) AS lightning_count
        FROM biz_lightning_event l
        {_perf06_phase2_join_pred()}
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_dwithin_pred(ctx)}
        """
        return _perf06_two_phase_sql(_perf06_phase1_insert_rowid_sql(ctx), phase2)
    geo = _dm_geo_filter(ctx.lon, ctx.lat, mode)
    return f"""
    SELECT count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE {_perf06_strike_time_pred(ctx)}
      AND {geo}
    """


def _sql_perf06_source_dist(ctx: BenchContext, worker: int, seq: int) -> str:
    del worker, seq
    mode = normalize_perf06_geo_mode(getattr(ctx, "perf06_geo_mode", None))
    if mode == "bbox_geog":
        return f"""
        SELECT {_PERF06_BBOX_INDEX_HINT} l.source_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_bbox_haversine_pred(ctx)}
        GROUP BY l.source_type
        """
    if mode == "bbox_then_dwithin":
        phase2 = f"""
        SELECT l.source_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        {_perf06_phase2_join_pred()}
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_dwithin_pred(ctx)}
        GROUP BY l.source_type
        """
        return _perf06_two_phase_sql(_perf06_phase1_insert_rowid_sql(ctx), phase2)
    geo = _dm_geo_filter(ctx.lon, ctx.lat, mode)
    return f"""
    SELECT l.source_type, count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE {_perf06_strike_time_pred(ctx)}
      AND {geo}
    GROUP BY l.source_type
    """


def _sql_perf06_type_dist(ctx: BenchContext, worker: int, seq: int) -> str:
    del worker, seq
    mode = normalize_perf06_geo_mode(getattr(ctx, "perf06_geo_mode", None))
    if mode == "bbox_geog":
        return f"""
        SELECT {_PERF06_BBOX_INDEX_HINT} l.lightning_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_bbox_haversine_pred(ctx)}
        GROUP BY l.lightning_type
        """
    if mode == "bbox_then_dwithin":
        phase2 = f"""
        SELECT l.lightning_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        {_perf06_phase2_join_pred()}
        WHERE {_perf06_strike_time_pred(ctx)}
          AND {_perf06_dwithin_pred(ctx)}
        GROUP BY l.lightning_type
        """
        return _perf06_two_phase_sql(_perf06_phase1_insert_rowid_sql(ctx), phase2)
    geo = _dm_geo_filter(ctx.lon, ctx.lat, mode)
    return f"""
    SELECT l.lightning_type, count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE {_perf06_strike_time_pred(ctx)}
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
    "PERF-05-AGG-MV": _sql_perf05_agg_mv,
    "PERF-05-1MIN": _sql_perf05_1min,
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
        sql = builder(ctx, 0, 0).strip()
    except Exception:
        return ""
    if scenario_id.startswith("PERF-06"):
        mode = normalize_perf06_geo_mode(getattr(ctx, "perf06_geo_mode", None))
        return f"-- perf06_geo_mode={mode}\n{sql}"
    return sql


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
    latency_stats: LatencyStats,
    errors: list[str],
    metrics_lock: threading.Lock,
    *,
    stop_event: threading.Event,
    error_abort_threshold: int,
    min_interval_sec: float = 0.0,
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
                        latency_stats.add(elapsed_ms)
            else:
                if last_exc is not None:
                    prefix = "abort" if is_warmup else "seq"
                    record_error(f"worker={worker_idx} {prefix}={seq}: {last_exc}")
                    if isinstance(last_exc, TimeoutError) or _is_transient_dm_error(last_exc):
                        exit_worker = True
                    if exit_worker:
                        break

            if min_interval_sec > 0:
                remain = min_interval_sec - (time.perf_counter() - t0)
                if remain > 0:
                    time.sleep(remain)
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
    iters = resolve_scenario_iterations(cfg, defaults, iterations)
    warmup = int(defaults.get("warmup", 5))
    pace_sec = resolve_write_pace_interval_sec(cfg, conc) if kind == "write" else 0.0
    name = (
        perf05_agg_scenario_name(ctx.perf05_agg_bucket_minutes)
        if scenario_id == "PERF-05-AGG"
        else str(cfg.get("name", scenario_id))
    )
    p95_limit = cfg.get("p95_limit_ms")
    p99_limit = cfg.get("p99_limit_ms", p95_limit * 2 if p95_limit else None)

    pace_note = f"，目标≈{cfg.get('target_tps')} TPS" if pace_sec > 0 else ""
    if kind == "write":
        device_note = f"，设备 {len(ctx.device_addrs)} 台"
    elif scenario_id == "PERF-05-1MIN":
        device_note = (
            f"，每次 1 台（池内 {len(bench_curve_device_addrs(ctx))} 台轮转）"
        )
    elif scenario_id == "PERF-05-AGG-MV":
        device_note = "，读物化视图 biz_atm_field_agg_1min（全库分钟预聚合）"
    elif scenario_id in ("PERF-05", "PERF-05-AGG"):
        device_note = f"，设备 {len(bench_curve_device_addrs(ctx))} 台（与写入同池）"
    else:
        device_note = ""
    emit(f"[{scenario_id}] {name} — 并发 {conc} × {iters} 次（达梦 dmPython）{pace_note}{device_note}")
    if scenario_id in ("PERF-05", "PERF-05-AGG") and conc >= 10 and len(bench_curve_device_addrs(ctx)) >= 30:
        emit(
            "  WARN: 高并发×多设备过程窗聚合易打满客户端内存（曾见 exitcode=-9/SIGKILL）；"
            "若子进程被杀请先把查询并发降到 5～8 或设备降到 ≤20 验证"
        )
    started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    latency_stats = LatencyStats(slow_threshold_ms=slow_sql_threshold_ms)
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
    stagger = _worker_start_stagger_sec(scenario_id)
    for w in range(conc):
        t = threading.Thread(
            target=_worker_dm,
            args=(conn, scenario_id, kind, ctx, iters, warmup, w, latency_stats, errors, metrics_lock),
            kwargs={
                "stop_event": stop_event,
                "error_abort_threshold": error_abort_threshold,
                "min_interval_sec": pace_sec,
            },
            daemon=True,
        )
        threads.append(t)
        t.start()
        # 错开建连，避免 20 线程同时 connect 触发 -70028；重查询再拉长一点压峰值
        if w + 1 < conc and stagger > 0:
            time.sleep(stagger)

    progress_stop = threading.Event()

    def _progress_loop() -> None:
        while not progress_stop.wait(15.0):
            with metrics_lock:
                done = len(latency_stats)
                err_n = len(errors)
            if done <= 0 and err_n <= 0:
                emit(f"  … {scenario_id} 仍在首波查询（已跑 {time.perf_counter() - t0:.0f}s）")
            else:
                emit(
                    f"  … {scenario_id} 进度 {done}/{total_ops}"
                    f"（错误 {err_n}，已跑 {time.perf_counter() - t0:.0f}s）"
                )

    progress_thread = threading.Thread(target=_progress_loop, daemon=True)
    progress_thread.start()
    join_deadline = time.perf_counter() + scenario_timeout_sec
    for t in threads:
        remaining = join_deadline - time.perf_counter()
        if remaining <= 0:
            stop_event.set()
            break
        t.join(timeout=remaining)
    progress_stop.set()
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

    success = len(latency_stats)
    total = total_ops
    if stop_event.is_set() and errors and not any("scenario timeout" in e for e in errors):
        emit(
            f"  WARN: 错误数≥{error_abort_threshold}，已提前结束 worker（避免 -70019 连锁）"
        )
    avg = latency_stats.avg_ms()
    p50, p95, p99 = latency_stats.percentiles()
    if latency_stats.capped:
        emit(
            f"  … 耗时样本蓄水池上限 {latency_stats._cap}，"
            f"正式成功 {success} 次（分位基于抽样，慢SQL计数仍精确）"
        )
    tps = success / duration if duration > 0 else 0.0
    latency_values = latency_stats.values_for_analysis()
    slow_bench, slow_dm = resolve_scenario_slow_sql(
        conn,
        started_at=started_at,
        finished_at=finished_at,
        latencies=latency_values,
        threshold_ms=slow_sql_threshold_ms,
        log=emit,
        warned_native=slow_sql_warned,
        bench_slow_count=latency_stats.slow_count,
    )
    sql_preview = sql_preview_for_scenario(scenario_id, ctx)
    slow_details = collect_scenario_slow_sql_details(
        conn,
        started_at=started_at,
        finished_at=finished_at,
        latencies=latency_values,
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
        if pace_sec > 0:
            note += f" · 控速≈{cfg.get('target_tps')} TPS"
        if cfg.get("device_limit"):
            note += f" · 设备轮转 {len(ctx.device_addrs)} 台"
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
        min_ms=latency_stats.min_ms if success else 0.0,
        max_ms=latency_stats.max_ms if success else 0.0,
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
    # Web 压测在 ThreadingHTTPServer 工作线程里启动场景：fork 多线程进程不安全，
    # 且会短暂放大 RSS；默认 spawn。可用 DM_BENCH_MP_START=fork 覆盖。
    default_method = "spawn"
    method = os.environ.get("DM_BENCH_MP_START", default_method).strip() or default_method
    try:
        return mp.get_context(method)
    except ValueError:
        return mp.get_context(default_method)


def _format_scenario_process_exit_error(exit_code: int | None) -> str:
    """把子进程异常退出码转成可操作的说明（-9 多为 OOM/SIGKILL）。"""
    if exit_code == -9:
        return (
            "scenario process exited without result (exitcode=-9 / SIGKILL；"
            "常见原因：容器或宿主机 OOM。建议：降低「查询并发」或「设备台数」、"
            "减小查询次数、提高 Docker 内存，或设 DM_BENCH_ARRAYSIZE=200)"
        )
    if exit_code == -15:
        return (
            "scenario process exited without result (exitcode=-15 / SIGTERM；"
            "进程被外部终止)"
        )
    return f"scenario process exited without result (exitcode={exit_code})"


def _worker_start_stagger_sec(scenario_id: str) -> float:
    """重查询错开建连/首波 execute，压低瞬时内存与连接风暴。"""
    env_raw = os.environ.get("DM_BENCH_WORKER_STAGGER_SEC")
    if env_raw is not None and str(env_raw).strip():
        try:
            return max(0.0, min(2.0, float(env_raw)))
        except ValueError:
            pass
    if scenario_id in ("PERF-05", "PERF-05-AGG", "PERF-05-1MIN"):
        return 0.15
    return 0.05


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
    iters = resolve_scenario_iterations(cfg, defaults, iterations)
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
    error = _format_scenario_process_exit_error(exit_code)
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
    perf06_geo: str | None = None,
    device_limit: int | None = None,
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
        else defaults.get("perf05_agg_bucket_minutes", 1)
    )
    geo_mode = normalize_perf06_geo_mode(
        perf06_geo if perf06_geo is not None else defaults.get("perf06_geo")
    )
    scenario_cfgs = bench_cfg.get("scenarios", {})
    selected = normalize_scenario_ids(scenarios) or list(SCENARIO_ORDER)
    emit = log or (lambda _m: None)

    assert_no_load_in_progress(conn, "执行 SQL 压测")
    emit(f"压测模式: 达梦直连 SQL stage={stage} schema={conn.schema}")
    emit(
        f"慢SQL阈值: ≥{int(slow_ms)}ms（样本=客户端耗时；库内=V$SQL_HISTORY 场景时间窗）"
    )
    emit(f"PERF-05-AGG 聚合间隔: {agg_bucket} 分钟")
    emit(
        f"PERF-06 空间模式: {geo_mode}"
        + (
            "（INDEX cover + 60km bbox + Haversine≤50km）"
            if geo_mode == "bbox_geog"
            else "（两段 GTT：bbox→ROWID→JOIN+ST_DWithin）"
            if geo_mode == "bbox_then_dwithin"
            else "（GeomToGeog + ST_DWithin）"
        )
    )
    slow_sql_warned = [False]
    # 只读场景（如仅 PERF-06）跳过清理：大表按标记探活无索引时仍可能扫很久
    need_write_cleanup = any(
        sid in scenario_cfgs and _is_write_scenario(scenario_cfgs[sid])
        for sid in selected
    )
    # 先解析写入时间锚点，供清理走时间索引（避免大气表全表扫）
    write_floor = _bench_cleanup_time_floor(root, stage)
    if need_write_cleanup:
        cleanup_bench_writes_dameng(conn, log=emit, time_floor=write_floor)
    else:
        emit("跳过压测写入清理（当前均为只读场景）")
    if device_limit is not None:
        emit(f"设备台数（页面）: {int(device_limit)}")
    ctx = resolve_context_dameng(
        conn,
        config_dir=root,
        log=emit,
        scenarios=selected,
        stage=stage,
        device_limit_override=device_limit,
    )
    ctx.perf05_agg_bucket_minutes = agg_bucket
    ctx.perf06_geo_mode = geo_mode
    emit(
        f"数据快照: 已探活（跳过全表COUNT/MAX）；"
        f"设备={len(ctx.device_addrs)}台（读写同池） "
        f"过程id={ctx.process_id}"
    )
    if ctx.write_ts_base and ctx.write_ts_base != ctx.query_end:
        emit(
            f"写入时间锚点: {ctx.write_ts_base.isoformat(sep=' ', timespec='seconds')} "
            f"（读窗之后，避免与满密造数叠秒）"
        )
    emit(
        f"PERF-04 查询窗: {ctx.query_start.isoformat(sep=' ', timespec='seconds')} ~ "
        f"{ctx.query_end.isoformat(sep=' ', timespec='seconds')}"
    )

    results: list[ScenarioResult] = []
    pending_write = False
    for sid in selected:
        if sid not in scenario_cfgs:
            raise ValueError(f"未知场景: {sid}")
        cfg = apply_write_pace_from_devices(scenario_cfgs[sid], len(ctx.device_addrs))
        scenario_iterations = iterations
        if scenario_iterations is None:
            if _is_read_scenario(cfg):
                scenario_iterations = query_iterations
                if scenario_iterations is None and defaults.get("query_iterations") is not None:
                    scenario_iterations = int(defaults["query_iterations"])
            elif _is_write_scenario(cfg):
                scenario_iterations = write_iterations
        if scenario_iterations is None and cfg.get("iterations") is not None:
            scenario_iterations = int(cfg["iterations"])

        if _is_read_scenario(cfg) and pending_write:
            cleanup_bench_writes_dameng(
                conn,
                log=emit,
                time_floor=ctx.write_ts_base or write_floor,
            )
            pending_write = False
        if sid == "PERF-02" and ctx.raw_count == 0:
            emit(f"[{sid}] 跳过：无 raw 数据")
            continue
        if sid in ("PERF-03", "PERF-06") and ctx.lightning_count == 0:
            emit(f"[{sid}] 跳过：无闪电数据")
            continue

        if sid == "PERF-06" and cfg.get("compound"):
            emit("[PERF-06] 达梦 compound：count / source_dist / type_dist 三个子场景顺序执行（非 SQL 子查询）")
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
        cleanup_bench_writes_dameng(
            conn, log=emit, time_floor=ctx.write_ts_base or write_floor
        )

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
            "perf06Geo": geo_mode,
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
