"""直连 PostgreSQL 的 SQL 压测（PERF-01～06）。

不经 Gateway/API，不经过应用解析与 Kafka 消费链路；写入场景 INSERT+COMMIT（含 WAL 提交），
压测前后按标记清理落库行，避免污染造数数据与查询场景结果。
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg2
import yaml

from generators.db import build_dsn, pg_connection
from generators.load_guard import assert_no_load_in_progress
from generators.resource_collect import ConnPeakSampler, ScenarioSlowSqlTracker

SCENARIO_ORDER = ("PERF-01", "PERF-02", "PERF-03", "PERF-04", "PERF-05", "PERF-05-AGG", "PERF-06")

# 大气查询场景走业务层（与展示/列表 API 一致）
BIZ_ATMOSPHERE_TABLE = "biz_atmosphere_electric_field_event"

# 压测写入标记（清理时按字段删除，勿与造数字段混淆）
BENCH_QUALITY_STATUS = "PERF_BENCH"
BENCH_RAW_TOPIC = "perf-sql-bench"
BENCH_LIGHTNING_SOURCE = "PERF_BENCH"

_WRITE_CLEANUP_SPECS: tuple[tuple[str, str, tuple[Any, ...]], ...] = (
    ("standard_atmosphere_electric_field", "quality_status = %s", (BENCH_QUALITY_STATUS,)),
    ("raw_kafka_message", "topic = %s", (BENCH_RAW_TOPIC,)),
    ("biz_lightning_event", "source_type = %s", (BENCH_LIGHTNING_SOURCE,)),
)


@dataclass
class BenchContext:
    mine_code: str
    lon: float
    lat: float
    device_addrs: list[str]
    query_start: datetime
    query_end: datetime
    process_id: int
    process_strike_start: datetime
    process_strike_end: datetime
    process_data_window_start: datetime
    process_data_window_end: datetime
    atmosphere_count: int
    raw_count: int
    lightning_count: int
    perf05_agg_bucket_minutes: int = 10


def normalize_perf05_agg_bucket_minutes(value: int | float | str | None) -> int:
    """PERF-05-AGG 时间桶宽度（分钟），默认 10。"""
    if value is None:
        return 10
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return 10
    return max(1, min(60, n))


def perf05_agg_scenario_name(bucket_minutes: int | None = None) -> str:
    bucket = normalize_perf05_agg_bucket_minutes(bucket_minutes)
    return f"多电场仪雷暴过程窗曲线查询（{bucket}分钟聚合）"


@dataclass
class ScenarioResult:
    id: str
    name: str
    kind: str
    stage: str
    concurrency: int
    iterations: int
    total_ops: int
    success_ops: int
    error_count: int
    errors: list[str] = field(default_factory=list)
    avg_ms: float = 0.0
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    min_ms: float = 0.0
    max_ms: float = 0.0
    tps: float = 0.0
    duration_sec: float = 0.0
    p95_limit_ms: int | None = None
    p99_limit_ms: int | None = None
    passed: bool | None = None
    note: str = ""
    started_at: str = ""
    finished_at: str = ""
    conn_peak: int = 0
    slow_sql_count: int = -1
    slow_sql_threshold_ms: float = 500.0
    compound: bool = False
    sub_queries: dict[str, dict[str, Any]] = field(default_factory=dict)

    def to_section11_4(self) -> dict[str, Any]:
        row: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "stage": self.stage,
            "concurrency": str(self.concurrency),
            "executions": str(self.total_ops),
            "successOps": str(self.success_ops),
            "errorCount": str(self.error_count),
            "successRate": f"{(self.success_ops / self.total_ops * 100):.1f}%" if self.total_ops else "—",
            "avgMs": f"{self.avg_ms:.1f}",
            "p95": f"{self.p95_ms:.1f}",
            "p99": f"{self.p99_ms:.1f}",
            "p95LimitMs": self.p95_limit_ms,
            "p99LimitMs": self.p99_limit_ms,
            "tps": f"{self.tps:.1f}",
            "passed": self.passed,
            "note": self.note or "直连 SQL（不经 API/解析）",
        }
        if self.compound and self.sub_queries:
            row["compound"] = True
            row["subQueries"] = self.sub_queries
        return row


def _load_config(config_dir: Path) -> dict[str, Any]:
    path = config_dir / "sql-bench.yaml"
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * pct / 100.0
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return ordered[lo]
    return ordered[lo] * (hi - rank) + ordered[hi] * (rank - lo)


def resolve_context(dsn: str, schema: str = "perf") -> BenchContext:
    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {schema}.{BIZ_ATMOSPHERE_TABLE}")
            atmosphere_count = int(cur.fetchone()[0])
            if atmosphere_count == 0:
                raise RuntimeError("库内无大气电场 biz 数据，请先完成造数")

            cur.execute(
                f"""
                SELECT DISTINCT device_addr
                FROM {schema}.{BIZ_ATMOSPHERE_TABLE}
                ORDER BY device_addr
                LIMIT 5
                """
            )
            device_addrs = [r[0] for r in cur.fetchall()]
            if not device_addrs:
                raise RuntimeError("无法解析 device_addr")

            cur.execute(
                f"""
                SELECT min(device_upload_time), max(device_upload_time)
                FROM {schema}.{BIZ_ATMOSPHERE_TABLE}
                """
            )
            tmin, tmax = cur.fetchone()
            query_end = tmax or datetime.now()
            query_start = max(tmin, query_end - timedelta(hours=24)) if tmin else query_end - timedelta(hours=24)

            cur.execute(
                f"""
                SELECT p.id, p.mine_code, p.strike_start_time, p.strike_end_time,
                       p.data_window_start, p.data_window_end,
                       m.dispatch_room_lon, m.dispatch_room_lat
                FROM {schema}.thunderstorm_process p
                JOIN {schema}.mine_site m ON m.mine_code = p.mine_code
                ORDER BY p.id
                LIMIT 1
                """
            )
            proc = cur.fetchone()
            if not proc:
                raise RuntimeError("缺少 thunderstorm_process，请先造数")
            dw_start = proc[4] or proc[2]
            dw_end = proc[5] or proc[3]
            if dw_start is None or dw_end is None:
                raise RuntimeError("雷暴过程缺少 data_window 或 strike 时间窗")

            cur.execute(f"SELECT count(*) FROM {schema}.raw_kafka_message")
            raw_count = int(cur.fetchone()[0])
            cur.execute(f"SELECT count(*) FROM {schema}.biz_lightning_event")
            lightning_count = int(cur.fetchone()[0])

    return BenchContext(
        mine_code=proc[1],
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


def _is_write_scenario(cfg: dict[str, Any]) -> bool:
    return str(cfg.get("kind")) == "write"


def _is_read_scenario(cfg: dict[str, Any]) -> bool:
    return str(cfg.get("kind")) == "read" or bool(cfg.get("compound"))


def _delete_bench_marked(
    cur,
    schema: str,
    table: str,
    where: str,
    params: tuple[Any, ...],
    batch_size: int = 50_000,
) -> int:
    """分批 DELETE，避免单条大 DELETE 与造数 COPY 长时间互锁。"""
    total = 0
    while True:
        cur.execute(
            f"""
            DELETE FROM {schema}.{table}
            WHERE ctid IN (
                SELECT ctid FROM {schema}.{table}
                WHERE {where}
                LIMIT %s
            )
            """,
            (*params, batch_size),
        )
        n = int(cur.rowcount)
        total += n
        cur.connection.commit()
        if n < batch_size:
            break
    return total


def cleanup_bench_writes(
    dsn: str,
    schema: str = "perf",
    log: Callable[[str], None] | None = None,
) -> dict[str, int]:
    """删除历次压测 COMMIT 落库的行（按 BENCH_* 标记，不影响造数数据）。"""
    assert_no_load_in_progress(dsn, "清理压测写入")
    emit = log or (lambda _m: None)
    deleted: dict[str, int] = {}
    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            for table, where, params in _WRITE_CLEANUP_SPECS:
                deleted[table] = _delete_bench_marked(cur, schema, table, where, params)
    parts = [f"{t} {n}行" for t, n in deleted.items() if n]
    if parts:
        emit("清理压测写入: " + ", ".join(parts))
    return deleted


def _bench_id(worker: int, seq: int) -> int:
    base = int(time.time() * 1_000_000)
    return base + worker * 10_000 + seq


def _sql_perf01(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    addr = ctx.device_addrs[seq % len(ctx.device_addrs)]
    ts = ctx.query_end - timedelta(seconds=seq % 3600)
    return (
        f"""
        INSERT INTO standard_atmosphere_electric_field (
            id, raw_message_id, device_addr, type_id, command_type, device_upload_time,
            instantaneous_value, average_value, longitude, latitude, quality_status
        ) VALUES (%s, '{{}}', %s, '01', '01', %s, 1.23, 1.20, %s, %s, %s)
        """,
        (_bench_id(worker, seq), addr, ts, ctx.lon, ctx.lat, BENCH_QUALITY_STATUS),
    )


def _sql_perf02(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    ts = ctx.query_end - timedelta(seconds=seq % 1800)
    oid = _bench_id(worker, seq)
    return (
        """
        INSERT INTO raw_kafka_message (
            id, topic, partition_no, offset_no, raw_value, source_type,
            receive_time, create_time, update_time
        ) VALUES (%s, 'perf-sql-bench', %s, %s, '{}', 'PERF_BENCH', %s, %s, %s)
        """,
        (oid, worker % 3, oid, ts, ts, ts),
    )


def _sql_perf03(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    span = max((ctx.process_strike_end - ctx.process_strike_start).total_seconds(), 1)
    ts = ctx.process_strike_start + timedelta(seconds=seq % int(span))
    lon = ctx.lon + (seq % 10) * 0.001
    lat = ctx.lat + (seq % 10) * 0.001
    return (
        """
        INSERT INTO biz_lightning_event (
            id, source_type, lightning_type, strike_time, longitude, latitude,
            lightning_point, risk_level
        ) VALUES (
            %s, 'PERF_BENCH', 'CG', %s, %s, %s,
            ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography, 0
        )
        """,
        (_bench_id(worker, seq), ts, lon, lat, lon, lat),
    )


def _sql_perf04(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    addr = ctx.device_addrs[worker % len(ctx.device_addrs)]
    offset = (seq % 20) * 50
    return (
        f"""
        SELECT id, device_upload_time, instantaneous_value, average_value,
               warning_level, risk_level, event_status
        FROM {BIZ_ATMOSPHERE_TABLE}
        WHERE device_addr = %s
          AND device_upload_time >= %s
          AND device_upload_time < %s
        ORDER BY device_upload_time DESC
        LIMIT 50 OFFSET %s
        """,
        (addr, ctx.query_start, ctx.query_end, offset),
    )


def _sql_perf05(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    return (
        f"""
        SELECT device_addr, device_upload_time, instantaneous_value, average_value,
               warning_level, rate_change, risk_level
        FROM {BIZ_ATMOSPHERE_TABLE}
        WHERE device_addr = ANY(%s)
          AND device_upload_time >= %s
          AND device_upload_time < %s
        ORDER BY device_addr, device_upload_time
        """,
        (ctx.device_addrs, ctx.process_data_window_start, ctx.process_data_window_end),
    )


def _sql_perf05_agg(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    bucket = normalize_perf05_agg_bucket_minutes(ctx.perf05_agg_bucket_minutes)
    return (
        f"""
        WITH base AS (
            SELECT
                device_addr,
                date_trunc('hour', device_upload_time)
                    + floor(extract(minute from device_upload_time) / {bucket}) * interval '{bucket} minutes'
                    AS bucket_time,
                instantaneous_value,
                average_value,
                warning_level,
                rate_change,
                risk_level
            FROM {BIZ_ATMOSPHERE_TABLE}
            WHERE device_addr = ANY(%s)
              AND device_upload_time >= %s
              AND device_upload_time < %s
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
        """,
        (ctx.device_addrs, ctx.process_data_window_start, ctx.process_data_window_end),
    )


# PERF-06：Word 方案三条 SQL，分项计时与分项 P95（count≤1000ms，分布≤1500ms）


def _sql_perf06_count(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    return (
        """
        SELECT count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE l.strike_time >= %s
          AND l.strike_time < %s
          AND l.lightning_point IS NOT NULL
          AND ST_DWithin(
                l.lightning_point,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                50000
              )
        """,
        (ctx.process_strike_start, ctx.process_strike_end, ctx.lon, ctx.lat),
    )


def _sql_perf06_source_dist(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    return (
        """
        SELECT l.source_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE l.strike_time >= %s
          AND l.strike_time < %s
          AND l.lightning_point IS NOT NULL
          AND ST_DWithin(
                l.lightning_point,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                50000
              )
        GROUP BY l.source_type
        """,
        (ctx.process_strike_start, ctx.process_strike_end, ctx.lon, ctx.lat),
    )


def _sql_perf06_type_dist(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    return (
        """
        SELECT l.lightning_type, count(*) AS lightning_count
        FROM biz_lightning_event l
        WHERE l.strike_time >= %s
          AND l.strike_time < %s
          AND l.lightning_point IS NOT NULL
          AND ST_DWithin(
                l.lightning_point,
                ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                50000
              )
        GROUP BY l.lightning_type
        """,
        (ctx.process_strike_start, ctx.process_strike_end, ctx.lon, ctx.lat),
    )


SQL_BUILDERS: dict[str, Callable[[BenchContext, int, int], tuple[str, tuple]]] = {
    "PERF-01": _sql_perf01,
    "PERF-02": _sql_perf02,
    "PERF-03": _sql_perf03,
    "PERF-04": _sql_perf04,
    "PERF-05": _sql_perf05,
    "PERF-05-AGG": _sql_perf05_agg,
}

PERF06_SUB_BUILDERS: dict[str, Callable[[BenchContext, int, int], tuple[str, tuple]]] = {
    "count": _sql_perf06_count,
    "source_dist": _sql_perf06_source_dist,
    "type_dist": _sql_perf06_type_dist,
}

PERF06_SUB_LABELS: dict[str, str] = {
    "count": "50km闪电数量",
    "source_dist": "来源类型分布",
    "type_dist": "闪电类型分布",
}


def _resolve_concurrency(
    cfg: dict[str, Any],
    stage: str,
    defaults: dict[str, Any],
    override: int | None,
    query_override: int | None = None,
) -> int:
    if override is not None:
        return override
    if cfg.get("concurrency") is not None:
        return int(cfg["concurrency"])
    if str(cfg.get("kind")) == "read" or cfg.get("compound"):
        if query_override is not None:
            return query_override
        sc = defaults.get("stage_concurrency") or {}
        if stage in ("S3", "S4"):
            return int(sc.get("query_high", 50))
        return int(sc.get("query_low", 20))
    return 1


def _worker(
    dsn: str,
    schema: str,
    scenario_id: str,
    kind: str,
    ctx: BenchContext,
    iterations: int,
    warmup: int,
    worker_idx: int,
    latencies: list[float],
    errors: list[str],
) -> None:
    builder = SQL_BUILDERS[scenario_id]
    conn = psycopg2.connect(dsn)
    conn.autocommit = kind != "write"
    try:
        for seq in range(warmup + iterations):
            is_warmup = seq < warmup
            sql, params = builder(ctx, worker_idx, seq)
            t0 = time.perf_counter()
            try:
                with conn.cursor() as cur:
                    cur.execute("SET search_path TO %s, public", (schema,))
                    cur.execute(sql, params)
                    if kind != "write":
                        cur.fetchall()
                if kind == "write":
                    conn.commit()
                if not is_warmup:
                    latencies.append((time.perf_counter() - t0) * 1000.0)
            except Exception as exc:  # noqa: BLE001
                if not conn.autocommit:
                    conn.rollback()
                if not is_warmup:
                    errors.append(f"worker={worker_idx} seq={seq}: {exc}")
    finally:
        conn.close()


def _worker_single_read(
    dsn: str,
    schema: str,
    ctx: BenchContext,
    builder: Callable[[BenchContext, int, int], tuple[str, tuple]],
    iterations: int,
    warmup: int,
    worker_idx: int,
    latencies: list[float],
    errors: list[str],
    error_tag: str = "",
) -> None:
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    tag_prefix = f"{error_tag}: " if error_tag else ""
    try:
        for seq in range(warmup + iterations):
            is_warmup = seq < warmup
            sql, params = builder(ctx, worker_idx, seq)
            t0 = time.perf_counter()
            try:
                with conn.cursor() as cur:
                    cur.execute("SET search_path TO %s, public", (schema,))
                    cur.execute(sql, params)
                    cur.fetchall()
                if not is_warmup:
                    latencies.append((time.perf_counter() - t0) * 1000.0)
            except Exception as exc:  # noqa: BLE001
                if not is_warmup:
                    errors.append(f"worker={worker_idx} seq={seq} {tag_prefix}{exc}")
    finally:
        conn.close()


def _run_compound_scenario(
    scenario_id: str,
    stage: str,
    dsn: str,
    schema: str,
    database: str,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    concurrency: int | None = None,
    query_concurrency: int | None = None,
    iterations: int | None = None,
    slow_sql_threshold_ms: float = 500.0,
    slow_sql_tracker: ScenarioSlowSqlTracker | None = None,
    log: Callable[[str], None] | None = None,
) -> ScenarioResult:
    emit = log or (lambda _m: None)
    conc = _resolve_concurrency(cfg, stage, defaults, concurrency, query_concurrency)
    iters = iterations or int(defaults.get("iterations", 50))
    warmup = int(defaults.get("warmup", 5))
    name = (
        perf05_agg_scenario_name(ctx.perf05_agg_bucket_minutes)
        if scenario_id == "PERF-05-AGG"
        else str(cfg.get("name", scenario_id))
    )
    sub_p95_limits: dict[str, int] = {
        k: int(v.get("p95_limit_ms", 1500)) for k, v in (cfg.get("sub_queries") or {}).items()
    }
    sub_p99_limits: dict[str, int] = {
        k: int(v.get("p99_limit_ms", sub_p95_limits.get(k, 1500) * 2))
        for k, v in (cfg.get("sub_queries") or {}).items()
    }
    sub_builders = [(tag, PERF06_SUB_BUILDERS[tag]) for tag in sub_p95_limits if tag in PERF06_SUB_BUILDERS]

    emit(
        f"[{scenario_id}] {name} — 并发 {conc} × {iters} 次"
        f"（Word {len(sub_builders)} 条 SQL 分阶段执行，预热 {warmup}）"
    )
    tracker = slow_sql_tracker or ScenarioSlowSqlTracker()

    latency_buckets: dict[str, list[float]] = {tag: [] for tag, _ in sub_builders}
    errors: list[str] = []
    sub_queries: dict[str, dict[str, Any]] = {}
    sub_notes: list[str] = []
    sub_pass = True
    sub_exec = conc * iters
    scenario_started_at = ""
    scenario_finished_at = ""
    total_duration = 0.0
    scenario_conn_peak = 0
    scenario_slow_sql = -1

    for tag, builder in sub_builders:
        label = PERF06_SUB_LABELS.get(tag, tag)
        emit(f"  → 子查询 {tag}（{label}）")
        tracker.begin(dsn, emit)
        phase_started = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        if not scenario_started_at:
            scenario_started_at = phase_started
        phase_latencies: list[float] = []
        phase_errors: list[str] = []
        sampler = ConnPeakSampler(dsn, database)
        sampler.start()
        phase_threads: list[threading.Thread] = []
        t_phase = time.perf_counter()
        for w in range(conc):
            t = threading.Thread(
                target=_worker_single_read,
                args=(
                    dsn,
                    schema,
                    ctx,
                    builder,
                    iters,
                    warmup,
                    w,
                    phase_latencies,
                    phase_errors,
                    tag,
                ),
                daemon=True,
            )
            phase_threads.append(t)
            t.start()
        for t in phase_threads:
            t.join()
        phase_duration = time.perf_counter() - t_phase
        total_duration += phase_duration
        phase_finished = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        scenario_finished_at = phase_finished
        conn_peak = sampler.stop()
        if conn_peak > scenario_conn_peak:
            scenario_conn_peak = conn_peak
        slow_sql_count = tracker.end(dsn, slow_sql_threshold_ms, emit)

        latency_buckets[tag] = phase_latencies
        errors.extend(phase_errors)
        lat = phase_latencies
        p95_sub = _percentile(lat, 95)
        p99_sub = _percentile(lat, 99)
        avg_sub = sum(lat) / len(lat) if lat else 0.0
        p95_limit = sub_p95_limits.get(tag, 1500)
        p99_limit = sub_p99_limits.get(tag, p95_limit * 2)
        ok = bool(lat) and p95_sub <= float(p95_limit) and p99_sub <= float(p99_limit) and not phase_errors
        sub_notes.append(f"{tag} P95={p95_sub:.0f}ms≤{p95_limit}, P99={p99_sub:.0f}ms≤{p99_limit}")
        slow_display = str(slow_sql_count) if slow_sql_count >= 0 else "—"
        sub_queries[tag] = {
            "label": label,
            "executions": sub_exec,
            "successOps": len(lat),
            "errorCount": max(sub_exec - len(lat), 0),
            "successRate": f"{(len(lat) / sub_exec * 100):.1f}%" if sub_exec else "—",
            "avgMs": f"{avg_sub:.1f}",
            "p95": f"{p95_sub:.1f}",
            "p99": f"{p99_sub:.1f}",
            "tps": f"{(len(lat) / phase_duration):.1f}" if phase_duration > 0 else "0.0",
            "p95LimitMs": p95_limit,
            "p99LimitMs": p99_limit,
            "passed": ok,
            "startedAt": phase_started,
            "finishedAt": phase_finished,
            "connPeak": conn_peak,
            "slowSqlCount": slow_display,
            "slowSqlThresholdMs": int(slow_sql_threshold_ms),
        }
        if not ok:
            sub_pass = False

    slow_parts: list[int] = []
    for sq in sub_queries.values():
        val = sq.get("slowSqlCount")
        if val is None or str(val).strip() in ("", "—"):
            continue
        try:
            slow_parts.append(int(val))
        except (TypeError, ValueError):
            continue
    scenario_slow_sql = sum(slow_parts) if slow_parts else -1

    all_latencies = [v for bucket in latency_buckets.values() for v in bucket]
    success = len(all_latencies)
    total = conc * iters * len(sub_builders)
    avg = sum(all_latencies) / success if success else 0.0
    p50 = _percentile(all_latencies, 50)
    p95 = _percentile(all_latencies, 95)
    p99 = _percentile(all_latencies, 99)
    tps = success / total_duration if total_duration > 0 else 0.0
    duration = total_duration
    started_at = scenario_started_at
    finished_at = scenario_finished_at
    conn_peak = scenario_conn_peak
    slow_sql_count = scenario_slow_sql

    passed: bool | None = None
    if success > 0 and sub_p95_limits:
        passed = sub_pass and len(errors) == 0

    note = "直连 SQL（不经 API/解析）· compound · " + "; ".join(sub_notes)
    if errors:
        note += f" · {len(errors)} 错误"

    emit(
        f"  完成 {success}/{total}，P50={p50:.1f}ms，P95={p95:.1f}ms，P99={p99:.1f}ms，TPS={tps:.1f}"
        + (f"，{'通过' if passed else '未通过'}" if passed is not None else "")
    )

    return ScenarioResult(
        id=scenario_id,
        name=name,
        kind="read",
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
        min_ms=min(all_latencies) if all_latencies else 0.0,
        max_ms=max(all_latencies) if all_latencies else 0.0,
        tps=tps,
        duration_sec=duration,
        p95_limit_ms=int(sub_p95_limits.get("count", 1000)),
        p99_limit_ms=int(sub_p99_limits.get("count", sub_p95_limits.get("count", 1000) * 2)),
        passed=passed,
        note=note,
        started_at=started_at,
        finished_at=finished_at,
        conn_peak=conn_peak,
        slow_sql_count=slow_sql_count,
        slow_sql_threshold_ms=slow_sql_threshold_ms,
        compound=True,
        sub_queries=sub_queries,
    )


def run_scenario(
    scenario_id: str,
    stage: str,
    dsn: str,
    schema: str,
    database: str,
    ctx: BenchContext,
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    concurrency: int | None = None,
    query_concurrency: int | None = None,
    iterations: int | None = None,
    slow_sql_threshold_ms: float = 500.0,
    slow_sql_tracker: ScenarioSlowSqlTracker | None = None,
    log: Callable[[str], None] | None = None,
) -> ScenarioResult:
    if cfg.get("compound"):
        return _run_compound_scenario(
            scenario_id,
            stage,
            dsn,
            schema,
            database,
            ctx,
            cfg,
            defaults,
            concurrency,
            query_concurrency,
            iterations,
            slow_sql_threshold_ms,
            slow_sql_tracker,
            log,
        )

    emit = log or (lambda _m: None)
    conc = _resolve_concurrency(cfg, stage, defaults, concurrency, query_concurrency)
    iters = iterations or int(defaults.get("iterations", 50))
    warmup = int(defaults.get("warmup", 5))
    kind = str(cfg.get("kind", "read"))
    name = (
        perf05_agg_scenario_name(ctx.perf05_agg_bucket_minutes)
        if scenario_id == "PERF-05-AGG"
        else str(cfg.get("name", scenario_id))
    )
    p95_limit = cfg.get("p95_limit_ms")
    p99_limit = cfg.get("p99_limit_ms")

    emit(f"[{scenario_id}] {name} — 并发 {conc} × {iters} 次（预热 {warmup}）")
    tracker = slow_sql_tracker or ScenarioSlowSqlTracker()
    tracker.begin(dsn, emit)

    latencies: list[float] = []
    errors: list[str] = []
    threads: list[threading.Thread] = []
    started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    sampler = ConnPeakSampler(dsn, database)
    sampler.start()

    t_start = time.perf_counter()
    for w in range(conc):
        t = threading.Thread(
            target=_worker,
            args=(dsn, schema, scenario_id, kind, ctx, iters, warmup, w, latencies, errors),
            daemon=True,
        )
        threads.append(t)
        t.start()
    for t in threads:
        t.join()
    duration = time.perf_counter() - t_start
    finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    conn_peak = sampler.stop()
    slow_sql_count = tracker.end(dsn, slow_sql_threshold_ms, emit)

    success = len(latencies)
    total = conc * iters
    avg = sum(latencies) / success if success else 0.0
    p50 = _percentile(latencies, 50)
    p95 = _percentile(latencies, 95)
    p99 = _percentile(latencies, 99)
    tps = success / duration if duration > 0 else 0.0
    passed: bool | None = None
    if success > 0 and (p95_limit is not None or p99_limit is not None):
        p95_ok = p95_limit is None or p95 <= float(p95_limit)
        p99_ok = p99_limit is None or p99 <= float(p99_limit)
        passed = p95_ok and p99_ok and len(errors) == 0

    note = f"直连 SQL（不经 API/解析）· {kind}"
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

    return ScenarioResult(
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
        slow_sql_count=slow_sql_count,
        slow_sql_threshold_ms=slow_sql_threshold_ms,
    )


def run_sql_benchmark(
    stage: str,
    dsn: str,
    schema: str = "perf",
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
    for sid in selected:
        if sid not in scenario_cfgs:
            raise ValueError(f"未知场景: {sid}")

    emit = log or (lambda _m: None)
    assert_no_load_in_progress(dsn, "执行 SQL 压测")
    emit(f"压测模式: 直连 SQL（不经 API、不涉及数据解析） stage={stage} schema={schema}")
    emit(f"慢SQL阈值: ≥{int(slow_ms)}ms（每场景开始前 reset pg_stat_statements）")
    emit(f"PERF-05-AGG 聚合间隔: {agg_bucket} 分钟")
    emit("写入场景: INSERT+COMMIT；开跑前清理历史压测行，查询场景开始前再次清理")
    cleanup_bench_writes(dsn, schema=schema, log=emit)
    with pg_connection(dsn, schema=schema) as conn:
        database = conn.info.dbname or "leidian_perf"
    ctx = resolve_context(dsn, schema=schema)
    ctx.perf05_agg_bucket_minutes = agg_bucket
    emit(
        f"数据快照: 大气 biz={ctx.atmosphere_count:,} raw={ctx.raw_count:,} "
        f"闪电={ctx.lightning_count:,} 设备={len(ctx.device_addrs)}台 "
        f"PERF-05过程={ctx.process_id}"
    )

    slow_tracker = ScenarioSlowSqlTracker()
    results: list[ScenarioResult] = []
    pending_write_data = False
    for sid in selected:
        cfg = scenario_cfgs[sid]
        scenario_iterations = iterations
        if scenario_iterations is None:
            if _is_read_scenario(cfg):
                scenario_iterations = query_iterations
            elif _is_write_scenario(cfg):
                scenario_iterations = write_iterations
        if _is_read_scenario(cfg) and pending_write_data:
            cleanup_bench_writes(dsn, schema=schema, log=emit)
            pending_write_data = False
        if sid in ("PERF-02",) and ctx.raw_count == 0:
            emit(f"[{sid}] 跳过：无 raw 数据")
            continue
        if sid in ("PERF-03", "PERF-06") and ctx.lightning_count == 0:
            emit(f"[{sid}] 跳过：无闪电数据")
            continue
        results.append(
            run_scenario(
                sid,
                stage,
                dsn,
                schema,
                database,
                ctx,
                cfg,
                defaults,
                concurrency=concurrency,
                query_concurrency=query_concurrency,
                iterations=scenario_iterations,
                slow_sql_threshold_ms=slow_ms,
                slow_sql_tracker=slow_tracker,
                log=emit,
            )
        )
        if _is_write_scenario(cfg):
            pending_write_data = True
    if pending_write_data:
        cleanup_bench_writes(dsn, schema=schema, log=emit)

    all_pass = all(r.passed for r in results if r.passed is not None)
    any_pass = any(r.passed is not None for r in results)

    return {
        "stage": stage,
        "mode": "sql_direct",
        "context": {
            "mineCode": ctx.mine_code,
            "deviceAddrs": ctx.device_addrs,
            "atmosphereCount": ctx.atmosphere_count,
            "rawCount": ctx.raw_count,
            "lightningCount": ctx.lightning_count,
            "queryWindow": [ctx.query_start.isoformat(), ctx.query_end.isoformat()],
            "processId": ctx.process_id,
            "processDataWindow": [
                ctx.process_data_window_start.isoformat(),
                ctx.process_data_window_end.isoformat(),
            ],
        },
        "results": [
            {
                **r.__dict__,
                "startedAt": r.started_at,
                "finishedAt": r.finished_at,
                "connPeak": r.conn_peak,
                "slowSqlCount": r.slow_sql_count if r.slow_sql_count >= 0 else None,
                "slowSqlThresholdMs": int(r.slow_sql_threshold_ms),
            }
            for r in results
        ],
        "section11_4": [r.to_section11_4() for r in results],
        "passed": all_pass if any_pass else None,
    }


def cmd_benchmark_main(args: Any) -> int:
    dsn = build_dsn(args.host, args.port, args.database, args.user, args.password)
    scenarios = None
    if getattr(args, "scenarios", None):
        scenarios = [s.strip() for s in args.scenarios.split(",") if s.strip()]

    def _log(msg: str) -> None:
        print(msg, flush=True)

    out = run_sql_benchmark(
        stage=args.stage,
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
        scenarios=scenarios,
        concurrency=getattr(args, "concurrency", None),
        iterations=getattr(args, "iterations", None),
        log=_log,
    )
    import json

    print("\n--- BENCHMARK_JSON ---")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get("passed") is not False else 1
