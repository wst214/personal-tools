"""数据库方言：连接默认值、SQL 目录、schema 规范化。"""

from __future__ import annotations

from pathlib import Path

DIALECT_POSTGRES = "postgres"
DIALECT_DAMENG = "dameng"
SUPPORTED_DIALECTS = frozenset({DIALECT_POSTGRES, DIALECT_DAMENG})


def normalize_dialect(dialect: str | None) -> str:
    raw = (dialect or DIALECT_POSTGRES).strip().lower()
    if raw == DIALECT_DAMENG:
        return DIALECT_DAMENG
    return DIALECT_POSTGRES


def tool_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def sql_dir_for_dialect(dialect: str | None) -> Path:
    if normalize_dialect(dialect) == DIALECT_DAMENG:
        return tool_root() / "sql-dameng"
    return tool_root() / "sql-postgres"


def infer_dialect_from_sql_dir(sql_dir: Path | None) -> str:
    if sql_dir is None:
        return DIALECT_POSTGRES
    name = sql_dir.name.lower()
    if "dameng" in name or name == "sql-dm":
        return DIALECT_DAMENG
    return DIALECT_POSTGRES


def default_schema(dialect: str | None) -> str:
    return "PERF" if normalize_dialect(dialect) == DIALECT_DAMENG else "perf"


def normalize_schema(schema: str | None, dialect: str | None) -> str:
    if schema and str(schema).strip():
        return str(schema).strip()
    return default_schema(dialect)


def default_conn(dialect: str | None) -> dict[str, str]:
    if normalize_dialect(dialect) == DIALECT_DAMENG:
        return {
            "host": "127.0.0.1",
            "port": "5236",
            "database": "LEIDIAN_PERF",
            "user": "LEIDIAN_APP",
        }
    return {
        "host": "localhost",
        "port": "5432",
        "database": "leidian_perf",
        "user": "leidian",
    }


def resolve_conn(
    dialect: str | None,
    host: str | None,
    port: str | None,
    database: str | None,
    user: str | None,
    password: str | None,
) -> tuple[str, str, str, str, str | None]:
    defaults = default_conn(dialect)
    return (
        host or defaults["host"],
        str(port or defaults["port"]),
        database or defaults["database"],
        user or defaults["user"],
        password if password is not None else None,
    )


def catalog_schema(schema: str, dialect: str | None) -> str:
    """达梦数据字典 OWNER 通常为大写。"""
    normalized = normalize_schema(schema, dialect)
    if normalize_dialect(dialect) == DIALECT_DAMENG:
        return normalized.upper()
    return normalized


def assert_dialect_isolation(expected: str | None, actual: str | None, *, context: str) -> None:
    """写入/合并记录前校验方言一致，防止 PG 与达梦数据交叉污染。"""
    if actual is None:
        return
    exp = normalize_dialect(expected)
    got = normalize_dialect(actual)
    if exp != got:
        raise ValueError(f"{context}: dialect mismatch (expected={exp}, got={got})")
