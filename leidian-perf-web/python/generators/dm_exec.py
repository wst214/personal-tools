"""达梦 DM8：disql 执行与简单查询（无 dmPython 时的最小依赖）。"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


class DisqlNotFoundError(RuntimeError):
    pass


def disql_path() -> str:
    path = shutil.which("disql")
    if not path:
        raise DisqlNotFoundError(
            "未找到 disql，请将 DM8 的 bin 目录加入 PATH，或在 dbserver 上执行 sql-dameng/run_init.sh"
        )
    return path


def build_disql_conn(
    user: str,
    password: str | None,
    host: str,
    port: str,
) -> str:
    if password:
        # 密码含 @ 等特殊字符时加引号
        if any(ch in password for ch in "@/\\ "):
            return f'{user}/"{password}"@{host}:{port}'
        return f"{user}/{password}@{host}:{port}"
    return f"{user}@{host}:{port}"


def _normalize_script_path(path: Path) -> str:
    text = str(path.resolve())
    if sys.platform == "win32":
        return text.replace("\\", "/")
    return text


def _disql_output_has_error(stdout: str, stderr: str) -> bool:
    text = f"{stdout}\n{stderr}"
    if re.search(r"\[-\d{4,5}\]", text):
        return True
    for kw in ("语法分析出错", "执行失败", "严重错误", "无效的模式名", "无效的对象"):
        if kw in text:
            return True
    return False


def run_disql_file(
    conn: str,
    sql_file: Path,
    *,
    env: dict[str, str] | None = None,
) -> None:
    disql = disql_path()
    script = _normalize_script_path(sql_file)
    # 达梦 disql：`/path/to/script.sql
    result = subprocess.run(
        [disql, "-S", conn, f"`{script}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if result.returncode != 0 or _disql_output_has_error(result.stdout, result.stderr):
        raise RuntimeError(
            f"disql failed on {sql_file.name} (exit {result.returncode})\n"
            f"{result.stdout}\n{result.stderr}"
        )


def run_disql_sql(conn: str, sql: str, *, env: dict[str, str] | None = None) -> str:
    disql = disql_path()
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".sql",
        delete=False,
        encoding="utf-8",
        newline="\n",
    ) as tmp:
        tmp.write("SET ECHO OFF;\n")
        tmp.write("SET FEEDBACK OFF;\n")
        tmp.write("SET HEADING OFF;\n")
        tmp.write("SET LINESHOW OFF;\n")
        tmp.write("SET PAGESIZE 0;\n")
        tmp.write("SET LINESIZE 32767;\n")
        tmp.write(sql.strip())
        if not sql.strip().endswith(";"):
            tmp.write(";")
        tmp.write("\nEXIT;\n")
        tmp_path = Path(tmp.name)
    try:
        result = subprocess.run(
            [disql, "-S", conn, f"`{_normalize_script_path(tmp_path)}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        if result.returncode != 0 or _disql_output_has_error(result.stdout, result.stderr):
            raise RuntimeError(
                f"disql query failed (exit {result.returncode})\n"
                f"{result.stdout}\n{result.stderr}"
            )
        return result.stdout
    finally:
        tmp_path.unlink(missing_ok=True)


def disql_scalar(conn: str, sql: str, *, env: dict[str, str] | None = None) -> str | None:
    """Parse single-value disql output; tolerate row-number prefix (e.g. '1  0' -> '0')."""
    raw = run_disql_sql(conn, sql, env=env)
    for line in raw.splitlines():
        text = line.strip()
        if not text or text.startswith("---") or text.upper().startswith("SQL>"):
            continue
        if re.match(r"^[-\s|]+$", text):
            continue
        parts = re.split(r"\s+", text)
        if not parts:
            continue
        value = parts[-1]
        if value.upper() in ("NULL", "-"):
            return None
        return value
    return None


def disql_scalar_int(conn: str, sql: str, *, env: dict[str, str] | None = None) -> int:
    val = disql_scalar(conn, sql, env=env)
    if val is None:
        return 0
    try:
        return int(val)
    except ValueError:
        # fallback: first integer token in line
        m = re.search(r"-?\d+", val)
        return int(m.group(0)) if m else 0
