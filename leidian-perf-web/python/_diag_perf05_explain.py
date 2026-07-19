"""PERF-05：EXPLAIN (ANALYZE, BUFFERS) 诊断（一次性）。"""
from __future__ import annotations

import time

import psycopg2

from generators.db import build_dsn
from generators.sql_bench import _sql_perf05, resolve_context


def main() -> None:
    dsn = build_dsn()
    ctx = resolve_context(dsn)
    sql, params = _sql_perf05(ctx, 0, 0)
    explain_sql = "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            t0 = time.perf_counter()
            cur.execute("SET search_path TO perf, public")
            cur.execute(explain_sql, params)
            rows = cur.fetchall()
            client_ms = (time.perf_counter() - t0) * 1000.0
        print(f"client_roundtrip_ms={client_ms:.1f}  (含 EXPLAIN 文本回传，非 4212 行业务结果)")
        print()
        for row in rows:
            print(row[0])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
