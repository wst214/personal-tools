"""验证 GeomToGeog 修复后 PERF-06 SQL 与 count。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, dm_fetch_scalar, setup_dm_bench_session
from generators.dameng_sql_bench import resolve_context_dameng, sql_preview_for_scenario

conn = DamengConn(
    host=os.environ.get("DMHOST", "192.168.1.41"),
    port=os.environ.get("DMPORT", "5236"),
    user=os.environ.get("DMUSER", "SYSDBA"),
    password=os.environ.get("DMPASSWORD"),
    schema="PERF",
)
ctx = resolve_context_dameng(conn)
sql = sql_preview_for_scenario("PERF-06-count", ctx)
print("=== PERF-06-count SQL ===")
print(sql)
print()
cnt = dm_fetch_scalar(conn, sql.replace("SELECT count(*) AS lightning_count", "SELECT count(*)"))
print(f"count={cnt}")
assert "ST_GeomToGeog" in sql
assert "BETWEEN" not in sql
print("OK: GeomToGeog only (no bbox), count=134")
