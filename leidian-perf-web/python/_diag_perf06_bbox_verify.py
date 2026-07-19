"""验证 bbox + ST_DWithin 与 baseline count 一致，并对比耗时。"""
from __future__ import annotations

import os
import statistics
import time

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_geo import (
    dm_bbox_for_radius_m,
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_sql_bench import resolve_context_dameng
from generators.dm_write import format_dm_literal


def _conn() -> DamengConn:
    return DamengConn(
        host=os.environ.get("DMHOST", "192.168.1.41"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "LEIDIAN_APP"),
        password=os.environ.get("DMPASSWORD"),
        schema=os.environ.get("DMSCHEMA", "PERF"),
    )


def _count_sql(ctx, geo: str) -> str:
    t0 = format_dm_literal(ctx.process_strike_start)
    t1 = format_dm_literal(ctx.process_strike_end)
    return (
        f"SELECT count(*) FROM biz_lightning_event l "
        f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} AND {geo}"
    )


def _run_count(conn: DamengConn, sql: str, n: int = 20) -> tuple[int, float]:
    latencies: list[float] = []
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            count = 0
            for _ in range(n):
                t0 = time.perf_counter()
                cur.execute(sql)
                count = int(cur.fetchone()[0])
                latencies.append((time.perf_counter() - t0) * 1000.0)
            return count, statistics.mean(latencies)
        finally:
            cur.close()
    finally:
        db.close()


def main() -> None:
    conn = _conn()
    ctx = resolve_context_dameng(conn)
    baseline_geo = dm_within_50km_from_point_sql(ctx.lon, ctx.lat)
    baseline_sql = _count_sql(ctx, baseline_geo)
    baseline_count, baseline_ms = _run_count(conn, baseline_sql)

    print("=== baseline ST_DWithin ===")
    print(f"  count={baseline_count}  avg={baseline_ms:.1f}ms")
    print()

    for bbox_m in (50_000, 55_000, 60_000, 65_000, 70_000):
        geo = dm_within_50km_from_point_relaxed_bbox_dwithin_sql(
            ctx.lon, ctx.lat, bbox_prefilter_m=bbox_m,
        )
        min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(ctx.lon, ctx.lat, bbox_m)
        cnt, avg_ms = _run_count(conn, _count_sql(ctx, geo))
        ok = "OK" if cnt == baseline_count else f"MISS {baseline_count - cnt}"
        print(
            f"bbox={bbox_m/1000:.0f}km  count={cnt} ({ok})  avg={avg_ms:.1f}ms  "
            f"lon=[{min_lon:.4f},{max_lon:.4f}] lat=[{min_lat:.4f},{max_lat:.4f}]"
        )

    print()
    print("正式压测前：选 count 与 baseline 一致的最小 bbox（建议 60km）。")
    print("可选索引：CREATE INDEX idx_biz_lightning_time_lon_lat")
    print("  ON biz_lightning_event (strike_time, longitude, latitude);")


if __name__ == "__main__":
    main()
