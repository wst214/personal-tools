"""直连 PostgreSQL 的 SQL 压测（PERF-01～06）。

不经 Gateway/API，不经过应用解析与 Kafka 消费链路；写入场景 INSERT+COMMIT（含 WAL 提交），
压测前后按标记清理落库行，避免污染造数数据与查询场景结果。
"""

from __future__ import annotations

import math
import os
import random
import threading
import time
from array import array
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

import psycopg2
import yaml

from generators.db import build_dsn, pg_connection
from generators.load_guard import assert_no_load_in_progress
from generators.resource_collect import ConnPeakSampler, ScenarioSlowSqlTracker

SCENARIO_ORDER = (
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

# 旧版「-100」场景已并入 PERF-01/02（由页面设备台数控速）
LEGACY_SCENARIO_ALIASES = {
    "PERF-01-100": "PERF-01",
    "PERF-02-100": "PERF-02",
}

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
    perf05_agg_bucket_minutes: int = 1
    # 达梦 PERF-06：geog_only | bbox_geog | bbox_then_dwithin（与 DM_PERF06_GEO 同义）
    perf06_geo_mode: str = "bbox_then_dwithin"
    # 写入压测时间锚点（满密档应落在读窗之后，避免与造数叠秒）
    write_ts_base: datetime | None = None
    # PERF-05* 曲线设备；与 device_addrs 保持一致（读写同一设备池）
    curve_device_addrs: list[str] = field(default_factory=list)


def bench_curve_device_addrs(ctx: BenchContext) -> list[str]:
    """PERF-05* 设备列表；与写入轮转共用同一设备池。"""
    if ctx.curve_device_addrs:
        return list(ctx.curve_device_addrs)
    return list(ctx.device_addrs)


def resolve_curve_device_addrs(device_addrs: list[str], limit: int | None = None) -> list[str]:
    """读写一致：默认返回完整设备池；limit 仅在显式传入时裁剪。"""
    if not device_addrs:
        return []
    if limit is None:
        return list(device_addrs)
    n = max(int(limit), 1)
    return list(device_addrs[:n])


# 压测 PERF-05* 过程窗上限：只截查询窗，不改 thunderstorm_process 造数。
PROCESS_DATA_WINDOW_CAP = timedelta(hours=2)


def clip_process_data_window(
    start: datetime,
    end: datetime,
    *,
    max_duration: timedelta = PROCESS_DATA_WINDOW_CAP,
) -> tuple[datetime, datetime]:
    """将过程数据窗截到不超过 max_duration（默认 2h），从 start 起算。"""
    if end <= start:
        return start, end
    if end - start > max_duration:
        return start, start + max_duration
    return start, end


def resolve_stage_atmosphere_device_count(
    config_dir: Path | None,
    stage: str | None,
) -> int | None:
    """满密档 atmosphere_device_count；非满密或未配置返回 None。"""
    if not stage:
        return None
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    vol_path = root / "volume-profiles.yaml"
    if not vol_path.exists():
        return None
    with vol_path.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    profile = (cfg.get("stages") or {}).get(stage) or {}
    raw = profile.get("atmosphere_device_count")
    if raw is None:
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _resolve_write_ts_base(
    config_dir: Path | None,
    stage: str | None,
    fallback: datetime,
) -> datetime:
    if not stage:
        return fallback
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    vol_path = root / "volume-profiles.yaml"
    if not vol_path.exists():
        return fallback
    with vol_path.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    profile = (cfg.get("stages") or {}).get(stage) or {}
    defaults = cfg.get("defaults") or {}
    if not (profile.get("write_after_atmosphere") and profile.get("atmosphere_full_1hz")):
        return fallback
    from generators.time_calendar import resolve_atmosphere_span

    _, atm_end, _ = resolve_atmosphere_span(profile, defaults)
    return atm_end


def _maybe_force_cross_month_query_window(
    config_dir: Path | None,
    stage: str | None,
    query_start: datetime,
    query_end: datetime,
) -> tuple[datetime, datetime]:
    """满密跨月档：若配置了 atmosphere 窗，优先把 PERF-04 固定为跨月 24h。"""
    if not stage:
        return query_start, query_end
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    vol_path = root / "volume-profiles.yaml"
    if not vol_path.exists():
        return query_start, query_end
    with vol_path.open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    profile = (cfg.get("stages") or {}).get(stage) or {}
    defaults = cfg.get("defaults") or {}
    if not profile.get("atmosphere_full_1hz"):
        return query_start, query_end
    from generators.time_calendar import resolve_atmosphere_span

    atm_start, atm_end, _ = resolve_atmosphere_span(profile, defaults)
    # 取大气窗内第一个月界：月末 12:00 → 下月同日 12:00
    cursor = atm_start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    from generators.time_calendar import add_months

    month_boundary = add_months(cursor, 1)
    cross_end = month_boundary + timedelta(hours=12)
    cross_start = cross_end - timedelta(hours=24)
    if cross_start >= atm_start and cross_end <= atm_end:
        return cross_start, cross_end
    return query_start, query_end


def normalize_perf06_geo_mode(value: str | None = None) -> str:
    """达梦 PERF-06 空间过滤模式。

    - geog_only：业务对照，GeomToGeog + ST_DWithin
    - bbox_geog：覆盖索引 + 60km bbox + Haversine≤50km（近似，快）
    - bbox_then_dwithin：真两段（GTT 存 bbox 候选 ROWID，再 JOIN+ST_DWithin；精确）
    """
    raw = (value if value is not None else os.environ.get("DM_PERF06_GEO", "bbox_then_dwithin"))
    mode = str(raw or "bbox_then_dwithin").strip().lower()
    if mode in {"bbox_then_dwithin", "two_phase", "2phase", "bbox_then_geo"}:
        return "bbox_then_dwithin"
    if mode in {"bbox_geog", "bbox", "haversine"}:
        return "bbox_geog"
    # 历史别名 bbox_dwithin 曾指向 bbox_geog（Haversine）；保留兼容
    if mode in {"bbox_dwithin"}:
        return "bbox_geog"
    if mode in {"geog_only", "geog", "st_dwithin"}:
        return "geog_only"
    return "bbox_then_dwithin"


def normalize_perf05_agg_bucket_minutes(value: int | float | str | None) -> int:
    """PERF-05-AGG 时间桶宽度（分钟），默认 1。"""
    if value is None:
        return 1
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return 1
    return max(1, min(60, n))


def perf05_agg_scenario_name(bucket_minutes: int | None = None) -> str:
    bucket = normalize_perf05_agg_bucket_minutes(bucket_minutes)
    return f"多电场仪过程窗{bucket}分钟时间桶聚合（跨设备合成一条）"


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


def _percentile(values: Sequence[float], pct: float, *, already_sorted: bool = False) -> float:
    if not values:
        return 0.0
    ordered = values if already_sorted else sorted(values)
    n = len(ordered)
    if n == 1:
        return float(ordered[0])
    rank = (n - 1) * pct / 100.0
    lo = int(math.floor(rank))
    hi = int(math.ceil(rank))
    if lo == hi:
        return float(ordered[lo])
    return float(ordered[lo]) * (hi - rank) + float(ordered[hi]) * (rank - lo)


def latency_sample_cap() -> int:
    """耗时样本在内存中的上限；超出后蓄水池抽样。可用 BENCH_LATENCY_SAMPLE_CAP 覆盖。

    默认 25000 = 50 并发 × 500 次/线程，保证该档位下 P50/P95 用全量样本。
    """
    for key in ("BENCH_LATENCY_SAMPLE_CAP", "DM_BENCH_LATENCY_SAMPLE_CAP"):
        raw = os.environ.get(key)
        if raw is not None and str(raw).strip():
            try:
                return max(100, int(raw))
            except ValueError:
                pass
    return 25000


PG_BENCH_DEFAULT_ARRAYSIZE = 500


def pg_bench_arraysize() -> int:
    """PG 读游标 fetchmany 批次；可用 PG_BENCH_ARRAYSIZE / BENCH_ARRAYSIZE 覆盖。"""
    for key in ("PG_BENCH_ARRAYSIZE", "BENCH_ARRAYSIZE", "DM_BENCH_ARRAYSIZE"):
        raw = os.environ.get(key)
        if raw is not None and str(raw).strip():
            try:
                val = int(raw)
                if val > 0:
                    return val
            except ValueError:
                pass
    return PG_BENCH_DEFAULT_ARRAYSIZE


def pg_bench_use_server_cursor() -> bool:
    """读场景默认用 named cursor 流式取数，避免 libpq 整包缓冲。设 PG_BENCH_SERVER_CURSOR=0 关闭。"""
    raw = os.environ.get("PG_BENCH_SERVER_CURSOR", "1")
    return str(raw).strip().lower() not in {"0", "false", "off", "no"}


def _drain_pg_read_cursor(cur: Any, *, batch: int | None = None) -> None:
    """分批 fetchmany 并丢弃，压低 Python 侧结果峰值（语义仍是拉完结果）。"""
    size = max(1, int(batch if batch is not None else pg_bench_arraysize()))
    while True:
        rows = cur.fetchmany(size)
        if not rows:
            break
        del rows


def _execute_pg_read(cur_factory: Callable[..., Any], sql: str, params: tuple) -> None:
    """执行读 SQL 并抽干结果。默认服务端游标 + 分批；否则客户端游标分批。"""
    batch = pg_bench_arraysize()
    if pg_bench_use_server_cursor():
        # named cursor 必须在事务内；按 itersize 从服务端 FETCH，避免整包进 libpq
        with cur_factory(name="bench_read") as cur:
            cur.itersize = batch
            cur.execute(sql, params)
            _drain_pg_read_cursor(cur, batch=batch)
        return
    with cur_factory() as cur:
        cur.arraysize = batch
        cur.execute(sql, params)
        _drain_pg_read_cursor(cur, batch=batch)


class LatencyStats:
    """压测耗时：精确 count/sum/min/max/慢SQL数；分位用紧凑样本（有上限）。"""

    __slots__ = (
        "_samples",
        "count",
        "sum_ms",
        "min_ms",
        "max_ms",
        "slow_count",
        "_cap",
        "_rng",
        "_slow_threshold_ms",
    )

    def __init__(
        self,
        *,
        sample_cap: int | None = None,
        slow_threshold_ms: float = 500.0,
    ) -> None:
        self._samples: array[float] = array("d")
        self.count = 0
        self.sum_ms = 0.0
        self.min_ms = 0.0
        self.max_ms = 0.0
        self.slow_count = 0
        self._cap = max(100, int(sample_cap if sample_cap is not None else latency_sample_cap()))
        self._rng = random.Random()
        self._slow_threshold_ms = float(slow_threshold_ms)

    def add(self, ms: float) -> None:
        """追加正式样本（调用方负责加锁）。"""
        v = float(ms)
        self.count += 1
        self.sum_ms += v
        if self.count == 1:
            self.min_ms = v
            self.max_ms = v
        else:
            if v < self.min_ms:
                self.min_ms = v
            if v > self.max_ms:
                self.max_ms = v
        if v >= self._slow_threshold_ms:
            self.slow_count += 1
        n = len(self._samples)
        if n < self._cap:
            self._samples.append(v)
            return
        j = self._rng.randrange(self.count)
        if j < self._cap:
            self._samples[j] = v

    def __len__(self) -> int:
        return self.count

    @property
    def capped(self) -> bool:
        return self.count > self._cap

    def avg_ms(self) -> float:
        return self.sum_ms / self.count if self.count else 0.0

    def percentiles(self) -> tuple[float, float, float]:
        if not self._samples:
            return 0.0, 0.0, 0.0
        ordered = sorted(self._samples)
        return (
            _percentile(ordered, 50, already_sorted=True),
            _percentile(ordered, 95, already_sorted=True),
            _percentile(ordered, 99, already_sorted=True),
        )

    def values_for_analysis(self) -> list[float]:
        return list(self._samples)


def resolve_context(
    dsn: str,
    schema: str = "perf",
    *,
    stage: str | None = None,
    config_dir: Path | None = None,
    scenarios: list[str] | None = None,
    device_limit_override: int | None = None,
) -> BenchContext:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    bench_cfg = _load_config(root)
    device_limit = resolve_bench_device_limit(
        bench_cfg.get("scenarios") or {},
        scenarios,
        stage=stage,
        config_dir=config_dir,
        device_limit_override=device_limit_override,
    )
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
                LIMIT %s
                """,
                (device_limit,),
            )
            device_addrs = expand_bench_device_addrs([r[0] for r in cur.fetchall()], device_limit)
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
            query_start, query_end = _maybe_force_cross_month_query_window(
                config_dir, stage, query_start, query_end
            )

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
            dw_start, dw_end = clip_process_data_window(dw_start, dw_end)

            cur.execute(f"SELECT count(*) FROM {schema}.raw_kafka_message")
            raw_count = int(cur.fetchone()[0])
            cur.execute(f"SELECT count(*) FROM {schema}.biz_lightning_event")
            lightning_count = int(cur.fetchone()[0])

    write_ts_base = _resolve_write_ts_base(config_dir, stage, query_end)
    curve_addrs = resolve_curve_device_addrs(device_addrs)
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
        write_ts_base=write_ts_base,
        curve_device_addrs=curve_addrs,
    )


def _is_write_scenario(cfg: dict[str, Any]) -> bool:
    return str(cfg.get("kind")) == "write"


def _is_read_scenario(cfg: dict[str, Any]) -> bool:
    return str(cfg.get("kind")) == "read" or bool(cfg.get("compound"))


def expand_bench_device_addrs(seed: list[str], limit: int) -> list[str]:
    """扩展/裁剪设备列表到 limit；不足时按 ATM-DS-STD-NNN 补齐（与满密 1Hz 造数命名一致）。"""
    n = max(int(limit), 0)
    if n <= 0:
        return []
    out: list[str] = []
    for i in range(1, n + 1):
        if i <= len(seed):
            out.append(str(seed[i - 1]))
        else:
            out.append(f"ATM-DS-STD-{i:03d}")
    return out


def resolve_bench_device_limit(
    scenario_cfgs: dict[str, Any],
    selected: list[str] | None,
    *,
    default: int = 5,
    stage: str | None = None,
    config_dir: Path | None = None,
    device_limit_override: int | None = None,
) -> int:
    """统一设备池大小（读写同池）。

    优先使用页面/CLI 显式传入的 device_limit_override；
    否则 max(场景 device_limit, 档位 atmosphere_device_count, default)。
    """
    if device_limit_override is not None:
        try:
            return max(int(device_limit_override), 1)
        except (TypeError, ValueError):
            pass
    limit = max(int(default), 1)
    ids = selected if selected else list(scenario_cfgs.keys())
    for sid in ids:
        cfg = scenario_cfgs.get(sid) or {}
        raw = cfg.get("device_limit")
        if raw is None:
            continue
        try:
            limit = max(limit, int(raw))
        except (TypeError, ValueError):
            continue
    stage_n = resolve_stage_atmosphere_device_count(config_dir, stage)
    if stage_n is not None:
        limit = max(limit, stage_n)
    return limit


def resolve_scenario_iterations(
    cfg: dict[str, Any],
    defaults: dict[str, Any],
    override: int | None = None,
) -> int:
    if override is not None:
        return int(override)
    if cfg.get("iterations") is not None:
        return int(cfg["iterations"])
    return int(defaults.get("iterations", 50))


def normalize_scenario_ids(selected: list[str] | None) -> list[str] | None:
    """折叠已删除的 PERF-01-100/PERF-02-100，保持顺序去重。"""
    if selected is None:
        return None
    out: list[str] = []
    seen: set[str] = set()
    for sid in selected:
        mapped = LEGACY_SCENARIO_ALIASES.get(str(sid), str(sid))
        if mapped in seen:
            continue
        seen.add(mapped)
        out.append(mapped)
    return out


def apply_write_pace_from_devices(cfg: dict[str, Any], device_count: int) -> dict[str, Any]:
    """pace_from_devices=true 时目标 TPS = 设备台数（N 台×1Hz）。"""
    out = dict(cfg)
    if not out.get("pace_from_devices"):
        return out
    try:
        n = max(int(device_count), 1)
    except (TypeError, ValueError):
        n = 1
    out["target_tps"] = n
    return out


def resolve_write_pace_interval_sec(cfg: dict[str, Any], concurrency: int) -> float:
    """每 worker 最小间隔 = concurrency / target_tps，使合计约 target_tps。"""
    raw = cfg.get("target_tps")
    if raw is None or concurrency <= 0:
        return 0.0
    try:
        tps = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if tps <= 0:
        return 0.0
    return float(concurrency) / tps


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
    base = ctx.write_ts_base or ctx.query_end
    ts = base + timedelta(seconds=(seq % 3600) + 1)
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
    base = ctx.write_ts_base or ctx.query_end
    ts = base + timedelta(seconds=(seq % 1800) + 1)
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
        (bench_curve_device_addrs(ctx), ctx.process_data_window_start, ctx.process_data_window_end),
    )


def _perf05_agg_bucket_expr_pg(bucket_minutes: int) -> str:
    """PG 时间桶表达式（对齐达梦：1 分钟用 date_trunc minute；其余小时截断+分钟整除）。"""
    bucket = normalize_perf05_agg_bucket_minutes(bucket_minutes)
    if bucket == 1:
        return "date_trunc('minute', device_upload_time)"
    return (
        "date_trunc('hour', device_upload_time) "
        f"+ floor(extract(minute from device_upload_time) / {bucket}) "
        f"* interval '{bucket} minutes'"
    )


def _sql_perf05_agg(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    """
    过程窗只按时间桶聚合（跨设备合成一条；不按 device_addr 分组）。
    对齐达梦：扁平 GROUP BY（无 CTE）+ 依赖覆盖索引扫描。
    """
    del worker, seq
    bucket = normalize_perf05_agg_bucket_minutes(ctx.perf05_agg_bucket_minutes)
    bucket_expr = _perf05_agg_bucket_expr_pg(bucket)
    return (
        f"""
        SELECT
            {bucket_expr} AS device_upload_time,
            AVG(instantaneous_value) AS instantaneous_value,
            AVG(average_value) AS average_value,
            MAX(warning_level) AS warning_level,
            AVG(rate_change) AS rate_change,
            MAX(risk_level) AS risk_level,
            COUNT(*) AS point_count
        FROM {BIZ_ATMOSPHERE_TABLE}
        WHERE device_addr = ANY(%s)
          AND device_upload_time >= %s
          AND device_upload_time < %s
        GROUP BY {bucket_expr}
        ORDER BY device_upload_time
        """,
        (bench_curve_device_addrs(ctx), ctx.process_data_window_start, ctx.process_data_window_end),
    )


def _sql_perf05_agg_mv(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    """
    对照场景：读物化视图 biz_atm_field_agg_1min（全库设备按分钟预聚合）。
    不改 PERF-05-AGG；扫描量约百行/窗。需先建 MV。
    """
    del worker, seq
    return (
        """
        SELECT bucket_time AS device_upload_time,
               avg_inst AS instantaneous_value,
               avg_avg AS average_value,
               max_warning_level AS warning_level,
               avg_rate_change AS rate_change,
               max_risk_level AS risk_level,
               point_count
        FROM biz_atm_field_agg_1min
        WHERE bucket_time >= %s AND bucket_time < %s
        ORDER BY bucket_time
        """,
        (ctx.process_data_window_start, ctx.process_data_window_end),
    )


def _perf05_one_minute_window(ctx: BenchContext, worker: int, seq: int) -> tuple[datetime, datetime]:
    """固定取过程 data_window 开头连续 1 分钟（与造数 1Hz 稠密段对齐）。"""
    del worker, seq  # 取窗固定，不再滑动
    start = ctx.process_data_window_start
    end = ctx.process_data_window_end
    win_end = start + timedelta(minutes=1)
    if win_end > end:
        win_end = end
    return start, win_end


def _sql_perf05_1min(ctx: BenchContext, worker: int, seq: int) -> tuple[str, tuple]:
    """单台设备、过程窗开头连续 1 分钟的秒级明细（与多台曲线查询区分）。"""
    addrs = bench_curve_device_addrs(ctx)
    addr = addrs[worker % len(addrs)]
    win_start, win_end = _perf05_one_minute_window(ctx, worker, seq)
    return (
        f"""
        SELECT device_addr, device_upload_time, instantaneous_value, average_value,
               warning_level, rate_change, risk_level
        FROM {BIZ_ATMOSPHERE_TABLE}
        WHERE device_addr = %s
          AND device_upload_time >= %s
          AND device_upload_time < %s
        ORDER BY device_upload_time
        """,
        (addr, win_start, win_end),
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
    "PERF-05-AGG-MV": _sql_perf05_agg_mv,
    "PERF-05-1MIN": _sql_perf05_1min,
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
    """解析场景并发。

    - 全局 concurrency 覆盖（少用）优先
    - 读场景：一律以页面 query_concurrency（query_override）为准
    - 写场景：用场景自身 concurrency，否则 1
    """
    if override is not None:
        return override
    is_read = str(cfg.get("kind")) == "read" or bool(cfg.get("compound"))
    if is_read:
        if query_override is not None:
            return int(query_override)
        if cfg.get("concurrency") is not None:
            return int(cfg["concurrency"])
        sc = defaults.get("stage_concurrency") or {}
        if stage in ("S3", "S4", "S5", "S6", "S7", "S8", "S9"):
            return int(sc.get("query_high", 50))
        return int(sc.get("query_low", 20))
    if cfg.get("concurrency") is not None:
        return int(cfg["concurrency"])
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
    latency_stats: LatencyStats,
    errors: list[str],
    metrics_lock: threading.Lock,
    min_interval_sec: float = 0.0,
) -> None:
    builder = SQL_BUILDERS[scenario_id]
    conn = psycopg2.connect(dsn)
    # 读场景关 autocommit：named cursor 必须在事务内才能服务端流式 FETCH
    conn.autocommit = False
    try:
        with conn.cursor() as setup:
            setup.execute("SET search_path TO %s, public", (schema,))
        conn.commit()
        for seq in range(warmup + iterations):
            is_warmup = seq < warmup
            sql, params = builder(ctx, worker_idx, seq)
            t0 = time.perf_counter()
            try:
                if kind == "write":
                    with conn.cursor() as cur:
                        cur.execute(sql, params)
                    conn.commit()
                else:
                    _execute_pg_read(conn.cursor, sql, params)
                    conn.commit()
                if not is_warmup:
                    elapsed_ms = (time.perf_counter() - t0) * 1000.0
                    with metrics_lock:
                        latency_stats.add(elapsed_ms)
            except Exception as exc:  # noqa: BLE001
                try:
                    conn.rollback()
                except Exception:
                    pass
                if not is_warmup:
                    with metrics_lock:
                        errors.append(f"worker={worker_idx} seq={seq}: {exc}")
            if min_interval_sec > 0:
                remain = min_interval_sec - (time.perf_counter() - t0)
                if remain > 0:
                    time.sleep(remain)
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
    latency_stats: LatencyStats,
    errors: list[str],
    metrics_lock: threading.Lock,
    error_tag: str = "",
) -> None:
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    tag_prefix = f"{error_tag}: " if error_tag else ""
    try:
        with conn.cursor() as setup:
            setup.execute("SET search_path TO %s, public", (schema,))
        conn.commit()
        for seq in range(warmup + iterations):
            is_warmup = seq < warmup
            sql, params = builder(ctx, worker_idx, seq)
            t0 = time.perf_counter()
            try:
                _execute_pg_read(conn.cursor, sql, params)
                conn.commit()
                if not is_warmup:
                    elapsed_ms = (time.perf_counter() - t0) * 1000.0
                    with metrics_lock:
                        latency_stats.add(elapsed_ms)
            except Exception as exc:  # noqa: BLE001
                try:
                    conn.rollback()
                except Exception:
                    pass
                if not is_warmup:
                    with metrics_lock:
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

    latency_buckets: dict[str, LatencyStats] = {
        tag: LatencyStats(slow_threshold_ms=slow_sql_threshold_ms) for tag, _ in sub_builders
    }
    errors: list[str] = []
    metrics_lock = threading.Lock()
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
        phase_stats = latency_buckets[tag]
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
                    phase_stats,
                    phase_errors,
                    metrics_lock,
                    tag,
                ),
                daemon=True,
            )
            phase_threads.append(t)
            t.start()

        progress_stop = threading.Event()

        def _phase_progress_loop() -> None:
            while not progress_stop.wait(15.0):
                with metrics_lock:
                    done = len(phase_stats)
                    err_n = len(phase_errors)
                elapsed = time.perf_counter() - t_phase
                if done <= 0 and err_n <= 0:
                    emit(f"  … {scenario_id}/{tag} 仍在首波查询（已跑 {elapsed:.0f}s）")
                else:
                    emit(
                        f"  … {scenario_id}/{tag} 进度 {done}/{sub_exec}"
                        f"（错误 {err_n}，已跑 {elapsed:.0f}s）"
                    )

        progress_thread = threading.Thread(target=_phase_progress_loop, daemon=True)
        progress_thread.start()
        for t in phase_threads:
            t.join()
        progress_stop.set()
        phase_duration = time.perf_counter() - t_phase
        total_duration += phase_duration
        phase_finished = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        scenario_finished_at = phase_finished
        conn_peak = sampler.stop()
        if conn_peak > scenario_conn_peak:
            scenario_conn_peak = conn_peak
        slow_sql_count = tracker.end(dsn, slow_sql_threshold_ms, emit)

        errors.extend(phase_errors)
        success_n = len(phase_stats)
        avg_sub = phase_stats.avg_ms()
        p50_sub, p95_sub, p99_sub = phase_stats.percentiles()
        del p50_sub
        p95_limit = sub_p95_limits.get(tag, 1500)
        p99_limit = sub_p99_limits.get(tag, p95_limit * 2)
        ok = bool(success_n) and p95_sub <= float(p95_limit) and p99_sub <= float(p99_limit) and not phase_errors
        sub_notes.append(f"{tag} P95={p95_sub:.0f}ms≤{p95_limit}, P99={p99_sub:.0f}ms≤{p99_limit}")
        slow_display = str(slow_sql_count) if slow_sql_count >= 0 else "—"
        sub_queries[tag] = {
            "label": label,
            "executions": sub_exec,
            "successOps": success_n,
            "errorCount": len(phase_errors),
            "successRate": f"{(success_n / sub_exec * 100):.1f}%" if sub_exec else "—",
            "avgMs": f"{avg_sub:.1f}",
            "p95": f"{p95_sub:.1f}",
            "p99": f"{p99_sub:.1f}",
            "tps": f"{(success_n / phase_duration):.1f}" if phase_duration > 0 else "0.0",
            "p95LimitMs": p95_limit,
            "p99LimitMs": p99_limit,
            "passed": ok,
            "startedAt": phase_started,
            "finishedAt": phase_finished,
            "connPeak": conn_peak,
            "slowSqlCount": slow_display,
            "slowSqlThresholdMs": int(slow_sql_threshold_ms),
            "minMs": round(phase_stats.min_ms, 1) if success_n else 0.0,
            "maxMs": round(phase_stats.max_ms, 1) if success_n else 0.0,
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

    all_latencies = [
        v for bucket in latency_buckets.values() for v in bucket.values_for_analysis()
    ]
    success = sum(len(bucket) for bucket in latency_buckets.values())
    total = conc * iters * len(sub_builders)
    avg = (
        sum(b.sum_ms for b in latency_buckets.values()) / success if success else 0.0
    )
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
        min_ms=min((b.min_ms for b in latency_buckets.values() if b.count), default=0.0),
        max_ms=max((b.max_ms for b in latency_buckets.values() if b.count), default=0.0),
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
    iters = resolve_scenario_iterations(cfg, defaults, iterations)
    warmup = int(defaults.get("warmup", 5))
    kind = str(cfg.get("kind", "read"))
    pace_sec = resolve_write_pace_interval_sec(cfg, conc) if kind == "write" else 0.0
    name = (
        perf05_agg_scenario_name(ctx.perf05_agg_bucket_minutes)
        if scenario_id == "PERF-05-AGG"
        else str(cfg.get("name", scenario_id))
    )
    p95_limit = cfg.get("p95_limit_ms")
    p99_limit = cfg.get("p99_limit_ms")

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
    emit(f"[{scenario_id}] {name} — 并发 {conc} × {iters} 次（预热 {warmup}）{pace_note}{device_note}")
    tracker = slow_sql_tracker or ScenarioSlowSqlTracker()
    tracker.begin(dsn, emit)

    latency_stats = LatencyStats(slow_threshold_ms=slow_sql_threshold_ms)
    errors: list[str] = []
    metrics_lock = threading.Lock()
    threads: list[threading.Thread] = []
    started_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    sampler = ConnPeakSampler(dsn, database)
    sampler.start()

    total = conc * iters
    t_start = time.perf_counter()
    for w in range(conc):
        t = threading.Thread(
            target=_worker,
            args=(
                dsn,
                schema,
                scenario_id,
                kind,
                ctx,
                iters,
                warmup,
                w,
                latency_stats,
                errors,
                metrics_lock,
                pace_sec,
            ),
            daemon=True,
        )
        threads.append(t)
        t.start()

    progress_stop = threading.Event()

    def _progress_loop() -> None:
        while not progress_stop.wait(15.0):
            with metrics_lock:
                done = len(latency_stats)
                err_n = len(errors)
            elapsed = time.perf_counter() - t_start
            if done <= 0 and err_n <= 0:
                emit(f"  … {scenario_id} 仍在首波查询（已跑 {elapsed:.0f}s）")
            else:
                emit(
                    f"  … {scenario_id} 进度 {done}/{total}"
                    f"（错误 {err_n}，已跑 {elapsed:.0f}s）"
                )

    progress_thread = threading.Thread(target=_progress_loop, daemon=True)
    progress_thread.start()
    for t in threads:
        t.join()
    progress_stop.set()
    duration = time.perf_counter() - t_start
    finished_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    conn_peak = sampler.stop()
    slow_sql_count = tracker.end(dsn, slow_sql_threshold_ms, emit)

    success = len(latency_stats)
    avg = latency_stats.avg_ms()
    p50, p95, p99 = latency_stats.percentiles()
    if latency_stats.capped:
        emit(
            f"  … 耗时样本蓄水池上限 {latency_stats._cap}，"
            f"正式成功 {success} 次（分位基于抽样，慢SQL计数仍精确）"
        )
    tps = success / duration if duration > 0 else 0.0
    passed: bool | None = None
    if success > 0 and (p95_limit is not None or p99_limit is not None):
        p95_ok = p95_limit is None or p95 <= float(p95_limit)
        p99_ok = p99_limit is None or p99 <= float(p99_limit)
        passed = p95_ok and p99_ok and len(errors) == 0

    note = f"直连 SQL（不经 API/解析）· {kind}"
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
    scenario_cfgs = bench_cfg.get("scenarios", {})

    selected = normalize_scenario_ids(scenarios) or list(SCENARIO_ORDER)
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
    if device_limit is not None:
        emit(f"设备台数（页面）: {int(device_limit)}")
    ctx = resolve_context(
        dsn,
        schema=schema,
        stage=stage,
        config_dir=config_dir,
        scenarios=selected,
        device_limit_override=device_limit,
    )
    ctx.perf05_agg_bucket_minutes = agg_bucket
    emit(
        f"数据快照: 大气 biz={ctx.atmosphere_count:,} raw={ctx.raw_count:,} "
        f"闪电={ctx.lightning_count:,} 设备={len(ctx.device_addrs)}台 "
        f"（读写同池） PERF-05过程={ctx.process_id}"
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
    emit(
        f"PERF-05 过程窗: {ctx.process_data_window_start.isoformat(sep=' ', timespec='seconds')} ~ "
        f"{ctx.process_data_window_end.isoformat(sep=' ', timespec='seconds')} "
        f"（压测截断上限 {int(PROCESS_DATA_WINDOW_CAP.total_seconds() // 3600)}h，未改造数）"
    )

    slow_tracker = ScenarioSlowSqlTracker()
    results: list[ScenarioResult] = []
    pending_write_data = False
    for sid in selected:
        cfg = apply_write_pace_from_devices(scenario_cfgs[sid], len(ctx.device_addrs))
        scenario_iterations = iterations
        if scenario_iterations is None:
            if _is_read_scenario(cfg):
                scenario_iterations = query_iterations
                if scenario_iterations is None and defaults.get("query_iterations") is not None:
                    scenario_iterations = int(defaults["query_iterations"])
            elif _is_write_scenario(cfg):
                scenario_iterations = write_iterations
        # 场景自身 iterations 优先于全局 write_iterations 缺省
        if scenario_iterations is None and cfg.get("iterations") is not None:
            scenario_iterations = int(cfg["iterations"])
        if _is_read_scenario(cfg) and pending_write_data:
            cleanup_bench_writes(dsn, schema=schema, log=emit)
            pending_write_data = False
        if sid == "PERF-02" and ctx.raw_count == 0:
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
