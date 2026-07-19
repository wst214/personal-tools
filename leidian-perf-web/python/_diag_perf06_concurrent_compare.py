"""PERF-06 count：GeomToGeog+ST_DWithin 并发压测与 EXPLAIN 对比。

用法（perf-web 容器内）:
  cd /app/python && python _diag_perf06_concurrent_compare.py
  python _diag_perf06_concurrent_compare.py --concurrency 20 --iterations 50 --warmup 5
"""

from __future__ import annotations

import argparse
import os
import threading
import time
from dataclasses import dataclass
from typing import Callable

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_geo import (
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_sql_bench import resolve_context_dameng
from generators.dm_write import format_dm_literal
from generators.sql_bench import _percentile


@dataclass(frozen=True)
class Variant:
    label: str
    geo_sql: Callable[[float, float], str]


def _build_count_sql(ctx, geo_fn: Callable[[float, float], str]) -> str:
    geo = geo_fn(ctx.lon, ctx.lat)
    return f"""
    SELECT count(*) AS lightning_count
    FROM biz_lightning_event l
    WHERE l.strike_time >= {format_dm_literal(ctx.process_strike_start)}
      AND l.strike_time < {format_dm_literal(ctx.process_strike_end)}
      AND {geo}
    """.strip()


def _worker(
    conn: DamengConn,
    sql: str,
    iterations: int,
    warmup: int,
    worker_idx: int,
    latencies: list[float],
    errors: list[str],
    lock: threading.Lock,
    stop_event: threading.Event | None = None,
) -> None:
    try:
        db = connect_dm_with_retry(conn)
    except Exception as exc:  # noqa: BLE001
        with lock:
            errors.append(f"worker={worker_idx} connect: {exc}")
        return
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        for seq in range(warmup + iterations):
            if stop_event and stop_event.is_set():
                break
            is_warmup = seq < warmup
            t0 = time.perf_counter()
            try:
                cur.execute(sql)
                cur.fetchall()
                if not is_warmup:
                    elapsed_ms = (time.perf_counter() - t0) * 1000.0
                    with lock:
                        latencies.append(elapsed_ms)
            except Exception as exc:  # noqa: BLE001
                if not is_warmup:
                    with lock:
                        errors.append(f"worker={worker_idx} seq={seq}: {exc}")
        cur.close()
    finally:
        db.close()


def _run_concurrent(
    conn: DamengConn,
    sql: str,
    *,
    concurrency: int,
    iterations: int,
    warmup: int,
) -> tuple[list[float], list[str], float]:
    latencies: list[float] = []
    errors: list[str] = []
    lock = threading.Lock()
    threads: list[threading.Thread] = []
    t0 = time.perf_counter()
    for w in range(concurrency):
        t = threading.Thread(
            target=_worker,
            args=(conn, sql, iterations, warmup, w, latencies, errors, lock),
            daemon=True,
        )
        threads.append(t)
        t.start()
        if w + 1 < concurrency:
            time.sleep(0.05)
    for t in threads:
        t.join()
    return latencies, errors, time.perf_counter() - t0


def _run_concurrent_with_explain(
    conn: DamengConn,
    sql: str,
    *,
    concurrency: int,
    iterations: int,
    warmup: int,
    explain_delay_sec: float,
) -> list[str]:
    """压测进行中从独立连接抓 EXPLAIN（更接近并发下的计划）。"""
    stop_event = threading.Event()
    latencies: list[float] = []
    errors: list[str] = []
    lock = threading.Lock()
    threads: list[threading.Thread] = []
    for w in range(concurrency):
        t = threading.Thread(
            target=_worker,
            args=(conn, sql, iterations, warmup, w, latencies, errors, lock, stop_event),
            daemon=True,
        )
        threads.append(t)
        t.start()
        if w + 1 < concurrency:
            time.sleep(0.05)

    time.sleep(explain_delay_sec)
    plan_lines = _explain_ops(conn, sql)

    stop_event.set()
    for t in threads:
        t.join(timeout=30)
    return plan_lines


def _explain_ops(conn: DamengConn, sql: str) -> list[str]:
    cleaned = " ".join(sql.split())
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        cur.execute(f"EXPLAIN FOR {cleaned}")
        rows = cur.fetchall()
        cur.close()
    finally:
        db.close()

    ops: list[str] = []
    for row in rows:
        parts = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if len(parts) <= 4:
            continue
        op = parts[4] if len(parts) > 4 else ""
        tab = parts[5] if len(parts) > 5 else ""
        idx = parts[6] if len(parts) > 6 else ""
        filt = parts[13] if len(parts) > 13 else ""
        if op in {
            "GSEK",
            "CSCN2",
            "SSCN2",
            "SSEK2",
            "CSEK2",
            "BLKUP2",
            "SLCT2",
            "PARALLEL",
            "CSEK",
            "SSEK",
            "AAGR2",
        } or filt:
            ops.append(f"{op:10} {tab:28} {idx:30} {filt[:60]}")
    return ops


def _print_stats(label: str, latencies: list[float], errors: list[str], duration: float) -> None:
    print(f"\n{'=' * 72}")
    print(label)
    print(f"{'=' * 72}")
    if not latencies:
        print("  无有效样本")
        for msg in errors[:5]:
            print(f"  ERROR: {msg}")
        return
    success = len(latencies)
    avg = sum(latencies) / success
    p50 = _percentile(latencies, 50)
    p95 = _percentile(latencies, 95)
    p99 = _percentile(latencies, 99)
    tps = success / duration if duration > 0 else 0.0
    print(f"  样本: {success}，耗时: {duration:.1f}s，TPS: {tps:.1f}")
    print(f"  P50={p50:.1f}ms  P95={p95:.1f}ms  P99={p99:.1f}ms  avg={avg:.1f}ms")
    print(f"  min={min(latencies):.1f}ms  max={max(latencies):.1f}ms")
    if errors:
        print(f"  错误 {len(errors)} 条（展示前 3）:")
        for msg in errors[:3]:
            print(f"    {msg}")


def main() -> None:
    parser = argparse.ArgumentParser(description="PERF-06 GeomToGeog 并发压测")
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--iterations", type=int, default=50)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--explain-under-load", action="store_true", default=True)
    parser.add_argument("--no-explain-under-load", dest="explain_under_load", action="store_false")
    parser.add_argument("--explain-delay", type=float, default=2.0, help="压测启动后几秒抓 EXPLAIN")
    args = parser.parse_args()

    conn = DamengConn(
        host=os.environ.get("DMHOST", "192.168.1.41"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "SYSDBA"),
        password=os.environ.get("DMPASSWORD"),
        schema="PERF",
    )
    ctx = resolve_context_dameng(conn)
    print("PERF-06 count 并发对比")
    print(f"  达梦: {conn.host}:{conn.port} schema={conn.schema}")
    print(
        f"  过程窗: {ctx.process_strike_start} ~ {ctx.process_strike_end}"
        f"  圆心=({ctx.lon}, {ctx.lat})"
    )
    print(f"  并发={args.concurrency}  每线程={args.iterations}  预热={args.warmup}")

    variants = [
        Variant("A) GeomToGeog + ST_DWithin", dm_within_50km_from_point_sql),
        Variant("B) 同上（别名路径）", dm_within_50km_from_point_relaxed_bbox_dwithin_sql),
    ]

    for variant in variants:
        sql = _build_count_sql(ctx, variant.geo_sql)
        print(f"\n--- {variant.label} ---")
        print(f"  count 校验: ", end="", flush=True)
        db = connect_dm_with_retry(conn)
        try:
            cur = setup_dm_bench_session(db, conn, read_only=True)
            cur.execute(sql)
            cnt = cur.fetchone()[0]
            cur.close()
            print(cnt)
        finally:
            db.close()

        latencies, errors, duration = _run_concurrent(
            conn,
            sql,
            concurrency=args.concurrency,
            iterations=args.iterations,
            warmup=args.warmup,
        )
        _print_stats(variant.label, latencies, errors, duration)

        print("\n  [单会话 EXPLAIN]")
        for line in _explain_ops(conn, sql):
            print(f"    {line}")

        if args.explain_under_load:
            print(f"\n  [{args.concurrency} 并发进行中 EXPLAIN，延迟 {args.explain_delay}s]")
            for line in _run_concurrent_with_explain(
                conn,
                sql,
                concurrency=args.concurrency,
                iterations=max(10, args.iterations // 5),
                warmup=2,
                explain_delay_sec=args.explain_delay,
            ):
                print(f"    {line}")

    print("\n完成。对比 A/B 的 P95 与 EXPLAIN 是否出现 GSEK / PARALLEL / SSEK2。")


if __name__ == "__main__":
    main()
