"""PERF-06 达梦 EXPLAIN FOR 对比：baseline / bbox / ST_DWithin。"""
from __future__ import annotations

import os
import sys
import time

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_explain_collect import _explain_one_dameng
from generators.dameng_geo import (
    dm_bbox_for_radius_m,
    dm_within_50km_from_point_bbox_sql,
    dm_within_50km_from_point_distance_sql,
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


def _ts_literal(ts) -> str:
    return format_dm_literal(ts)


def _sql_perf06_count_with_geo(ctx, geo_filter: str) -> str:
    return f"""
    SELECT count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE l.strike_time >= {_ts_literal(ctx.process_strike_start)}
      AND l.strike_time < {_ts_literal(ctx.process_strike_end)}
      AND {geo_filter}
    """


def _print_raw_explain(conn: DamengConn, sql: str, limit: int = 12) -> None:
    cleaned = " ".join(sql.split())
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            cur.execute(f"EXPLAIN FOR {cleaned}")
            rows = cur.fetchall()
        finally:
            cur.close()
    finally:
        db.close()
    print("=== Raw EXPLAIN FOR (key nodes) ===")
    for row in rows[:limit]:
        parts = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if parts:
            op = parts[4] if len(parts) > 4 else ""
            tab = parts[5] if len(parts) > 5 else ""
            idx = parts[6] if len(parts) > 6 else ""
            filt = parts[13] if len(parts) > 13 else ""
            if op in {"GSEK", "CSCN2", "SSCN2", "SSEK2", "CSEK2", "BLKUP2", "SLCT2", "PARALLEL"} or filt:
                print(f"  {op:8} {tab:28} {idx:20} {filt[:80]}")


def _run_scalar(conn: DamengConn, sql: str) -> tuple[int | None, float]:
    cleaned = " ".join(sql.split())
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            t0 = time.perf_counter()
            cur.execute(cleaned)
            row = cur.fetchone()
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            return (int(row[0]) if row else None, elapsed_ms)
        finally:
            cur.close()
    finally:
        db.close()


def _compare_variant(conn: DamengConn, ctx, label: str, geo_filter: str) -> None:
    sql = _sql_perf06_count_with_geo(ctx, geo_filter).strip()
    print(f"\n{'─' * 60}")
    print(f"【{label}】")
    print("=== SQL ===")
    print(sql)
    try:
        count, elapsed_ms = _run_scalar(conn, sql)
        print(f"\n=== Result === count={count}  client_ms={elapsed_ms:.1f}")
    except Exception as exc:  # noqa: BLE001
        print(f"\n=== Result === ERROR: {exc}")
        return
    parsed = _explain_one_dameng(conn, sql)
    print("\n=== Parsed ===")
    for key, val in parsed.items():
        print(f"  {key}: {val}")
    _print_raw_explain(conn, sql)


def main() -> None:
    conn = _conn()
    ctx = resolve_context_dameng(conn)
    min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(ctx.lon, ctx.lat)
    print("=== Context ===")
    print(f"  center: ({ctx.lon}, {ctx.lat})")
    print(f"  strike window: {ctx.process_strike_start} ~ {ctx.process_strike_end}")
    print(f"  bbox (50km pad 1%): lon [{min_lon:.6f}, {max_lon:.6f}]  lat [{min_lat:.6f}, {max_lat:.6f}]")
    print()

    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            cur.execute(
                f"SELECT INDEX_NAME, INDEX_TYPE FROM DBA_INDEXES "
                f"WHERE OWNER = '{conn.schema.upper()}' AND TABLE_NAME = 'BIZ_LIGHTNING_EVENT'"
            )
            print("=== Indexes on BIZ_LIGHTNING_EVENT ===")
            for row in cur.fetchall():
                print(f"  {row[0]:35} {row[1]}")
        finally:
            cur.close()
    finally:
        db.close()

    variants = [
        ("ST_DWithin（当前压测）", dm_within_50km_from_point_sql(ctx.lon, ctx.lat)),
        ("legacy · ST_Distance", dm_within_50km_from_point_distance_sql(ctx.lon, ctx.lat)),
        ("bbox + ST_Distance", dm_within_50km_from_point_bbox_sql(ctx.lon, ctx.lat)),
    ]
    if sys.argv[1:] and sys.argv[1] == "no-legacy":
        variants = [variants[0]]

    for label, geo in variants:
        _compare_variant(conn, ctx, label, geo)

    print(f"\n{'=' * 60}")
    print("Navicat 手工对比：复制上面各段 SQL 分别 EXPLAIN FOR 即可。")
    print("若 bbox / ST_DWithin 的 count 与 baseline 不一致，说明 bbox 过紧或 ST_DWithin 语义不同。")


if __name__ == "__main__":
    main()
