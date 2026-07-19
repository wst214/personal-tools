"""雷击大网 / 小网 / biz 事件造数。"""

from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Iterator, Sequence

from generators.geo import is_valid_china_coordinate, random_point_in_annulus
from generators.id_gen import SnowflakeGenerator
from generators.process import ThunderstormProcessSpec


@dataclass(frozen=True)
class LightningBatch:
    cmb_rows: list[list]
    locator_rows: list[list]
    biz_rows: list[list]


CMB_COLUMNS = [
    "id",
    "raw_message_id",
    "source_type",
    "lightning_type",
    "strike_time",
    "longitude",
    "latitude",
    "peak_current",
    "height",
    "province",
    "city",
    "county",
    "province_code",
    "city_code",
    "county_code",
    "quality_status",
    "create_time",
    "update_time",
    "ext_json",
    "schema_version",
    "data_version",
]

# 与 03_partitioned_tables.sql standard_lightning_strike_locator 一致（lightning_point 由触发器生成）
LOCATOR_COLUMNS = [
    "id",
    "raw_message_id",
    "source_type",
    "lightning_type",
    "strike_time",
    "longitude",
    "latitude",
    "site_count",
    "province",
    "city",
    "county",
    "address",
    "province_code",
    "city_code",
    "county_code",
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
    "lightning_type",
    "strike_time",
    "longitude",
    "latitude",
    "peak_current",
    "height",
    "site_count",
    "province",
    "city",
    "county",
    "address",
    "display_name",
    "risk_level",
    "event_status",
    "create_time",
    "update_time",
    "ext_json",
    "schema_version",
    "data_version",
]


def _pick_strike_time(process: ThunderstormProcessSpec, rng: random.Random) -> datetime:
    start = process.strike_start
    end = process.strike_end
    span = max(int((end - start).total_seconds()), 1)
    return start + timedelta(seconds=rng.randint(0, span))


def _pick_location(
    dispatch_lon: float,
    dispatch_lat: float,
    category: str,
    rng: random.Random,
) -> tuple[float, float]:
    if category == "in_window":
        # 略小于 50km，避免平面近似坐标在 PostGIS geography 下略超 50000m
        return random_point_in_annulus(dispatch_lon, dispatch_lat, 0.5, 49.5, rng)
    if category == "boundary":
        return random_point_in_annulus(dispatch_lon, dispatch_lat, 45.0, 55.0, rng)
    return random_point_in_annulus(dispatch_lon, dispatch_lat, 55.0, 120.0, rng)


def _split_total(total: int, parts: int) -> list[int]:
    """将 total 尽量均匀分配到 parts 份，余数从前向后 +1。"""
    if parts <= 0:
        return []
    base = total // parts
    rem = total % parts
    return [base + (1 if i < rem else 0) for i in range(parts)]


def _in_50km_for_stream(
    stream_count: int,
    in_window_ratio: float,
    boundary_ratio: float,
    boundary_in_50km_ratio: float = 0.475,
) -> int:
    """与 category_for_index 分桶一致，估算单路（CMB/Locator）50km 内条数。"""
    if stream_count <= 0:
        return 0
    in_window = sum(1 for i in range(stream_count) if i / stream_count < in_window_ratio)
    boundary = sum(
        1
        for i in range(stream_count)
        if in_window_ratio <= i / stream_count < in_window_ratio + boundary_ratio
    )
    return in_window + int(boundary * boundary_in_50km_ratio)


def expected_in_50km_count(
    cmb_count: int,
    loc_count: int,
    in_window_ratio: float,
    boundary_ratio: float,
) -> int:
    """单过程 50km 内闪电期望条数（validate 与造数口径对齐）。"""
    total = _in_50km_for_stream(cmb_count, in_window_ratio, boundary_ratio) + _in_50km_for_stream(
        loc_count, in_window_ratio, boundary_ratio
    )
    return max(total, 1)


