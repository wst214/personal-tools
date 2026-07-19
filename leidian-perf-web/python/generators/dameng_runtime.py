"""达梦 DM8 执行链（造数/校验/压测）运行时骨架。

约束：
- 与 PostgreSQL 链路完全隔离：不复用 psycopg2 / COPY / pg_stat_statements 等实现
- 目前仅提供可被上层显式调用的“能力边界 + 统一错误”，避免误用走到 PG 逻辑

后续接入顺序（逐步替换，不影响 PG 默认链路）：
1) dmPython 或 disql 批量写入能力（先 S0 小表）
2) 分区补齐（按月 ADD PARTITION）
3) validate/sql_bench/resource_collect 等模块逐个移植
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Sequence

from generators.dameng_conn import (
    DamengConn,
    DamengRuntimeNotImplementedError,
    normalize_dm_schema,
    require_dameng,
)


# 兼容旧 import 路径
__all__ = [
    "DamengConn",
    "DamengRuntimeNotImplementedError",
    "load_stage_dameng",
    "validate_stage_dameng",
    "benchmark_stage_dameng",
    "insert_rows_dameng",
    "normalize_dm_schema",
    "require_dameng",
]


def load_stage_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path,
    truncate: bool = False,
    seed: int = 42,
    batch_size: int = 50000,
    log: Any | None = None,
    t0: datetime | None = None,
) -> dict[str, int]:
    """达梦造数入口；仅显式 dialect=dameng 时调用。"""
    from generators.dameng_loader import load_stage_dameng as _impl

    return _impl(
        stage=stage,
        conn=conn,
        config_dir=config_dir,
        t0=t0,
        truncate=truncate,
        seed=seed,
        batch_size=min(batch_size, 5000),
        log=log,
    )


def validate_stage_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path,
) -> list[dict[str, Any]]:
    from generators.dameng_validate import validate_stage_dameng as _impl
    from generators.validate import CheckResult

    rows: list[CheckResult] = _impl(stage=stage, conn=conn, config_dir=config_dir)
    return [{"name": r.name, "passed": r.passed, "detail": r.detail} for r in rows]


def benchmark_stage_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path,
    scenarios: Sequence[str] | None = None,
    concurrency: int | None = None,
    iterations: int | None = None,
) -> dict[str, Any]:
    from generators.dameng_sql_bench import run_sql_benchmark_dameng

    return run_sql_benchmark_dameng(
        stage=stage,
        conn=conn,
        config_dir=config_dir,
        scenarios=list(scenarios) if scenarios else None,
        concurrency=concurrency,
        iterations=iterations,
    )


def insert_rows_dameng(
    *,
    conn: DamengConn,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    batch_size: int = 2000,
) -> int:
    from generators.dm_write import insert_rows

    return insert_rows(conn, table, columns, rows, batch_size=batch_size)

