"""PERF-06 分解：时间窗 vs 空间 vs GROUP BY 各自耗时。"""
from __future__ import annotations

import os
import statistics
import time

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
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


def _bench(cur, sql: str, n: int = 30) -> dict[str, float]:
    latencies: list[float] = []
    for _ in range(n):
        t0 = time.perf_counter()
        cur.execute(sql)
        cur.fetchall()
        latencies.append((time.perf_counter() - t0) * 1000.0)
    latencies.sort()
    return {
        "avg": statistics.mean(latencies),
        "p95": latencies[int(len(latencies) * 0.95) - 1],
        "min": min(latencies),
        "max": max(latencies),
    }


def main() -> None:
    conn = _conn()
    ctx = resolve_context_dameng(conn)
    t0 = format_dm_literal(ctx.process_strike_start)
    t1 = format_dm_literal(ctx.process_strike_end)
    ref = f"DMGEO2.ST_PointFromText('POINT({ctx.lon} {ctx.lat})', 4326)"

    queries = {
        "A_time_only": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1}"
        ),
        "B_time+notnull": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.lightning_point IS NOT NULL"
        ),
        "C_spatial_count": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)"
        ),
        "D_group_source": (
            f"SELECT l.source_type, count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000) "
            f"GROUP BY l.source_type"
        ),
        "E_group_type": (
            f"SELECT l.lightning_type, count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000) "
            f"GROUP BY l.lightning_type"
        ),
    }

    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            results = {name: _bench(cur, sql) for name, sql in queries.items()}
        finally:
            cur.close()
    finally:
        db.close()

    print("=== S0 单线程分解（各 30 次） ===")
    print(f"全库 lightning: {ctx.lightning_count} 行")
    for name, m in results.items():
        print(f"  {name:18} avg={m['avg']:6.1f}ms  p95={m['p95']:6.1f}ms")

    a, b, c, d, e = (results[k]["avg"] for k in ("A_time_only", "B_time+notnull", "C_spatial_count", "D_group_source", "E_group_type"))
    print()
    print("=== 增量分解 ===")
    print(f"  时间窗 count:           {a:.1f} ms")
    print(f"  + IS NOT NULL:          {b - a:+.1f} ms")
    print(f"  + ST_DWithin 50km:      {c - b:+.1f} ms  ← 空间增量")
    print(f"  + GROUP BY source_type: {d - c:+.1f} ms  ← 聚合增量")
    print(f"  + GROUP BY lightning_type: {e - c:+.1f} ms")
    spatial_pct = (c - b) / c * 100 if c else 0
    group_pct = max(d - c, e - c) / c * 100 if c else 0
    print()
    print(f"  空间占 C 的比例: ~{spatial_pct:.0f}%")
    print(f"  聚合占 C 的比例: ~{max(0, group_pct):.0f}%")


if __name__ == "__main__":
    main()
