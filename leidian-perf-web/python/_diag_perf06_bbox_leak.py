"""分析 bbox 漏数：lon/lat 与 lightning_point 不一致的行。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_geo import dm_bbox_for_radius_m, dm_within_50km_from_point_sql
from generators.dameng_sql_bench import resolve_context_dameng
from generators.dm_write import format_dm_literal


def main() -> None:
    conn = DamengConn(
        host=os.environ["DMHOST"],
        port=os.environ["DMPORT"],
        user=os.environ["DMUSER"],
        password=os.environ.get("DMPASSWORD"),
        schema="PERF",
    )
    ctx = resolve_context_dameng(conn)
    t0 = format_dm_literal(ctx.process_strike_start)
    t1 = format_dm_literal(ctx.process_strike_end)
    ref = f"DMGEO2.ST_PointFromText('POINT({ctx.lon} {ctx.lat})', 4326)"
    min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(ctx.lon, ctx.lat, 70_000)

    sql = f"""
    SELECT l.id, l.longitude, l.latitude,
           CASE WHEN l.longitude BETWEEN {min_lon:.6f} AND {max_lon:.6f}
                 AND l.latitude BETWEEN {min_lat:.6f} AND {max_lat:.6f}
                THEN 1 ELSE 0 END AS in_bbox,
           CASE WHEN {dm_within_50km_from_point_sql(ctx.lon, ctx.lat).replace('l.', 'l.')}
                THEN 1 ELSE 0 END AS in_dwithin
    FROM biz_lightning_event l
    WHERE l.strike_time >= {t0} AND l.strike_time < {t1}
      AND l.lightning_point IS NOT NULL
      AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)
    """
    # simplify: find rows in dwithin but outside 70km bbox
    sql = f"""
    SELECT l.id, l.longitude, l.latitude
    FROM biz_lightning_event l
    WHERE l.strike_time >= {t0} AND l.strike_time < {t1}
      AND l.lightning_point IS NOT NULL
      AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)
      AND NOT (l.longitude BETWEEN {min_lon:.6f} AND {max_lon:.6f}
               AND l.latitude BETWEEN {min_lat:.6f} AND {max_lat:.6f})
    FETCH FIRST 20 ROWS ONLY
    """
    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)
    cur.execute(sql)
    rows = cur.fetchall()
    print(f"ST_DWithin=148 中，lon/lat 落在 70km bbox 外的行: {len(rows)}")
    for r in rows:
        print(f"  id={r[0]} lon={r[1]} lat={r[2]}")
    cur.close()
    db.close()


if __name__ == "__main__":
    main()
