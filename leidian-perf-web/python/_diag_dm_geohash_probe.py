"""探测达梦 DMGEO2 是否支持文章中的 GEOHASH 索引 / ST_WITHIN_DISTANCE 等。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
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


def _try(cur, label: str, sql: str) -> None:
    try:
        cur.execute(sql)
        row = cur.fetchone()
        print(f"OK  {label}: {row}")
    except Exception as exc:  # noqa: BLE001
        print(f"ERR {label}: {str(exc)[:120]}")


def main() -> None:
    conn = _conn()
    ctx = resolve_context_dameng(conn)
    t0 = format_dm_literal(ctx.process_strike_start)
    t1 = format_dm_literal(ctx.process_strike_end)
    ref = f"DMGEO2.ST_PointFromText('POINT({ctx.lon} {ctx.lat})', 4326)"

    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)
    print("=== 函数探测 ===")
    probes = [
        ("ST_WITHIN_DISTANCE=1", f"SELECT count(*) FROM biz_lightning_event l WHERE l.strike_time >= {t0} AND l.strike_time < {t1} AND DMGEO2.ST_WITHIN_DISTANCE(l.lightning_point, {ref}, 50000) = 1"),
        ("ST_WITHIN_DISTANCE boolean", f"SELECT count(*) FROM biz_lightning_event l WHERE l.strike_time >= {t0} AND l.strike_time < {t1} AND DMGEO2.ST_WITHIN_DISTANCE(l.lightning_point, {ref}, 50000)"),
        ("ST_DWithin (current)", f"SELECT count(*) FROM biz_lightning_event l WHERE l.strike_time >= {t0} AND l.strike_time < {t1} AND DMGEO2.ST_DWithin(l.lightning_point, {ref}, 50000)"),
        ("ST_GEOHASH sample", "SELECT DMGEO2.ST_GEOHASH(lightning_point, 5) FROM biz_lightning_event WHERE lightning_point IS NOT NULL AND ROWNUM = 1"),
        ("ST_GEOMFROMTEXT alias", f"SELECT DMGEO2.ST_GEOMFROMTEXT('POINT({ctx.lon} {ctx.lat})') FROM dual"),
    ]
    for label, sql in probes:
        _try(cur, label, sql)

    print("\n=== 现有空间索引 ===")
    cur.execute(
        "SELECT INDEX_NAME, INDEX_TYPE FROM DBA_INDEXES "
        f"WHERE OWNER = '{conn.schema.upper()}' AND TABLE_NAME = 'BIZ_LIGHTNING_EVENT'"
    )
    for row in cur.fetchall():
        print(" ", row)

    print("\n=== 实例版本 ===")
    for sql in ("SELECT ID_CODE()", "SELECT BUILD_VERSION FROM V$INSTANCE"):
        try:
            cur.execute(sql)
            print(" ", sql, "->", cur.fetchone())
        except Exception as exc:
            print(" ", sql, "ERR", exc)

    print("\n=== 尝试 GEOHASH 索引（RESOLUTION=5，若失败则记录错误） ===")
    try:
        cur.execute("DROP INDEX idx_biz_lightning_point_geohash_probe")
    except Exception:
        pass
    try:
        cur.execute(
            "CREATE SPATIAL INDEX idx_biz_lightning_point_geohash_probe "
            "ON biz_lightning_event(lightning_point) "
            "USING GEOMETRY_GEOHASH WITH (RESOLUTION=5)"
        )
        print("OK  CREATE SPATIAL INDEX ... GEOMETRY_GEOHASH RESOLUTION=5")
        cur.execute(
            "SELECT INDEX_NAME, INDEX_TYPE FROM DBA_INDEXES "
            f"WHERE OWNER = '{conn.schema.upper()}' AND INDEX_NAME = 'IDX_BIZ_LIGHTNING_POINT_GEOHASH_PROBE'"
        )
        print(" ", cur.fetchone())
    except Exception as exc:
        print(f"ERR CREATE GEOMETRY_GEOHASH index: {exc}")

    cur.close()
    db.close()


if __name__ == "__main__":
    main()
