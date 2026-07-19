#!/usr/bin/env python3
"""PERF 造数工具：load / validate / init-schema。"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from generators.db import build_dsn
from generators.dialect import normalize_dialect, resolve_conn, sql_dir_for_dialect
from generators.init_schema import init_schema
from generators.loader import load_stage
from generators.preflight import run_preflight
from generators.validate import validate_stage


def _add_db_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--dialect",
        choices=["postgres", "dameng"],
        default="postgres",
        help="数据库类型（当前命令执行仍以 postgres 逻辑为主）",
    )
    parser.add_argument("--schema", default="perf", help="数据库 schema，默认 perf")
    parser.add_argument("--config-dir", type=Path, default=ROOT / "config", help="配置文件目录")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", default=None)
    parser.add_argument("--database", default=None)
    parser.add_argument("--user", default=None)
    parser.add_argument("--password", default=None)


def _resolve_conn_args(args: argparse.Namespace) -> tuple[str, str, str, str, str | None]:
    dialect = str(getattr(args, "dialect", "postgres") or "postgres").strip().lower()
    if dialect == "dameng":
        host = args.host or "127.0.0.1"
        port = args.port or "5236"
        database = args.database or "LEIDIAN_PERF"
        user = args.user or "LEIDIAN_APP"
        password = args.password if args.password is not None else None
        return host, port, database, user, password
    host = args.host or "localhost"
    port = args.port or "5432"
    database = args.database or "leidian_perf"
    user = args.user or "leidian"
    password = args.password if args.password is not None else None
    return host, port, database, user, password


def cmd_load(args: argparse.Namespace) -> int:
    dialect = normalize_dialect(args.dialect)
    if dialect == "dameng":
        from generators.dameng_conn import DamengConn
        from generators.dameng_runtime import load_stage_dameng
        from generators.dialect import normalize_schema

        t0 = datetime.fromisoformat(args.t0) if args.t0 else None
        host, port, _database, user, password = _resolve_conn_args(args)
        conn = DamengConn(
            host=host,
            port=port,
            user=user,
            password=password,
            schema=normalize_schema(args.schema, "dameng"),
        )
        print(
            f"PERF load [dameng] stage={args.stage} schema={conn.schema} truncate={args.truncate}",
            flush=True,
        )

        def _log(msg: str) -> None:
            print(msg, flush=True)

        stats = load_stage_dameng(
            stage=args.stage,
            conn=conn,
            config_dir=args.config_dir,
            t0=t0,
            truncate=args.truncate,
            seed=args.seed,
            batch_size=args.batch_size,
            log=_log,
        )
        print(json.dumps(stats, ensure_ascii=False, indent=2))
        return 0

    t0 = datetime.fromisoformat(args.t0) if args.t0 else None
    host, port, database, user, password = _resolve_conn_args(args)
    dsn = build_dsn(host, port, database, user, password)
    print(f"PERF load stage={args.stage} schema={args.schema} truncate={args.truncate}", flush=True)

    def _log(msg: str) -> None:
        print(msg, flush=True)

    stats = load_stage(
        stage=args.stage,
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
        t0=t0,
        truncate=args.truncate,
        seed=args.seed,
        batch_size=args.batch_size,
        log=_log,
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    dialect = normalize_dialect(args.dialect)
    if dialect == "dameng":
        from generators.dameng_conn import DamengConn
        from generators.dameng_validate import validate_stage_dameng
        from generators.dialect import normalize_schema

        host, port, _database, user, password = _resolve_conn_args(args)
        conn = DamengConn(
            host=host,
            port=port,
            user=user,
            password=password,
            schema=normalize_schema(args.schema, "dameng"),
        )
        results = validate_stage_dameng(
            stage=args.stage,
            conn=conn,
            config_dir=args.config_dir,
        )
        failed = [r for r in results if not r.passed]
        for r in results:
            mark = "PASS" if r.passed else "FAIL"
            print(f"[{mark}] {r.name}: {r.detail}")
        print(f"\n合计 {len(results)} 项，失败 {len(failed)} 项")
        return 1 if failed else 0

    host, port, database, user, password = _resolve_conn_args(args)
    dsn = build_dsn(host, port, database, user, password)
    results = validate_stage(
        stage=args.stage,
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
    )
    failed = [r for r in results if not r.passed]
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"[{mark}] {r.name}: {r.detail}")
    print(f"\n合计 {len(results)} 项，失败 {len(failed)} 项")
    return 1 if failed else 0


def cmd_preflight(args: argparse.Namespace) -> int:
    host, port, database, user, password = _resolve_conn_args(args)
    dsn = build_dsn(host, port, database, user, password)
    result = run_preflight(
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
        selected_stage=args.stage,
        truncate=args.truncate,
        dialect=args.dialect,
        host=host,
        port=port,
        user=user,
        password=password,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("prerequisitesOk") else 1


def cmd_init_schema(args: argparse.Namespace) -> int:
    host, port, database, user, password = _resolve_conn_args(args)
    dialect = str(args.dialect or "postgres").strip().lower()
    default_sql_dir = sql_dir_for_dialect(dialect)
    sql_dir = args.sql_dir or default_sql_dir
    dsn = build_dsn(host, port, database, user, password)
    pf = run_preflight(
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
        dialect=dialect,
        host=host,
        port=port,
        user=user,
        password=password,
    )
    if not pf.get("canInitSchema") and not getattr(args, "force", False):
        reason = pf.get("initBlockReason") or "禁止重复初始化 Schema"
        print(f"BLOCKED: {reason}", file=sys.stderr)
        return 1
    if not pf.get("canInitSchema") and getattr(args, "force", False):
        print(f"WARN: 强制重复 init-schema — {pf.get('initBlockReason')}", file=sys.stderr)
    print(f"PERF init-schema [{dialect}] -> {user}@{host}:{port}/{database}")
    init_schema(host, port, database, user, password, sql_dir, dialect=dialect)
    print("PERF schema init completed.")
    return 0


def _cmd_benchmark_wrapped(args: argparse.Namespace) -> int:
    dialect = normalize_dialect(args.dialect)
    scenarios = None
    if args.scenarios:
        scenarios = [s.strip() for s in str(args.scenarios).split(",") if s.strip()]

    def _log(msg: str) -> None:
        print(msg, flush=True)

    if dialect == "dameng":
        from generators.dameng_conn import DamengConn
        from generators.dameng_sql_bench import run_sql_benchmark_dameng
        from generators.dialect import normalize_schema

        host, port, _database, user, password = _resolve_conn_args(args)
        conn = DamengConn(
            host=host,
            port=port,
            user=user,
            password=password,
            schema=normalize_schema(args.schema, "dameng"),
        )
        result = run_sql_benchmark_dameng(
            stage=args.stage,
            conn=conn,
            config_dir=args.config_dir,
            scenarios=scenarios,
            concurrency=args.concurrency,
            iterations=args.iterations,
            log=_log,
        )
        _maybe_persist_benchmark(result, args, scenarios)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("passed") is not False else 1

    from generators.sql_bench import build_dsn, run_sql_benchmark

    host, port, database, user, password = _resolve_conn_args(args)
    dsn = build_dsn(host, port, database, user, password)
    result = run_sql_benchmark(
        stage=args.stage,
        dsn=dsn,
        schema=args.schema,
        config_dir=args.config_dir,
        scenarios=scenarios,
        concurrency=args.concurrency,
        iterations=args.iterations,
        log=_log,
    )
    _maybe_persist_benchmark(result, args, scenarios)
    print("\n--- BENCHMARK_JSON ---")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("passed") is not False else 1


def _maybe_persist_benchmark(
    result: dict,
    args: argparse.Namespace,
    scenarios: list[str] | None,
) -> None:
    if not getattr(args, "save_records", False) and not getattr(args, "push_url", None):
        return
    from generators.benchmark_records import persist_benchmark_result

    persist_benchmark_result(
        result,
        dialect=normalize_dialect(args.dialect),
        scenarios=scenarios,
        iterations=args.iterations,
        config_dir=args.config_dir,
        save_records=bool(getattr(args, "save_records", False)),
        push_url=getattr(args, "push_url", None) or None,
        run_id=getattr(args, "run_id", None) or None,
        log=lambda msg, **kw: print(msg, **kw),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="雷暴过程业务数据平台 PERF 造数工具")
    sub = parser.add_subparsers(dest="command", required=True)

    p_load = sub.add_parser("load", help="按阶段造数并 COPY 入库")
    p_load.add_argument("--stage", required=True, choices=["S0", "S1", "S2", "S3", "S4"])
    p_load.add_argument("--t0", type=str, help="大气电场起始时间 ISO8601")
    p_load.add_argument("--truncate", action="store_true", help="加载前清空 perf 表")
    p_load.add_argument("--seed", type=int, default=42)
    p_load.add_argument("--batch-size", type=int, default=50000)
    _add_db_args(p_load)
    p_load.set_defaults(func=cmd_load)

    p_val = sub.add_parser("validate", help="按阶段配置校验造数结果")
    p_val.add_argument("--stage", required=True, choices=["S0", "S1", "S2", "S3", "S4"])
    _add_db_args(p_val)
    p_val.set_defaults(func=cmd_validate)

    p_pf = sub.add_parser("preflight", help="前置条件检查 + 各档位入库状态")
    p_pf.add_argument("--stage", choices=["S0", "S1", "S2", "S3", "S4"], help="当前拟造数档位")
    p_pf.add_argument("--truncate", action="store_true", help="是否计划清空后造数")
    _add_db_args(p_pf)
    p_pf.set_defaults(func=cmd_preflight)

    p_init = sub.add_parser("init-schema", help="按 dialect 执行 sql-postgres/ 或 sql-dameng/ DDL 初始化")
    p_init.add_argument("--force", action="store_true", help="忽略已初始化检测，强制重复执行（不推荐）")
    p_init.add_argument("--sql-dir", type=Path, default=None)
    _add_db_args(p_init)
    p_init.set_defaults(func=cmd_init_schema)

    p_bench = sub.add_parser("benchmark", help="直连 SQL 压测 PERF-01～06 + PERF-05-AGG（不经 API/解析）")
    p_bench.add_argument("--stage", required=True, choices=["S0", "S1", "S2", "S3", "S4"])
    p_bench.add_argument(
        "--scenarios",
        type=str,
        help="逗号分隔，默认全部：PERF-01,...,PERF-05,PERF-05-AGG,PERF-06",
    )
    p_bench.add_argument("--concurrency", type=int, help="覆盖单场景并发（仅单场景时生效）")
    p_bench.add_argument("--iterations", type=int, help="每线程迭代次数，默认见 sql-bench.yaml")
    p_bench.add_argument(
        "--save-records",
        action="store_true",
        help="压测完成后追加写入 data/stage-records.<dialect>.json",
    )
    p_bench.add_argument(
        "--push-url",
        type=str,
        default=None,
        help="压测完成后 POST 到 perf-web（如 http://192.168.1.10:8100），页面自动可见",
    )
    p_bench.add_argument("--run-id", type=str, default=None, help="自定义 runId（默认随机）")
    _add_db_args(p_bench)
    p_bench.set_defaults(func=_cmd_benchmark_wrapped)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
