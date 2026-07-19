"""PERF-06 bbox 漏数检查：baseline ST_DWithin vs bbox+ST_DWithin。"""
from __future__ import annotations

import os

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
        host=os.environ["DMHOST"],
        port=os.environ["DMPORT"],
        user=os.environ["DMUSER"],
        password=os.environ.get("DMPASSWORD"),
        schema="PERF",
    )


def main() -> None:
    conn = _conn()
    ctx = resolve_context_dameng(conn)
    t0 = format_dm_literal(ctx.process_strike_start)
    t1 = format_dm_literal(ctx.process_strike_end)
    ref = f"DMGEO2.ST_PointFromText('POINT({ctx.lon} {ctx.lat})', 4326)"
    geo_base = dm_within_50km_from_point_sql(ctx.lon, ctx.lat)
    geo_bbox = dm_within_50km_from_point_relaxed_bbox_dwithin_sql(ctx.lon, ctx.lat)
    min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(ctx.lon, ctx.lat, 60_000)

    time_filter = f"l.strike_time >= {t0} AND l.strike_time < {t1}"

    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)

    def scalar(sql: str) -> int:
        cur.execute(sql)
        return int(cur.fetchone()[0])

    base_cnt = scalar(f"SELECT count(*) FROM biz_lightning_event l WHERE {time_filter} AND {geo_base}")
    bbox_cnt = scalar(f"SELECT count(*) FROM biz_lightning_event l WHERE {time_filter} AND {geo_bbox}")

    print("=== PERF-06 漏数检查（S0 雷暴过程时间窗） ===")
    print(f"圆心: ({ctx.lon}, {ctx.lat})  时间窗: {ctx.process_strike_start} ~ {ctx.process_strike_end}")
    print(f"60km bbox: lon [{min_lon:.6f}, {max_lon:.6f}]  lat [{min_lat:.6f}, {max_lat:.6f}]")
    print()
    print(f"baseline ST_DWithin count:     {base_cnt}")
    print(f"bbox(60km) + ST_DWithin count: {bbox_cnt}")
    print(f"差异（漏数）:                  {base_cnt - bbox_cnt}")
    print()

    if base_cnt == bbox_cnt:
        print("结论: 无漏数，两种写法 count 一致。")
        cur.close()
        db.close()
        return

    # 漏掉的行：在 baseline 内、不在 bbox 内
    leak_sql = f"""
    SELECT l.id, l.source_type, l.lightning_type, l.strike_time,
           l.longitude, l.latitude,
           DMGEO2.ST_X(l.lightning_point) AS geom_lon,
           DMGEO2.ST_Y(l.lightning_point) AS geom_lat,
           CASE WHEN l.longitude BETWEEN {min_lon:.6f} AND {max_lon:.6f}
                 AND l.latitude BETWEEN {min_lat:.6f} AND {max_lat:.6f}
                THEN 1 ELSE 0 END AS lonlat_in_bbox,
           DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000) AS in_dwithin
    FROM biz_lightning_event l
    WHERE {time_filter}
      AND l.lightning_point IS NOT NULL
      AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)
      AND NOT ({geo_bbox})
    ORDER BY l.id
    """
    cur.execute(leak_sql)
    rows = cur.fetchall()
    print(f"=== 漏掉的具体行（共 {len(rows)} 条） ===")
    print(f"{'id':>20}  {'lon':>10} {'lat':>10}  {'geom_lon':>10} {'geom_lat':>10}  lonlat_in_bbox")
    for r in rows:
        print(
            f"{r[0]:>20}  {float(r[4]):>10.6f} {float(r[5]):>10.6f}  "
            f"{float(r[6]):>10.6f} {float(r[7]):>10.6f}  {r[8]}"
        )

    print()
    print("=== 原因分析 ===")
    lonlat_out = sum(1 for r in rows if r[8] == 0)
    lon_geom_diff = sum(
        1 for r in rows
        if abs(float(r[4]) - float(r[6])) > 0.000001 or abs(float(r[5]) - float(r[7])) > 0.000001
    )
    print(f"  lon/lat 落在 60km bbox 外: {lonlat_out}/{len(rows)}")
    print(f"  longitude/latitude 与 ST_X/ST_Y(几何) 不一致: {lon_geom_diff}/{len(rows)}")

    print()
    print("=== 不同 bbox 半径 count 对照 ===")
    for km in (50, 55, 60, 70, 80, 100, 120):
        m = dm_bbox_for_radius_m(ctx.lon, ctx.lat, km * 1000)
        geo = (
            f"l.longitude BETWEEN {m[0]:.6f} AND {m[1]:.6f} "
            f"AND l.latitude BETWEEN {m[2]:.6f} AND {m[3]:.6f} "
            f"AND l.lightning_point IS NOT NULL "
            f"AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)"
        )
        cnt = scalar(f"SELECT count(*) FROM biz_lightning_event l WHERE {time_filter} AND {geo}")
        mark = "OK" if cnt == base_cnt else f"MISS {base_cnt - cnt}"
        print(f"  bbox {km:3d}km  count={cnt}  ({mark})")

    print()
    print("=== 漏行几何 WKT ===")
    for r in rows[:2]:
        cur.execute(
            f"SELECT DMGEO2.ST_AsText(l.lightning_point) FROM biz_lightning_event l WHERE l.id = {r[0]}"
        )
        wkt = cur.fetchone()[0]
        print(f"  id={r[0]}  WKT={wkt}")

    print()
    print("=== 漏行 ST_Distance（米）与 ST_DWithin ===")
    for r in rows:
        cur.execute(
            f"SELECT DMGEO2.ST_Distance(l.lightning_point, {ref}), "
            f"DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000) "
            f"FROM biz_lightning_event l WHERE l.id = {r[0]}"
        )
        dist, within = cur.fetchone()
        print(f"  id={r[0]}  ST_Distance={float(dist):.1f}m  ST_DWithin={within}")

    cur.close()
    db.close()


if __name__ == "__main__":
    main()
