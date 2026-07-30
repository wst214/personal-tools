"""收集 biz_lightning_event 统计信息，对比收集前后优化器是否选择新复合索引。

复用项目现成的达梦连接 / EXPLAIN 基础设施，用库里真实雷暴时间窗生成压测 SQL，
一次跑完「收集统计信息 -> 对比前后执行计划 -> 判断是否命中新索引」，无需手敲 SQL。

用法（在能连达梦的机器上，如 dbserver 本机）：
  export DMPASSWORD='Leidian@2026!'
  cd python
  .venv/bin/python _diag_perf06_gather_stats.py

可选环境变量：
  DMHOST=localhost DMPORT=5236 DMUSER=LEIDIAN_APP DMSCHEMA=PERF
"""
from __future__ import annotations

import os
import time

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, dm_connection, setup_dm_bench_session
from generators.dameng_explain_collect import _explain_one_dameng
from generators.dameng_geo import (
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_sql_bench import _sql_perf06_count, _ts_literal, resolve_context_dameng

TABLE = "BIZ_LIGHTNING_EVENT"
NEW_INDEX = "IDX_BIZ_LIGHTNING_TIME_LON_LAT"


def _conn() -> DamengConn:
    return DamengConn(
        host=os.environ.get("DMHOST", "localhost"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "LEIDIAN_APP"),
        password=os.environ.get("DMPASSWORD"),
        schema=os.environ.get("DMSCHEMA", "PERF"),
    )


def _raw_explain(conn: DamengConn, sql: str) -> str:
    """跑 EXPLAIN FOR，返回计划全文（用于判断命中哪个索引）。"""
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
    lines: list[str] = []
    for row in rows or []:
        parts = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if parts:
            lines.append(" ".join(parts))
    return "\n".join(lines)


def _hit_new_index(plan_text: str) -> bool:
    return NEW_INDEX in (plan_text or "").upper()


def _list_indexes(conn: DamengConn) -> None:
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            cur.execute(
                f"SELECT INDEX_NAME, INDEX_TYPE FROM DBA_INDEXES "
                f"WHERE OWNER = '{conn.schema.upper()}' AND TABLE_NAME = '{TABLE}'"
            )
            print(f"=== {TABLE} 上的索引 ===")
            for row in cur.fetchall():
                mark = "  <- 新复合索引" if str(row[0]).upper() == NEW_INDEX else ""
                print(f"  {str(row[0]):40} {row[1]}{mark}")
        finally:
            cur.close()
    finally:
        db.close()


def _gather_stats(conn: DamengConn) -> None:
    """达梦 DBMS_STATS（Oracle 兼容包），命名参数调用最稳；逐条容错。"""
    owner = conn.owner  # 'PERF'
    print(f"\n=== 收集 {owner}.{TABLE} 统计信息（全表统计，可能耗时数十秒）===")
    blocks = [
        (
            "GATHER_TABLE_STATS(表+索引)",
            f"""BEGIN
  DBMS_STATS.GATHER_TABLE_STATS(
    ownname          => '{owner}',
    tabname          => '{TABLE}',
    partname         => NULL,
    estimate_percent => 100,
    method_opt       => 'FOR ALL INDEXED COLUMNS SIZE AUTO',
    degree           => 4,
    cascade          => TRUE
  );
END;""",
        ),
        (
            "GATHER_INDEX_STATS(新索引)",
            f"""BEGIN
  DBMS_STATS.GATHER_INDEX_STATS(ownname => '{owner}', indname => '{NEW_INDEX}');
END;""",
        ),
    ]
    with dm_connection(conn) as db:
        cur = db.cursor()
        try:
            for label, sql in blocks:
                try:
                    cur.execute(sql)
                    print(f"  [OK]   {label}")
                except Exception as exc:  # noqa: BLE001
                    print(f"  [FAIL] {label}: {str(exc)[:160]}")
        finally:
            cur.close()


def _show_plan(conn: DamengConn, sql: str, tag: str) -> bool:
    plan_text = _raw_explain(conn, sql)
    hit = _hit_new_index(plan_text)
    parsed = _explain_one_dameng(conn, sql)
    print(f"\n--- {tag} ---")
    print(f"  索引命中: {parsed.get('indexHit')}  分区裁剪: {parsed.get('partitionPrune')}")
    print(f"  命中新复合索引 {NEW_INDEX}: {'是 YES' if hit else '否 NO'}")
    for ln in (plan_text or "").splitlines()[:6]:
        print(f"    {ln[:150]}")
    return hit


def _perf06_sql_with_geo(ctx, geo: str) -> str:
    return (
        f"SELECT count(*) AS lightning_count FROM biz_lightning_event l "
        f"WHERE l.strike_time >= {_ts_literal(ctx.process_strike_start)} "
        f"AND l.strike_time < {_ts_literal(ctx.process_strike_end)} "
        f"AND {geo}"
    )


def _bench_one(conn: DamengConn, sql: str, runs: int = 5) -> tuple[float, float, float]:
    cleaned = " ".join(sql.split())
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            cur.execute(cleaned)  # warmup
            cur.fetchone()
            times: list[float] = []
            for _ in range(runs):
                t0 = time.perf_counter()
                cur.execute(cleaned)
                cur.fetchone()
                times.append((time.perf_counter() - t0) * 1000.0)
        finally:
            cur.close()
    finally:
        db.close()
    times.sort()
    return times[len(times) // 2], times[0], times[-1]


def _bench_compare(conn: DamengConn, ctx) -> None:
    print("\n=== 单会话实测对比（warmup 后 5 次，取中位数 ms）===")
    bbox_geo = dm_within_50km_from_point_relaxed_bbox_dwithin_sql(ctx.lon, ctx.lat)
    base_bbox = _perf06_sql_with_geo(ctx, bbox_geo)
    variants = [
        ("geog_only", _perf06_sql_with_geo(ctx, dm_within_50km_from_point_sql(ctx.lon, ctx.lat))),
        ("bbox_geog", base_bbox),
        (
            "bbox+hint",
            base_bbox.replace(
                "SELECT count(*)",
                "SELECT /*+ INDEX(l IDX_BIZ_LIGHTNING_TIME_LON_LAT) */ count(*)",
                1,
            ),
        ),
    ]
    for label, sql in variants:
        try:
            med, lo, hi = _bench_one(conn, sql)
            print(f"  {label:12}  median={med:6.1f}  min={lo:6.1f}  max={hi:6.1f}")
        except Exception as exc:  # noqa: BLE001
            print(f"  {label:12}  ERR {str(exc)[:100]}")


def main() -> None:
    conn = _conn()
    print(f"=== 连接 {conn.user}@{conn.host}:{conn.port} schema={conn.schema} ===")

    ctx = resolve_context_dameng(conn)
    print(f"  雷暴时间窗: {ctx.process_strike_start} ~ {ctx.process_strike_end}")
    print(f"  中心点: ({ctx.lon}, {ctx.lat})  闪电事件行数: {ctx.lightning_count}")

    sql = _sql_perf06_count(ctx, 0, 0).strip()
    print("\n=== PERF-06 压测 SQL（与压测完全一致）===")
    print(sql)

    _list_indexes(conn)

    hit_before = _show_plan(conn, sql, "收集前执行计划")

    _gather_stats(conn)

    hit_after = _show_plan(conn, sql, "收集后执行计划")

    _bench_compare(conn, ctx)

    print("\n" + "=" * 60)
    if hit_after and not hit_before:
        print("结论：优化器已选择新复合索引。重新跑 PERF-06 压测对比 P95/CPU。")
    elif hit_after:
        print("结论：优化器已在用新复合索引。重新跑 PERF-06 压测对比 P95/CPU。")
    else:
        print("结论：优化器仍未选择新复合索引。可选方案：")
        print("  1) 按当前压测跑（性能已达标 P95<300ms、CPU<70%），非必须")
        print("  2) 在生成 SQL 加 Hint 强制走新索引：/*+ INDEX(l IDX_BIZ_LIGHTNING_TIME_LON_LAT) */")


if __name__ == "__main__":
    main()
