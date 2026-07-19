"""对比纯 ST_DWithin vs bbox+ST_DWithin 的执行计划。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_geo import (
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_sql_bench import resolve_context_dameng
from generators.dm_write import format_dm_literal


def explain(cur, label: str, sql: str) -> None:
    cleaned = " ".join(sql.split())
    cur.execute(f"EXPLAIN FOR {cleaned}")
    rows = cur.fetchall()
    print(f"\n{'='*60}\n{label}\n{'='*60}")
    for row in rows:
        parts = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if len(parts) > 4:
            op = parts[4] if len(parts) > 4 else ""
            tab = parts[5] if len(parts) > 5 else ""
            idx = parts[6] if len(parts) > 6 else ""
            filt = parts[13] if len(parts) > 13 else ""
            if op in {"GSEK", "CSCN2", "SSCN2", "SSEK2", "CSEK2", "BLKUP2", "SLCT2", "PARALLEL", "CSEK", "SSEK"} or filt:
                print(f"  {op:10} {tab:28} {idx:30} {filt[:70]}")


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

    sql_a = f"""
    SELECT count(*) FROM biz_lightning_event l
    WHERE l.strike_time >= {t0} AND l.strike_time < {t1}
      AND {dm_within_50km_from_point_sql(ctx.lon, ctx.lat)}
    """
    sql_b = f"""
    SELECT count(*) FROM biz_lightning_event l
    WHERE l.strike_time >= {t0} AND l.strike_time < {t1}
      AND {dm_within_50km_from_point_relaxed_bbox_dwithin_sql(ctx.lon, ctx.lat)}
    """

    db = connect_dm_with_retry(conn)
    cur = setup_dm_bench_session(db, conn, read_only=True)
    explain(cur, "A) 纯 ST_DWithin (148, P95~158ms)", sql_a)
    explain(cur, "B) bbox + ST_DWithin (144, P95~29ms)", sql_b)
    cur.close()
    db.close()


if __name__ == "__main__":
    main()
