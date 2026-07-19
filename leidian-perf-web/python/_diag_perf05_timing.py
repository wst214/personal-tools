"""PERF-05：拆分 execute / fetch 耗时，或按并发档位测 P95（一次性诊断）。"""
from __future__ import annotations

import argparse
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import psycopg2

from generators.db import build_dsn
from generators.sql_bench import _percentile, _sql_perf05, resolve_context


def _one_query(dsn: str, sql: str, params: tuple) -> float:
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            t0 = time.perf_counter()
            cur.execute("SET search_path TO perf, public")
            cur.execute(sql, params)
            cur.fetchall()
            return (time.perf_counter() - t0) * 1000.0
    finally:
        conn.close()


def _run_serial(dsn: str, sql: str, params: tuple, rounds: int) -> None:
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for i in range(rounds):
                t0 = time.perf_counter()
                cur.execute("SET search_path TO perf, public")
                cur.execute(sql, params)
                t1 = time.perf_counter()
                rows = cur.fetchall()
                t2 = time.perf_counter()
                print(
                    f"#{i + 1} execute={(t1 - t0) * 1000:.0f}ms  "
                    f"fetch={(t2 - t1) * 1000:.0f}ms  "
                    f"rows={len(rows)}  "
                    f"total={(t2 - t0) * 1000:.0f}ms"
                )
    finally:
        conn.close()


def _run_concurrent(dsn: str, sql: str, params: tuple, concurrency: int, iterations: int) -> None:
    latencies: list[float] = []
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(_one_query, dsn, sql, params) for _ in range(iterations)]
        for fut in as_completed(futures):
            latencies.append(fut.result())
    elapsed = time.perf_counter() - t0
    latencies.sort()
    print(
        f"并发={concurrency} 次数={iterations}  "
        f"P50={_percentile(latencies, 50):.0f}ms  "
        f"P95={_percentile(latencies, 95):.0f}ms  "
        f"P99={_percentile(latencies, 99):.0f}ms  "
        f"max={latencies[-1]:.0f}ms  "
        f"TPS={iterations / elapsed:.1f}  "
        f"墙钟={elapsed:.1f}s"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="PERF-05 耗时诊断")
    parser.add_argument(
        "-c",
        "--concurrency",
        type=int,
        default=0,
        help=">0 时跑并发档（每档 iterations 次）；默认 0 为串行 5 次并拆分 execute/fetch",
    )
    parser.add_argument("-n", "--iterations", type=int, default=50, help="并发模式下单档请求数")
    parser.add_argument(
        "--levels",
        default="1,10,20,50",
        help="并发模式要测的档位，逗号分隔，如 1,10,20,50",
    )
    args = parser.parse_args()

    dsn = build_dsn()
    ctx = resolve_context(dsn)
    sql, params = _sql_perf05(ctx, 0, 0)

    print(f"process_id={ctx.process_id}")
    print(f"window={ctx.process_data_window_start} -> {ctx.process_data_window_end}")
    print(f"devices={ctx.device_addrs}")
    print()

    if args.concurrency > 0:
        _run_concurrent(dsn, sql, params, args.concurrency, args.iterations)
        return

    levels = [int(x.strip()) for x in args.levels.split(",") if x.strip()]
    if len(levels) == 1 and levels[0] == 1:
        _run_serial(dsn, sql, params, 5)
        return

    for level in levels:
        _run_concurrent(dsn, sql, params, level, args.iterations)
        print()


if __name__ == "__main__":
    main()
