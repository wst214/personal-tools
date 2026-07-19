"""大气电场存量造数（standard + biz COPY）：按自然月均分时间戳。"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterator, Sequence

from generators.id_gen import SnowflakeGenerator
from generators.time_calendar import month_window, split_count_evenly


@dataclass(frozen=True)
class AtmosphereDevice:
    device_addr: str
    type_id: str
    longitude: float
    latitude: float


@dataclass(frozen=True)
class ProcessWindow:
    start: datetime
    end: datetime
    strike_start: datetime
    strike_end: datetime


STD_COLUMNS = [
    "id",
    "raw_message_id",
    "device_addr",
    "type_id",
    "command_type",
    "device_upload_time",
    "instantaneous_value",
    "average_value",
    "rate_change",
    "equipment_voltage",
    "voltage_state",
    "motor_speed",
    "warning_level",
    "circuit_number",
    "time_category",
    "longitude_direction",
    "longitude",
    "latitude_direction",
    "latitude",
    "card",
    "quality_status",
    "create_time",
    "update_time",
    "ext_json",
    "schema_version",
    "data_version",
]

BIZ_COLUMNS = [
    "id",
    "standard_record_id",
    "source_topic",
    "source_type",
    "device_addr",
    "type_id",
    "command_type",
    "device_upload_time",
    "instantaneous_value",
    "average_value",
    "rate_change",
    "equipment_voltage",
    "voltage_state",
    "motor_speed",
    "warning_level",
    "circuit_number",
    "time_category",
    "longitude_direction",
    "longitude",
    "latitude_direction",
    "latitude",
    "card",
    "risk_level",
    "event_status",
    "create_time",
    "update_time",
    "ext_json",
    "schema_version",
    "data_version",
]


def _field_values(obs_time: datetime, process_windows: Sequence[ProcessWindow], rng: random.Random) -> tuple[float, float, float, int]:
    """平稳 → 抬升 → 高值 → 回落。"""
    for window in process_windows:
        if window.start <= obs_time <= window.end:
            total = max((window.end - window.start).total_seconds(), 1)
            elapsed = (obs_time - window.start).total_seconds()
            ratio = elapsed / total
            if ratio < 0.2:
                base = rng.uniform(-15, 15)
                level = 0
            elif ratio < 0.5:
                base = rng.uniform(40, 90)
                level = 1 if ratio < 0.35 else 2
            elif ratio < 0.8:
                base = rng.uniform(90, 160)
                level = 3 if ratio < 0.65 else 4
            else:
                base = rng.uniform(20, 60)
                level = max(0, 2 - int((ratio - 0.8) * 10))
            instant = base + rng.uniform(-5, 5)
            avg = base + rng.uniform(-3, 3)
            rate = rng.uniform(-1.5, 1.5) if ratio < 0.8 else rng.uniform(-2, 2)
            return instant, avg, rate, level
    base = rng.uniform(-20, 20)
    return base, base + rng.uniform(-2, 2), rng.uniform(-0.5, 0.5), 0


def _emit_atmosphere_row(
    device: AtmosphereDevice,
    obs_time: datetime,
    id_gen: SnowflakeGenerator,
    process_windows: Sequence[ProcessWindow],
    ingest_delay_max_seconds: int,
    rng: random.Random,
) -> tuple[list, list, int]:
    std_id = id_gen.next_id()
    raw_id = id_gen.next_id()
    ingest_delay = rng.randint(0, ingest_delay_max_seconds)
    create_time = obs_time + timedelta(seconds=ingest_delay)
    instant, avg, rate, warning_level = _field_values(obs_time, process_windows, rng)
    quality = "LOW_QUALITY" if rng.random() < 0.001 else "NORMAL"

    std_row = [
        std_id,
        [raw_id],
        device.device_addr,
        device.type_id,
        "0001",
        obs_time,
        round(instant, 2),
        round(avg, 2),
        round(rate, 2),
        round(rng.uniform(11.5, 12.8), 2),
        "0",
        rng.randint(800, 1200),
        warning_level,
        "1",
        "1",
        "E",
        device.longitude,
        "N",
        device.latitude,
        f"CARD-{device.device_addr[-3:]}",
        quality,
        create_time,
        create_time,
        None,
        "1.0",
        "1.0",
    ]
    biz_row = [
        id_gen.next_id(),
        std_id,
        "device-raw-data",
        "DEVICE_RAW",
        device.device_addr,
        device.type_id,
        "0001",
        obs_time,
        round(instant, 2),
        round(avg, 2),
        round(rate, 2),
        round(rng.uniform(11.5, 12.8), 2),
        "0",
        rng.randint(800, 1200),
        warning_level,
        "1",
        "1",
        "E",
        device.longitude,
        "N",
        device.latitude,
        f"CARD-{device.device_addr[-3:]}",
        0,
        "ACTIVE",
        create_time,
        create_time,
        None,
        "1.0",
        "1.0",
    ]
    return std_row, biz_row, raw_id


def iter_atmosphere_rows(
    devices: Sequence[AtmosphereDevice],
    t0: datetime,
    total_rows: int,
    calendar_months: int,
    id_gen: SnowflakeGenerator,
    process_windows: Sequence[ProcessWindow],
    ingest_delay_max_seconds: int,
    rng: random.Random,
) -> Iterator[tuple[list, list, int]]:
    """
    将 standard 行数按自然月均分，月内均匀铺开时间戳；yield (std_row, biz_row, raw_message_id)。
    total_rows 为 5 台设备合计目标行数。
    """
    if not devices or total_rows <= 0:
        return

    month_quotas = split_count_evenly(total_rows, calendar_months)
    emitted = 0
    for month_idx, quota in enumerate(month_quotas):
        if quota <= 0:
            continue
        m_start, m_end = month_window(t0, month_idx)
        span_sec = max(int((m_end - m_start).total_seconds()), 1)
        for i in range(quota):
            device = devices[emitted % len(devices)]
            if quota <= 1:
                offset_sec = span_sec // 2
            else:
                offset_sec = int(i * span_sec / (quota - 1))
            obs_time = m_start + timedelta(seconds=offset_sec)
            emitted += 1
            yield _emit_atmosphere_row(
                device,
                obs_time,
                id_gen,
                process_windows,
                ingest_delay_max_seconds,
                rng,
            )
