"""S1 PERF-06 过程窗规模与 bbox 必要性判断。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dameng_geo import (
    dm_within_50km_from_point_relaxed_bbox_dwithin_sql,
    dm_within_50km_from_point_sql,
)
from generators.dameng_sql_bench import resolve_context_dameng
from generators.dm_write import dm_scalar, format_dm_literal

conn = DamengConn(
    host=os.environ.get("DMHOST", "192.168.1.41"),
    port=os.environ.get("DMPORT", "5236"),
    user=os.environ.get("DMUSER", "SYSDBA"),
    password=os.environ.get("DMPASSWORD"),
    schema="PERF",
)
ctx = resolve_context_dameng(conn)
t0 = format_dm_literal(ctx.process_strike_start)
t1 = format_dm_literal(ctx.process_strike_end)
tw = f"l.strike_time >= {t0} AND l.strike_time < {t1}"

print("过程窗:", ctx.process_strike_start, "~", ctx.process_strike_end)
print("圆心:", ctx.lon, ctx.lat)
for label, table in [
    ("mine_site", "mine_site"),
    ("thunderstorm_process", "thunderstorm_process"),
    ("standard_atmosphere", "standard_atmosphere_electric_field"),
    ("biz_atmosphere", "biz_atmosphere_electric_field_event"),
    ("biz_lightning", "biz_lightning_event"),
    ("raw", "raw_kafka_message"),
]:
    print(f"{label}: {dm_scalar(conn, f'SELECT count(*) FROM {table}'):,}")

in_window = dm_scalar(conn, f"SELECT count(*) FROM biz_lightning_event l WHERE {tw}")
geo = dm_within_50km_from_point_sql(ctx.lon, ctx.lat)
bbox = dm_within_50km_from_point_relaxed_bbox_dwithin_sql(ctx.lon, ctx.lat)
geog_cnt = dm_scalar(conn, f"SELECT count(*) FROM biz_lightning_event l WHERE {tw} AND {geo}")
bbox_cnt = dm_scalar(conn, f"SELECT count(*) FROM biz_lightning_event l WHERE {tw} AND {bbox}")
print(f"时间窗内闪电: {in_window:,}")
print(f"50km geog_only: {geog_cnt:,}")
print(f"50km bbox+geog: {bbox_cnt:,}")
