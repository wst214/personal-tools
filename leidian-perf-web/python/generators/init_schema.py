"""初始化 perf schema（按方言执行 sql-postgres 或 sql-dameng 下 DDL）。"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from generators.dialect import (
    infer_dialect_from_sql_dir,
    normalize_dialect,
    sql_dir_for_dialect,
)
from generators.dm_exec import (
    DisqlNotFoundError,
    build_disql_conn,
    disql_scalar_int,
    run_disql_file,
)

SQL_FILES = [
    "00_init_schema.sql",
    "01_planning_tables.sql",
    "02_device_tables.sql",
    "03_partitioned_tables.sql",
    "04_functions_triggers.sql",
    "05_default_partitions.sql",
]

DM_SQL_FILES = [*SQL_FILES, "06_runtime_lock.sql"]


def _init_schema_postgres(
    dsn_host: str,
    dsn_port: str,
    database: str,
    user: str,
    password: str | None,
    root: Path,
) -> None:
    env = os.environ.copy()
    env.update(
        {
            "PGHOST": dsn_host,
            "PGPORT": dsn_port,
            "PGDATABASE": database,
            "PGUSER": user,
        }
    )
    if password:
        env["PGPASSWORD"] = password

    for name in SQL_FILES:
        path = root / name
        if not path.exists():
            raise FileNotFoundError(f"SQL script not found: {path}")
        print(f">> {path}")
        result = subprocess.run(
            ["psql", "-v", "ON_ERROR_STOP=1", "-f", str(path)],
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            raise RuntimeError(f"psql failed on {name} (exit {result.returncode})")


def _init_schema_dameng(
    dsn_host: str,
    dsn_port: str,
    user: str,
    password: str | None,
    root: Path,
) -> None:
    conn = build_disql_conn(user, password, dsn_host, dsn_port)
    env = os.environ.copy()
    for name in DM_SQL_FILES:
        path = root / name
        if not path.exists():
            raise FileNotFoundError(f"SQL script not found: {path}")
        print(f">> {path}")
        run_disql_file(conn, path, env=env)
    tables = disql_scalar_int(
        conn,
        "SELECT COUNT(*) FROM DBA_TABLES WHERE OWNER = 'PERF'",
        env=env,
    )
    if tables < 5:
        raise RuntimeError(
            f"init-schema finished but PERF has only {tables} tables; check disql DDL errors above"
        )


def init_schema(
    dsn_host: str,
    dsn_port: str,
    database: str,
    user: str,
    password: str | None = None,
    sql_dir: Path | None = None,
    dialect: str | None = None,
) -> None:
    root = sql_dir or sql_dir_for_dialect(dialect)
    resolved = normalize_dialect(dialect or infer_dialect_from_sql_dir(root))
    if resolved == "dameng":
        try:
            _init_schema_dameng(dsn_host, dsn_port, user, password, root)
        except DisqlNotFoundError as exc:
            raise RuntimeError(str(exc)) from exc
        return
    _init_schema_postgres(dsn_host, dsn_port, database, user, password, root)
