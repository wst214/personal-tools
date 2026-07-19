"""探测用几何坐标 ST_X/ST_Y 做 bbox 能否 count=148。"""
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
    min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(ctx.lon, ctx.lat, 60_000)

    variants = {
        "baseline ST_DWithin": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND {dm_within_50km_from_point_sql(ctx.lon, ctx.lat)}"
        ),
        "bbox lon/lat col 60km + ST_DWithin": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.longitude BETWEEN {min_lon:.6f} AND {max_lon:.6f} "
            f"AND l.latitude BETWEEN {min_lat:.6f} AND {max_lat:.6f} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)"
        ),
        "bbox ST_X+ST_Y geom 60km + ST_DWithin": (
            f"SELECT count(*) FROM biz_lightning_event l "
            f"WHERE l.strike_time >= {t0} AND l.strike_time < {t1} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_X(l.lightning_point) BETWEEN {min_lon:.6f} AND {max_lon:.6f} "
            f"AND DMGEO2.ST_Y(l.lightning_point) BETWEEN {min_lat:.6f} AND {max_lat:.6f} "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)"
        ),
    }

    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)
    for label, sql in variants.items():
        try:
            cur.execute(sql)
            cnt = int(cur.fetchone()[0])
            print(f"{label:42} count={cnt}")
        except Exception as exc:
            print(f"{label:42} ERR {str(exc)[:80]}")
    cur.close()
    db.close()


if __name__ == "__main__":
    main()
