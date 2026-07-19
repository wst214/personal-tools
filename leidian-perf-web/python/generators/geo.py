"""地理坐标工具：极坐标偏移、中国大陆范围校验。"""

from __future__ import annotations

import math
import random


def point_at_distance(lon0: float, lat0: float, distance_km: float, bearing_deg: float) -> tuple[float, float]:
    """以 bearing_deg 方位（0=北，顺时针）在 distance_km 处生成点。"""
    theta = math.radians(bearing_deg)
    lat = lat0 + (distance_km / 111.32) * math.cos(theta)
    lon = lon0 + (distance_km / (111.32 * math.cos(math.radians(lat0)))) * math.sin(theta)
    return round(lon, 6), round(lat, 6)


def random_point_in_annulus(
    lon0: float,
    lat0: float,
    min_km: float,
    max_km: float,
    rng: random.Random,
) -> tuple[float, float]:
    bearing = rng.uniform(0, 360)
    distance = math.sqrt(rng.uniform(min_km * min_km, max_km * max_km))
    return point_at_distance(lon0, lat0, distance, bearing)


def is_valid_china_coordinate(lon: float, lat: float) -> bool:
    return 73.0 <= lon <= 135.0 and 3.0 <= lat <= 54.0


def fence_wkt_square_multipolygon(lon0: float, lat0: float, half_side_km: float = 2.0) -> str:
    """以调度机房为中心生成矩形围栏 MultiPolygon WKT（§6 主数据 fence_geom）。"""
    dlat = half_side_km / 111.32
    dlon = half_side_km / (111.32 * math.cos(math.radians(lat0)))
    west = round(lon0 - dlon, 6)
    east = round(lon0 + dlon, 6)
    south = round(lat0 - dlat, 6)
    north = round(lat0 + dlat, 6)
    ring = f"{west} {south},{east} {south},{east} {north},{west} {north},{west} {south}"
    return f"MULTIPOLYGON((({ring})))"
