"""PostgreSQL 连接与 COPY 批量写入。"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import date, datetime
from io import StringIO
from typing import Any, Iterable, Iterator, Sequence

import psycopg2
from psycopg2.extensions import connection as PgConnection
from psycopg2.extensions import cursor as PgCursor


def build_dsn(
    host: str | None = None,
    port: str | None = None,
    database: str | None = None,
    user: str | None = None,
    password: str | None = None,
) -> str:
    # 仅 PostgreSQL 使用 URL 覆盖；达梦有独立连接方式，禁止 PERF_DATABASE_URL 串库
    url = os.getenv("PERF_PG_DATABASE_URL") or os.getenv("PERF_DATABASE_URL")
    if url:
        return url
    return (
        f"host={host or os.getenv('PGHOST', 'localhost')} "
        f"port={port or os.getenv('PGPORT', '5432')} "
        f"dbname={database or os.getenv('PGDATABASE', 'leidian_perf')} "
        f"user={user or os.getenv('PGUSER', 'leidian')} "
        f"password={password or os.getenv('PGPASSWORD', 'leidian')}"
    )


def _safe_rollback(conn: PgConnection) -> None:
    if conn.closed:
        return
    try:
        conn.rollback()
    except psycopg2.InterfaceError:
        pass


def _safe_close(conn: PgConnection) -> None:
    if conn.closed:
        return
    try:
        conn.close()
    except psycopg2.InterfaceError:
        pass


@contextmanager
def pg_connection(dsn: str, schema: str = "perf") -> Iterator[PgConnection]:
    conn = psycopg2.connect(
        dsn,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO %s, public", (schema,))
        conn.commit()
        yield conn
        if not conn.closed:
            conn.commit()
    except Exception:
        _safe_rollback(conn)
        raise
    finally:
        _safe_close(conn)


def _format_copy_value(value: Any) -> str:
    if value is None:
        return "\\N"
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (list, tuple)):
        if not value:
            return "{}"
        inner = ",".join(str(v) for v in value)
        return "{" + inner + "}"
    text = str(value)
    return (
        text.replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def copy_rows(
    cur: PgCursor,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    batch_size: int = 50000,
) -> int:
    """使用 COPY FROM STDIN 批量写入，返回总行数。"""
    col_sql = ", ".join(columns)
    total = 0
    buffer = StringIO()
    batch_count = 0

    def flush() -> None:
        nonlocal batch_count
        if batch_count == 0:
            return
        buffer.seek(0)
        cur.copy_expert(
            f"COPY {table} ({col_sql}) FROM STDIN WITH (FORMAT text, NULL '\\N')",
            buffer,
        )
        buffer.seek(0)
        buffer.truncate(0)
        batch_count = 0

    for row in rows:
        line = "\t".join(_format_copy_value(v) for v in row)
        buffer.write(line + "\n")
        batch_count += 1
        total += 1
        if batch_count >= batch_size:
            flush()
    flush()
    return total


def ensure_monthly_partitions(
    cur: PgCursor,
    schema: str,
    start: date,
    end: date,
    parent_tables: Sequence[str],
) -> None:
    for table in parent_tables:
        cur.execute(
            "SELECT create_monthly_partitions(%s::regclass, %s::date, %s::date)",
            (f"{schema}.{table}", start, end),
        )
