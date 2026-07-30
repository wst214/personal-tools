#!/usr/bin/env python3
"""PERF-05-AGG PostgreSQL EXPLAIN ANALYZE 诊断（S9 500 台）。

绕开 12.96 亿行全表 COUNT：直接查设备列表 + 过程窗，构造最小 ctx。
用法（在 leidian-perf-web 容器内）：
  docker exec -e STAGE=S9 -e DEVICE_LIMIT=500 leidian-perf-web python /app/python/_diag_perf05_agg_explain_pg.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import psycopg2

from generators.db import build_dsn
from generators.sql_bench import BenchContext, _sql_perf05_agg

SCHEMA = os.environ.get("PGSCHEMA", "perf")
N_DEVICES = int(os.environ.get("DEVICE_LIMIT", "500"))


def main() -> None:
    dsn = build_dsn()
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET search_path TO {SCHEMA}, public")

            cur.execute(
                f"SELECT DISTINCT device_addr FROM {SCHEMA}.biz_atmosphere_electric_field_event "
                "ORDER BY device_addr LIMIT %s",
                (N_DEVICES,),
            )
            addrs = [str(r[0]) for r in cur.fetchall()]
            print(f"设备数={len(addrs)} 前3={addrs[:3]}")

            cur.execute(
                f"SELECT id, data_window_start, data_window_end, "
                "strike_start_time, strike_end_time, mine_code "
                f"FROM {SCHEMA}.thunderstorm_process ORDER BY id LIMIT 1"
            )
            row = cur.fetchone()
            if not row:
                print("无 thunderstorm_process"); return
            pid, dw_start, dw_end, ss, se, mine_code = row
            print(f"过程id={pid} data_window={dw_start} ~ {dw_end}")

            ctx = BenchContext(
                mine_code=str(mine_code or ""),
                lon=0.0,
                lat=0.0,
                device_addrs=addrs,
                query_start=dw_start,
                query_end=dw_end,
                process_id=int(pid),
                process_strike_start=ss,
                process_strike_end=se,
                process_data_window_start=dw_start,
                process_data_window_end=dw_end,
                atmosphere_count=1,
                raw_count=1,
                lightning_count=1,
                perf05_agg_bucket_minutes=1,
            )
            sql, params = _sql_perf05_agg(ctx, 0, 0)
            print(f"\n=== AGG SQL ===\n{sql.strip()}")
            print(f"\n=== EXPLAIN (ANALYZE, BUFFERS) ===")
            t0 = time.perf_counter()
            cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql, params)
            rows = cur.fetchall()
            ms = (time.perf_counter() - t0) * 1000
            print(f"实际执行约 {ms:.0f}ms\n")
            for r in rows:
                print(r[0])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
