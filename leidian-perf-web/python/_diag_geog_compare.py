"""对比 ST_DWithin(geometry) vs ST_GeomToGeog + ST_DWithin。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session

T0 = "TO_TIMESTAMP('2025-06-04 00:13:00.000', 'YYYY-MM-DD HH24:MI:SS.FF3')"
T1 = "TO_TIMESTAMP('2025-06-04 02:26:00.000', 'YYYY-MM-DD HH24:MI:SS.FF3')"
TIME = f"l.strike_time >= {T0} AND l.strike_time < {T1}"
REF = "DMGEO2.ST_PointFromText('POINT(109.12 34.25)', 4326)"
REF_GEOG = f"DMGEO2.ST_GeomToGeog({REF})"
BBOX = (
    "l.longitude BETWEEN 108.466059 AND 109.773941 "
    "AND l.latitude BETWEEN 33.709459 AND 34.790541"
)

REF_GEOG_POINT = (
    "DMGEO2.ST_GeomToGeog(DMGEO2.ST_PointFromText('POINT(109.12 34.25)', 4326))"
)
GEOG_DWITHIN = (
    f"DMGEO2.ST_DWithin(DMGEO2.ST_GeomToGeog(l.lightning_point), {REF_GEOG_POINT}, 50000)"
)

QUERIES = {
    "A_raw_dwithin": (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND DMGEO2.ST_DWithin(l.lightning_point, {REF}, 50000)"
    ),
    "B_bbox_dwithin": (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} AND {BBOX} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND DMGEO2.ST_DWithin(l.lightning_point, {REF}, 50000)"
    ),
    "C_geog_dwithin": (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND DMGEO2.ST_DWithin(DMGEO2.ST_GeomToGeog(l.lightning_point), {REF_GEOG}, 50000)"
    ),
    "D_geog_distance": (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND DMGEO2.ST_Distance(DMGEO2.ST_GeomToGeog(l.lightning_point), {REF_GEOG}) <= 50000"
    ),
    "E_bbox_geog_dwithin": (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} AND {BBOX} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND {GEOG_DWITHIN}"
    ),
}


def _bench_geog(conn: DamengConn, sql: str, label: str) -> None:
    import threading
    import time

    from generators.sql_bench import _percentile

    latencies: list[float] = []
    lock = threading.Lock()

    def worker() -> None:
        db = connect_dm_with_retry(conn)
        cur = setup_dm_bench_session(db, conn, read_only=True)
        for seq in range(55):
            t0 = time.perf_counter()
            cur.execute(sql)
            cur.fetchone()
            if seq >= 5:
                with lock:
                    latencies.append((time.perf_counter() - t0) * 1000)
        cur.close()
        db.close()

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(20)]
    for t in threads:
        t.start()
        time.sleep(0.05)
    for t in threads:
        t.join()
    print(
        f"{label}: P50={_percentile(latencies, 50):.1f} "
        f"P95={_percentile(latencies, 95):.1f} "
        f"P99={_percentile(latencies, 99):.1f}ms"
    )


def main() -> None:
    conn = DamengConn(
        host=os.environ.get("DMHOST", "192.168.1.41"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "SYSDBA"),
        password=os.environ.get("DMPASSWORD"),
        schema="PERF",
    )
    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)
    for name, sql in QUERIES.items():
        try:
            cur.execute(sql)
            print(f"{name}: {cur.fetchone()[0]}")
        except Exception as exc:  # noqa: BLE001
            print(f"{name}: ERROR {exc}")

    print("--- outlier distances ---")
    outlier_sql = f"""
    SELECT l.id, l.longitude, l.latitude,
      DMGEO2.ST_Distance(l.lightning_point, {REF}) AS dist_geom,
      DMGEO2.ST_Distance(DMGEO2.ST_GeomToGeog(l.lightning_point), {REF_GEOG}) AS dist_geog
    FROM biz_lightning_event l
    WHERE l.id IN (4503599627371047,4503599627371050,4503599627371056,4503599627371206)
    """
    cur.execute(outlier_sql)
    for row in cur.fetchall():
        print(row)
    print("\n--- 20 并发压测（GeomToGeog） ---")
    sql_a = (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} "
        f"AND l.lightning_point IS NOT NULL AND {GEOG_DWITHIN}"
    )
    sql_b = (
        f"SELECT count(*) FROM biz_lightning_event l WHERE {TIME} AND {BBOX} "
        f"AND l.lightning_point IS NOT NULL AND {GEOG_DWITHIN}"
    )
    _bench_geog(conn, sql_a, "A_geog_only")
    _bench_geog(conn, sql_b, "B_bbox_geog")

    cur.close()
    db.close()


if __name__ == "__main__":
    main()
