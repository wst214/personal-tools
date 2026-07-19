"""raw_kafka_message 造数（设备 / 闪电 / 雷达占位）。"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Iterator

from generators.id_gen import SnowflakeGenerator

RAW_COLUMNS = [
    "id",
    "topic",
    "partition_no",
    "offset_no",
    "message_key",
    "message_timestamp",
    "headers_json",
    "raw_value",
    "raw_value_type",
    "source_type",
    "trace_id",
    "dedup_key",
    "process_status",
    "error_message",
    "receive_time",
    "create_time",
    "update_time",
    "ext_json",
    "schema_version",
    "data_version",
]


def device_raw_row(
    raw_id: int,
    device_addr: str,
    receive_time: datetime,
    offset_no: int,
    partition_no: int = 0,
) -> list:
    return [
        raw_id,
        "device-raw-data",
        partition_no,
        offset_no,
        device_addr,
        int(receive_time.timestamp() * 1000),
        None,
        f"PERF_HEX_{device_addr}_{offset_no:012d}",
        "HEX",
        "DEVICE_RAW",
        f"perf-{raw_id}",
        f"dedup-{raw_id}",
        "SUCCESS",
        None,
        receive_time,
        receive_time,
        receive_time,
        None,
        "1.0",
        "1.0",
    ]


def lightning_raw_row(
    raw_id: int,
    topic: str,
    source_type: str,
    receive_time: datetime,
    offset_no: int,
) -> list:
    return [
        raw_id,
        topic,
        0,
        offset_no,
        None,
        int(receive_time.timestamp() * 1000),
        None,
        f'{{"perf":true,"source":"{source_type}"}}',
        "JSON",
        source_type,
        f"perf-{raw_id}",
        f"dedup-{raw_id}",
        "SUCCESS",
        None,
        receive_time,
        receive_time,
        receive_time,
        None,
        "1.0",
        "1.0",
    ]


def radar_raw_row(raw_id: int, receive_time: datetime, offset_no: int) -> list:
    return [
        raw_id,
        "radar-realtime",
        0,
        offset_no,
        None,
        int(receive_time.timestamp() * 1000),
        None,
        '{"perf":true,"type":"radar-realtime"}',
        "JSON",
        "RADAR_REALTIME",
        f"perf-{raw_id}",
        f"dedup-{raw_id}",
        "SUCCESS",
        None,
        receive_time,
        receive_time,
        receive_time,
        None,
        "1.0",
        "1.0",
    ]


def iter_padding_device_raw(
    start_offset: int,
    count: int,
    t0: datetime,
    span_end: datetime,
    id_gen: SnowflakeGenerator,
    rng: random.Random,
) -> Iterator[list]:
    span_sec = max(int((span_end - t0).total_seconds()), 1)
    for i in range(count):
        receive_time = t0 + timedelta(seconds=rng.randint(0, span_sec))
        yield device_raw_row(id_gen.next_id(), "PADDING-DEVICE", receive_time, start_offset + i)


_ABNORMAL_VARIANTS: list[tuple[str, str | None, str]] = [
    ("FAILED", "parse error: invalid checksum", "HEX"),
    ("FAILED", "device response timeout", "HEX"),
    ("FAILED", None, "JSON"),
]


def abnormal_raw_row(
    raw_id: int,
    device_addr: str,
    receive_time: datetime,
    offset_no: int,
    variant: int,
) -> list:
    """约 0.1% 异常 raw：解析失败 / 格式错误（§6.3）。"""
    status, error_message, value_type = _ABNORMAL_VARIANTS[variant % len(_ABNORMAL_VARIANTS)]
    if value_type == "JSON":
        raw_value = '{"perf":true,"malformed":'
    else:
        raw_value = f"PERF_BAD_{device_addr}_{offset_no:012d}"
    return [
        raw_id,
        "device-raw-data",
        0,
        offset_no,
        device_addr,
        int(receive_time.timestamp() * 1000),
        None,
        raw_value,
        value_type,
        "DEVICE_RAW",
        f"perf-{raw_id}",
        f"dedup-{raw_id}",
        status,
        error_message,
        receive_time,
        receive_time,
        receive_time,
        None,
        "1.0",
        "1.0",
    ]


def iter_abnormal_raw_rows(
    start_offset: int,
    count: int,
    t0: datetime,
    span_end: datetime,
    id_gen: SnowflakeGenerator,
    rng: random.Random,
) -> Iterator[list]:
    span_sec = max(int((span_end - t0).total_seconds()), 1)
    for i in range(count):
        receive_time = t0 + timedelta(seconds=rng.randint(0, span_sec))
        yield abnormal_raw_row(
            id_gen.next_id(),
            "ABNORMAL-DEVICE",
            receive_time,
            start_offset + i,
            i,
        )
