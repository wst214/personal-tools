"""Dameng DM8 write helpers, isolated from the PostgreSQL COPY path."""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any, Iterable, Mapping, Sequence

from generators.dameng_conn import DamengConn
from generators.dameng_db import DamengDriverNotFoundError, connect_dm
from generators.dialect import catalog_schema
from generators.dm_exec import build_disql_conn, run_disql_sql


def format_dm_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, datetime):
        text = value.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        return f"TO_TIMESTAMP('{text}', 'YYYY-MM-DD HH24:MI:SS.FF3')"
    if isinstance(value, date):
        return f"DATE '{value.isoformat()}'"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False).replace("'", "''")
        return f"'{text}'"
    text = str(value).replace("'", "''")
    return f"'{text}'"


def format_dm_column_value(column: str, value: Any) -> str:
    if column == "fence_geom" and value is not None:
        wkt = str(value).replace("'", "''")
        return f"DMGEO2.ST_GeomFromText('{wkt}', 4326)"
    return format_dm_literal(value)


def _session_prefix(conn: DamengConn) -> str:
    owner = catalog_schema(conn.schema, "dameng")
    return f'ALTER SESSION SET CURRENT_SCHEMA = "{owner}";\n'


def _strip_sql_terminator(sql: str) -> str:
    body = sql.strip()
    return body[:-1].strip() if body.endswith(";") else body


def run_dm_script(conn: DamengConn, script: str) -> None:
    disql_conn = build_disql_conn(conn.user, conn.password, conn.host, conn.port)
    body = script.strip()
    if not body.endswith(";"):
        body += ";"
    run_disql_sql(disql_conn, _session_prefix(conn) + body)


def execute_dm_sql(conn: DamengConn, sql: str) -> None:
    run_dm_script(conn, sql)


def truncate_tables(conn: DamengConn, tables: Sequence[str]) -> None:
    if not tables:
        return
    parts = [f"TRUNCATE TABLE {t};" for t in tables]
    parts.append("COMMIT;")
    run_dm_script(conn, "\n".join(parts))


def call_create_monthly_partitions(
    conn: DamengConn,
    parent_table: str,
    start: date,
    end: date,
) -> None:
    sql = (
        f"CALL create_monthly_partitions("
        f"'{parent_table.upper()}', "
        f"DATE '{start.isoformat()}', "
        f"DATE '{end.isoformat()}'"
        f");"
    )
    run_dm_script(conn, sql)


def _dm_scalar_disql(conn: DamengConn, sql: str) -> int:
    disql_conn = build_disql_conn(conn.user, conn.password, conn.host, conn.port)
    body = sql.strip()
    if not body.endswith(";"):
        body += ";"
    raw = run_disql_sql(disql_conn, _session_prefix(conn) + body)
    for line in raw.splitlines():
        text = line.strip()
        if not text or text.startswith("---") or text.upper().startswith("SQL>"):
            continue
        if all(c in "-| " for c in text):
            continue
        parts = text.split()
        if not parts:
            continue
        try:
            return int(parts[-1])
        except ValueError:
            digits = "".join(ch for ch in parts[-1] if ch.isdigit())
            if digits:
                return int(digits)
            continue
    return 0


def dm_scalar(conn: DamengConn, sql: str) -> int:
    """Run a scalar DM query. Prefer dmPython to avoid parsing disql text output."""
    try:
        db = connect_dm(conn)
    except DamengDriverNotFoundError:
        return _dm_scalar_disql(conn, sql)

    try:
        cur = db.cursor()
        try:
            owner = catalog_schema(conn.schema, "dameng")
            cur.execute(f'ALTER SESSION SET CURRENT_SCHEMA = "{owner}"')
            cur.execute(_strip_sql_terminator(sql))
            row = cur.fetchone()
            return int(row[0]) if row else 0
        finally:
            try:
                cur.close()
            except Exception:
                pass
    finally:
        try:
            db.close()
        except Exception:
            pass


def _normalize_bind_value(value: Any) -> Any:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def _dm_ident(name: str) -> str:
    clean = str(name).strip().replace('"', '""')
    if "." in clean:
        return ".".join(f'"{part.upper()}"' for part in clean.split("."))
    return f'"{clean.upper()}"'


def _insert_rows_dm_python(
    conn: DamengConn,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    *,
    batch_size: int,
) -> int:
    col_list = list(columns)
    col_sql = ", ".join(_dm_ident(c) for c in col_list)
    placeholders = ", ".join("?" for _ in col_list)
    sql = f"INSERT INTO {_dm_ident(table)} ({col_sql}) VALUES ({placeholders})"
    owner = catalog_schema(conn.schema, "dameng")
    total = 0
    batch: list[tuple[Any, ...]] = []

    db = connect_dm(conn)
    try:
        cur = db.cursor()
        try:
            cur.execute(f'ALTER SESSION SET CURRENT_SCHEMA = "{owner}"')

            def flush_batch() -> None:
                nonlocal total
                if not batch:
                    return
                cur.executemany(sql, batch)
                db.commit()
                total += len(batch)
                batch.clear()

            for row in rows:
                batch.append(tuple(_normalize_bind_value(v) for v in row))
                if len(batch) >= batch_size:
                    flush_batch()
            flush_batch()
            return total
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            raise
        finally:
            try:
                cur.close()
            except Exception:
                pass
    finally:
        try:
            db.close()
        except Exception:
            pass


def _insert_rows_disql(
    conn: DamengConn,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    *,
    batch_size: int = 200,
    column_exprs: Mapping[str, str] | None = None,
) -> int:
    col_list = list(columns)
    col_sql = ", ".join(col_list)
    exprs = column_exprs or {}
    total = 0
    batch: list[Sequence[Any]] = []

    def flush_batch() -> None:
        nonlocal total
        if not batch:
            return
        lines: list[str] = []
        for row in batch:
            vals = []
            for col, val in zip(col_list, row):
                vals.append(exprs[col] if col in exprs else format_dm_column_value(col, val))
            lines.append(f"INSERT INTO {table} ({col_sql}) VALUES ({', '.join(vals)});")
        lines.append("COMMIT;")
        run_dm_script(conn, "\n".join(lines))
        total += len(batch)
        batch.clear()

    for row in rows:
        batch.append(row)
        if len(batch) >= batch_size:
            flush_batch()
    flush_batch()
    return total


def insert_rows(
    conn: DamengConn,
    table: str,
    columns: Sequence[str],
    rows: Iterable[Sequence[Any]],
    *,
    batch_size: int = 200,
    column_exprs: Mapping[str, str] | None = None,
) -> int:
    """Batch insert rows into DM. Prefer dmPython executemany; keep disql as fallback."""
    if column_exprs:
        return _insert_rows_disql(
            conn,
            table,
            columns,
            rows,
            batch_size=batch_size,
            column_exprs=column_exprs,
        )
    try:
        return _insert_rows_dm_python(conn, table, columns, rows, batch_size=batch_size)
    except DamengDriverNotFoundError:
        return _insert_rows_disql(
            conn,
            table,
            columns,
            rows,
            batch_size=batch_size,
            column_exprs=column_exprs,
        )
