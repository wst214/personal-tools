"""达梦连接描述（供 dm_write / dameng_loader 使用，避免与 runtime 循环依赖）。"""

from __future__ import annotations

from dataclasses import dataclass

from generators.dialect import catalog_schema, normalize_dialect, normalize_schema


@dataclass(frozen=True)
class DamengConn:
    host: str
    port: str
    user: str
    password: str | None
    schema: str = "PERF"

    @property
    def owner(self) -> str:
        return catalog_schema(self.schema, "dameng")


def require_dameng(dialect: str | None) -> None:
    if normalize_dialect(dialect) != "dameng":
        raise ValueError(f"expected dameng dialect, got: {dialect!r}")


def normalize_dm_schema(schema: str | None) -> str:
    return normalize_schema(schema, "dameng")


class DamengRuntimeNotImplementedError(RuntimeError):
    """达梦执行链尚未接入时的统一错误。"""
