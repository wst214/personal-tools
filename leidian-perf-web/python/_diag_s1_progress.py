"""S1 造数进度快照。"""
from __future__ import annotations

import os

from generators.dameng_conn import DamengConn
from generators.dm_write import dm_scalar

conn = DamengConn(
    host=os.environ.get("DMHOST", "192.168.1.41"),
    port=os.environ.get("DMPORT", "5236"),
    user=os.environ.get("DMUSER", "SYSDBA"),
    password=os.environ.get("DMPASSWORD"),
    schema="PERF",
)
tables = [
    "standard_atmosphere_electric_field",
    "biz_atmosphere_electric_field_event",
    "raw_kafka_message",
    "biz_lightning_event",
    "thunderstorm_process",
]
target = 2_000_000
for t in tables:
    n = dm_scalar(conn, f"SELECT count(*) FROM {t}")
    print(f"{t}: {n:,}")
std = dm_scalar(conn, "SELECT count(*) FROM standard_atmosphere_electric_field")
if std:
    pct = std / target * 100
    print(f"\n大气 standard 进度约 {std:,}/{target:,} ({pct:.1f}%)")