def generate_lightning_for_processes(
    processes: Sequence[ThunderstormProcessSpec],
    total_cmb: int,
    total_locator: int,
    dispatch_lon: float,
    dispatch_lat: float,
    id_gen: SnowflakeGenerator,
    in_window_ratio: float,
    boundary_ratio: float,
    outlier_ratio: float,
    rng: random.Random,
) -> LightningBatch:
    if not processes:
        return LightningBatch([], [], [])

    cmb_counts = _split_total(total_cmb, len(processes))
    loc_counts = _split_total(total_locator, len(processes))
    cmb_rows: list[list] = []
    locator_rows: list[list] = []
    biz_rows: list[list] = []

    def category_for_index(i: int, total: int) -> str:
        ratio = i / max(total, 1)
        if ratio < in_window_ratio:
            return "in_window"
        if ratio < in_window_ratio + boundary_ratio:
            return "boundary"
        return "outlier"

    for process, cmb_per, loc_per in zip(processes, cmb_counts, loc_counts):
        for i in range(cmb_per):
            category = category_for_index(i, cmb_per)
            strike_time = _pick_strike_time(process, rng)
            if category == "outlier" and rng.random() < 0.5:
                strike_time = process.process_end + timedelta(minutes=rng.randint(30, 180))
            lon, lat = _pick_location(dispatch_lon, dispatch_lat, category, rng)
            if not is_valid_china_coordinate(lon, lat):
                lon, lat = _pick_location(dispatch_lon, dispatch_lat, "in_window", rng)
            std_id = id_gen.next_id()
            create_time = strike_time + timedelta(seconds=rng.randint(0, 3))
            cmb_row = [
                std_id,
                id_gen.next_id(),
                "CMB",
                "+",
                strike_time,
                lon,
                lat,
                round(rng.uniform(5, 120), 6),
                round(rng.uniform(1000, 12000), 6),
                "陕西省",
                "西安市",
                "长安区",
                610000,
                610100,
                610116,
                "NORMAL",
                create_time,
                create_time,
                None,
                "1.0",
                "1.0",
            ]
            cmb_rows.append(cmb_row)
            biz_rows.append(
                [
                    id_gen.next_id(),
                    std_id,
                    "lightning-strike-cmb",
                    "CMB",
                    "+",
                    strike_time,
                    lon,
                    lat,
                    cmb_row[7],
                    cmb_row[8],
                    None,
                    "陕西省",
                    "西安市",
                    "长安区",
                    None,
                    "陕西省西安市长安区",
                    0,
                    "ACTIVE",
                    create_time,
                    create_time,
                    None,
                    "1.0",
                    "1.0",
                ]
            )

        for i in range(loc_per):
            category = category_for_index(i, loc_per)
            strike_time = _pick_strike_time(process, rng)
            if category == "outlier" and rng.random() < 0.5:
                strike_time = process.process_end + timedelta(minutes=rng.randint(30, 180))
            lon, lat = _pick_location(dispatch_lon, dispatch_lat, category, rng)
            if not is_valid_china_coordinate(lon, lat):
                lon, lat = _pick_location(dispatch_lon, dispatch_lat, "in_window", rng)
            std_id = id_gen.next_id()
            create_time = strike_time + timedelta(seconds=rng.randint(0, 3))
            site_count = rng.randint(4, 12)
            loc_row = [
                std_id,
                id_gen.next_id(),
                "LOCATOR",
                "+",
                strike_time,
                lon,
                lat,
                site_count,
                "陕西省",
                "西安市",
                "长安区",
                "陕西省西安市长安区",
                610000,
                610100,
                610116,
                "NORMAL" if site_count >= 4 else "LOW_QUALITY",
                create_time,
                create_time,
                None,
                "1.0",
                "1.0",
            ]
            locator_rows.append(loc_row)
            biz_rows.append(
                [
                    id_gen.next_id(),
                    std_id,
                    "lightning-strike-locator",
                    "LOCATOR",
                    "+",
                    strike_time,
                    lon,
                    lat,
                    None,
                    None,
                    site_count,
                    "陕西省",
                    "西安市",
                    "长安区",
                    "陕西省西安市长安区",
                    "陕西省西安市长安区",
                    0,
                    "ACTIVE",
                    create_time,
                    create_time,
                    None,
                    "1.0",
                    "1.0",
                ]
            )

    assert len(cmb_rows) == total_cmb, f"CMB 行数 {len(cmb_rows)} != 目标 {total_cmb}"
    assert len(locator_rows) == total_locator, f"Locator 行数 {len(locator_rows)} != 目标 {total_locator}"
    # biz 不独立造数：每条 standard 在同循环内派生 1 条 biz，行数恒为 cmb + locator
    assert len(biz_rows) == total_cmb + total_locator, (
        f"biz 行数 {len(biz_rows)} != cmb({total_cmb}) + locator({total_locator})"
    )
    return LightningBatch(cmb_rows, locator_rows, biz_rows)
