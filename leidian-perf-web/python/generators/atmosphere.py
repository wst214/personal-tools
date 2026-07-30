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
    data_window_start: datetime | None = None
    data_window_end: datetime | None = None

    def curve_window(self) -> tuple[datetime, datetime]:
        """与 PERF-05 一致：优先用过程 data_window，否则 strike ±5 分钟。"""
        if self.data_window_start is not None and self.data_window_end is not None:
            return self.data_window_start, self.data_window_end
        return (
            self.strike_start - timedelta(minutes=5),
            self.strike_end + timedelta(minutes=5),
        )


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


def plan_atmosphere_dense_seconds(
    process_windows: Sequence[ProcessWindow],
    *,
    device_count: int,
    total_rows: int,
    dense_minutes: int = 1,
    dense_full_window: bool = False,
) -> list[int]:
    """
    为每个过程规划稠密 1Hz 秒数（每秒写 device_count 行）。
    优先保证每过程至少 dense_minutes；预算足够且 dense_full_window 时铺满 data_window。
    """
    if not process_windows or device_count <= 0 or total_rows <= 0:
        return []

    min_sec = max(1, int(dense_minutes) * 60)
    avail_secs: list[int] = []
    for window in process_windows:
        start, end = window.curve_window()
        avail_secs.append(max(0, int((end - start).total_seconds())))

    if dense_full_window:
        planned = list(avail_secs)
    else:
        planned = [min(min_sec, sec) for sec in avail_secs]

    def _cost(secs: list[int]) -> int:
        return sum(s * device_count for s in secs)

    if _cost(planned) <= total_rows:
        return planned

    # 预算不足：退化为每过程 dense_minutes，再按过程顺序截断
    planned = [min(min_sec, sec) for sec in avail_secs]
    if _cost(planned) <= total_rows:
        return planned

    trimmed = [0] * len(planned)
    remain = total_rows
    per_process = min_sec * device_count
    for i, sec in enumerate(planned):
        need = min(sec, min_sec) * device_count
        if need <= 0 or remain < device_count:
            break
        if need <= remain:
            trimmed[i] = min(sec, min_sec)
            remain -= need
        else:
            trimmed[i] = remain // device_count
            break
    return trimmed


def count_atmosphere_dense_rows(seconds_per_window: Sequence[int], device_count: int) -> int:
    return sum(int(s) * device_count for s in seconds_per_window)


def iter_atmosphere_dense_1hz(
    devices: Sequence[AtmosphereDevice],
    process_windows: Sequence[ProcessWindow],
    seconds_per_window: Sequence[int],
    id_gen: SnowflakeGenerator,
    ingest_delay_max_seconds: int,
    rng: random.Random,
) -> Iterator[tuple[list, list, int]]:
    """
    在过程 data_window 开头按 1 条/秒/台写入稠密点（供 PERF-05-1MIN）。
    每个整秒对全部设备各写一条，时间戳对齐到秒。
    """
    if not devices or not process_windows:
        return
    for window, fill_sec in zip(process_windows, seconds_per_window):
        if fill_sec <= 0:
            continue
        start, end = window.curve_window()
        if end <= start:
            continue
        base = start.replace(microsecond=0)
        if base < start:
            base += timedelta(seconds=1)
        for sec in range(int(fill_sec)):
            obs_time = base + timedelta(seconds=sec)
            if obs_time >= end:
                break
            for device in devices:
                yield _emit_atmosphere_row(
                    device,
                    obs_time,
                    id_gen,
                    process_windows,
                    ingest_delay_max_seconds,
                    rng,
                )


def iter_atmosphere_with_dense(
    devices: Sequence[AtmosphereDevice],
    t0: datetime,
    total_rows: int,
    calendar_months: int,
    id_gen: SnowflakeGenerator,
    process_windows: Sequence[ProcessWindow],
    ingest_delay_max_seconds: int,
    rng: random.Random,
    *,
    dense_minutes: int = 1,
    dense_full_window: bool = False,
) -> Iterator[tuple[list, list, int]]:
    """先写过程窗 1Hz 稠密段，再用剩余配额做按月均分铺点。"""
    seconds = plan_atmosphere_dense_seconds(
        process_windows,
        device_count=len(devices),
        total_rows=total_rows,
        dense_minutes=dense_minutes,
        dense_full_window=dense_full_window,
    )
    dense_rows = count_atmosphere_dense_rows(seconds, len(devices))
    if dense_rows > 0:
        yield from iter_atmosphere_dense_1hz(
            devices,
            process_windows,
            seconds,
            id_gen,
            ingest_delay_max_seconds,
            rng,
        )
    remain = max(0, int(total_rows) - dense_rows)
    if remain > 0:
        yield from iter_atmosphere_rows(
            devices=devices,
            t0=t0,
            total_rows=remain,
            calendar_months=calendar_months,
            id_gen=id_gen,
            process_windows=process_windows,
            ingest_delay_max_seconds=ingest_delay_max_seconds,
            rng=rng,
        )


def iter_atmosphere_full_1hz(
    devices: Sequence[AtmosphereDevice],
    start: datetime,
    end_exclusive: datetime,
    id_gen: SnowflakeGenerator,
    process_windows: Sequence[ProcessWindow],
    ingest_delay_max_seconds: int,
    rng: random.Random,
) -> Iterator[tuple[list, list, int]]:
    """
    在 [start, end) 内按秒铺满：每一秒对全部设备各写一条（真 1Hz，不去重叠秒）。
    行数 = device_count × floor((end-start).total_seconds())。
    """
    if not devices or end_exclusive <= start:
        return
    total_secs = int((end_exclusive - start).total_seconds())
    if total_secs <= 0:
        return
    base = start.replace(microsecond=0)
    if base < start:
        base += timedelta(seconds=1)
        total_secs = int((end_exclusive - base).total_seconds())
    for sec in range(max(total_secs, 0)):
        obs_time = base + timedelta(seconds=sec)
        if obs_time >= end_exclusive:
            break
        for device in devices:
            yield _emit_atmosphere_row(
                device,
                obs_time,
                id_gen,
                process_windows,
                ingest_delay_max_seconds,
                rng,
            )


def expected_full_1hz_rows(device_count: int, days: int) -> int:
    return max(int(device_count), 0) * max(int(days), 0) * 86400


def expand_atmosphere_devices(
    seed_devices: Sequence[AtmosphereDevice],
    *,
    target_count: int,
    lon0: float,
    lat0: float,
) -> list[AtmosphereDevice]:
    """将设备列表扩展/裁剪到 target_count；超出种子列表的用距离/方位生成。"""
    from generators.geo import point_at_distance

    n = max(int(target_count), 0)
    if n <= 0:
        return list(seed_devices)
    out: list[AtmosphereDevice] = []
    for i in range(1, n + 1):
        if i <= len(seed_devices):
            src = seed_devices[i - 1]
            out.append(
                AtmosphereDevice(
                    device_addr=f"ATM-DS-STD-{i:03d}",
                    type_id=src.type_id,
                    longitude=src.longitude,
                    latitude=src.latitude,
                )
            )
            continue
        distance_km = 0.5 + ((i - 1) % 60) * 0.45
        bearing_deg = float((i * 37) % 360)
        lon, lat = point_at_distance(lon0, lat0, distance_km, bearing_deg)
        out.append(
            AtmosphereDevice(
                device_addr=f"ATM-DS-STD-{i:03d}",
                type_id="01",
                longitude=lon,
                latitude=lat,
            )
        )
    return out
