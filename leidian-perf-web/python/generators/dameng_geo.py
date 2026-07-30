"""达梦 DM8 空间距离（DMGEO2 原生；无 GEO 时 Haversine 仅作兜底）。"""

from __future__ import annotations

import math

_EARTH_RADIUS_M = 6371000
_PI = "3.14159265359"
_M_PER_DEG_LAT = 111_000.0
_DEFAULT_RADIUS_M = 50_000.0
_DEFAULT_BBOX_PREFILTER_M = 60_000.0  # 放宽外接框（米）；精算仍用 50km Geography ST_DWithin


def is_geo2_installed(conn: str) -> bool:
    """检测实例是否已安装并初始化 DMGEO2（SYSGEO2 schema 存在）。"""
    from generators.dm_exec import disql_scalar_int

    return (
        disql_scalar_int(
            conn,
            """
            SELECT COUNT(*) FROM SYS.SYSOBJECTS
            WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH'
            """,
        )
        > 0
    )


def probe_dm_instance_version(conn: str) -> str:
    """探测 DM8 实例版本（优先 id_code，其次 build_version）。"""
    from generators.dm_exec import disql_scalar

    for sql in (
        "SELECT ID_CODE()",
        "SELECT ID_CODE",
        "SELECT BUILD_VERSION FROM V$INSTANCE",
    ):
        try:
            val = disql_scalar(conn, sql)
            if val:
                return f"达梦 {val}"
        except Exception:  # noqa: BLE001
            continue
    banner = disql_scalar(conn, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1")
    return f"达梦 {banner}" if banner else "达梦 DM8"


def probe_geo_version_label(conn: str) -> str:
    """
    探测 DMGEO 空间模块标识。

    DMGEO2 无 PostGIS_Version() 类独立版本 API，版本随 DM8 实例发布；
    返回 DMGEO2/DMGEO1 标识，并附带实例 id_code/build 供报告核对。
    """
    from generators.dm_exec import disql_scalar, disql_scalar_int

    geo2_schema = disql_scalar_int(
        conn,
        """
        SELECT COUNT(*) FROM SYS.SYSOBJECTS
        WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH'
        """,
    )
    geo2_flag = 0
    geo1_flag = 0
    for sql in ("SELECT SF_CHECK_GEO2_SYS", "SELECT SF_CHECK_GEO2_SYS()"):
        try:
            geo2_flag = disql_scalar_int(conn, sql)
            break
        except Exception:  # noqa: BLE001
            continue
    for sql in ("SELECT SF_CHECK_GEO_SYS", "SELECT SF_CHECK_GEO_SYS()"):
        try:
            geo1_flag = disql_scalar_int(conn, sql)
            break
        except Exception:  # noqa: BLE001
            continue

    instance_ref = None
    for sql in ("SELECT ID_CODE()", "SELECT ID_CODE", "SELECT BUILD_VERSION FROM V$INSTANCE"):
        try:
            instance_ref = disql_scalar(conn, sql)
            if instance_ref:
                break
        except Exception:  # noqa: BLE001
            continue
    suffix = f" · 随 DM8 {instance_ref}" if instance_ref else ""

    if geo2_schema > 0 or geo2_flag == 1:
        return f"DMGEO2 (SYSGEO2){suffix}"
    if geo1_flag == 1:
        return f"DMGEO1（非 PERF 方案）{suffix}"
    return "GEO 未检测到"


def _rad(expr: str) -> str:
    return f"({expr}) * {_PI} / 180"


def dm_haversine_meters_sql(lon1: str, lat1: str, lon2: str, lat2: str) -> str:
    """两点经纬度之间的球面距离（米）；无 GEO 模块时的兜底。"""
    dlat = f"(({lat1}) - ({lat2})) * {_PI} / 180 / 2"
    dlon = f"(({lon1}) - ({lon2})) * {_PI} / 180 / 2"
    return (
        f"{_EARTH_RADIUS_M} * 2 * ASIN(SQRT("
        f"POWER(SIN({dlat}), 2) + "
        f"COS({_rad(lat2)}) * COS({_rad(lat1)}) * "
        f"POWER(SIN({dlon}), 2)"
        f"))"
    )


def dm_geom_to_geog_sql(geom_expr: str) -> str:
    """geometry(4326) → geography，使 ST_DWithin/ST_Distance 以米为单位。"""
    return f"DMGEO2.ST_GeomToGeog({geom_expr})"


def dm_geo_dwithin_sql(
    geom_a: str,
    geom_b: str,
    radius_m: float = _DEFAULT_RADIUS_M,
) -> str:
    """DMGEO2 50km 内过滤（米）；geometry 须先转 geography，否则 50000 会被当度。"""
    geog_a = dm_geom_to_geog_sql(geom_a)
    geog_b = dm_geom_to_geog_sql(geom_b)
    return f"DMGEO2.ST_DWithin({geog_a}, {geog_b}, {int(radius_m)})"


def dm_geo_distance_meters_sql(
    geom_a: str,
    geom_b: str,
    *,
    srid: int = 4326,
) -> str:
    """DMGEO2 空间距离（米）；geometry 须先转 geography。"""
    _ = srid
    geog_a = dm_geom_to_geog_sql(geom_a)
    geog_b = dm_geom_to_geog_sql(geom_b)
    return f"DMGEO2.ST_Distance({geog_a}, {geog_b})"


def dm_within_50km_sql(
    *,
    strike_geom: str = "l.lightning_point",
    ref_geom: str = "m.dispatch_room_point",
    strike_lon: str = "l.longitude",
    strike_lat: str = "l.latitude",
    ref_lon: str = "m.dispatch_room_lon",
    ref_lat: str = "m.dispatch_room_lat",
    use_geo2: bool = True,
) -> str:
    """50km 内过滤：ST_GeomToGeog + ST_DWithin（米）；use_geo2=False 时用 Haversine。"""
    if use_geo2:
        return (
            f"{strike_geom} IS NOT NULL "
            f"AND {ref_geom} IS NOT NULL "
            f"AND {dm_geo_dwithin_sql(strike_geom, ref_geom)}"
        )
    return (
        f"{strike_lon} IS NOT NULL AND {strike_lat} IS NOT NULL "
        f"AND {ref_lon} IS NOT NULL AND {ref_lat} IS NOT NULL "
        f"AND {dm_haversine_meters_sql(strike_lon, strike_lat, ref_lon, ref_lat)} <= 50000"
    )


def dm_bbox_for_radius_m(
    lon: float,
    lat: float,
    radius_m: float = _DEFAULT_RADIUS_M,
) -> tuple[float, float, float, float]:
    """以 (lon, lat) 为圆心、radius_m 为半径的外接 bbox（度）。"""
    pad = 1.0  # dm_within_50km_from_point_bbox_sql 单独放大 bbox 半径
    delta_lat = (radius_m / _M_PER_DEG_LAT) * pad
    cos_lat = max(math.cos(math.radians(lat)), 0.01)
    delta_lon = (radius_m / (_M_PER_DEG_LAT * cos_lat)) * pad
    return (lon - delta_lon, lon + delta_lon, lat - delta_lat, lat + delta_lat)


def dm_bbox_prefilter_sql(
    min_lon: float,
    max_lon: float,
    min_lat: float,
    max_lat: float,
    *,
    lon_col: str = "l.longitude",
    lat_col: str = "l.latitude",
) -> str:
    """经纬度外接框预筛（普通列过滤，缩小 ST_Distance 候选集）。"""
    return (
        f"{lon_col} BETWEEN {min_lon:.6f} AND {max_lon:.6f} "
        f"AND {lat_col} BETWEEN {min_lat:.6f} AND {max_lat:.6f}"
    )


def dm_within_50km_from_point_sql(lon: float, lat: float, radius_m: float = _DEFAULT_RADIUS_M) -> str:
    """压测场景：以固定经纬度为圆心，对 lightning_point 做 50km 过滤（Geography + ST_DWithin）。"""
    ref = f"DMGEO2.ST_PointFromText('POINT({lon} {lat})', 4326)"
    return (
        f"l.lightning_point IS NOT NULL "
        f"AND {dm_geo_dwithin_sql('l.lightning_point', ref, radius_m)}"
    )


def dm_within_50km_from_point_distance_sql(lon: float, lat: float, radius_m: float = _DEFAULT_RADIUS_M) -> str:
    """ST_Distance(Geography) <= radius；与 ST_DWithin 语义等价，仅诊断/对比用。"""
    ref = f"DMGEO2.ST_PointFromText('POINT({lon} {lat})', 4326)"
    radius = int(radius_m)
    return (
        f"l.lightning_point IS NOT NULL "
        f"AND {dm_geo_distance_meters_sql('l.lightning_point', ref)} <= {radius}"
    )


def dm_within_50km_from_point_relaxed_bbox_dwithin_sql(
    lon: float,
    lat: float,
    *,
    radius_m: float = _DEFAULT_RADIUS_M,
    bbox_prefilter_m: float = _DEFAULT_BBOX_PREFILTER_M,
) -> str:
    """
    扁平写法：60km lon/lat bbox + Geography ST_DWithin。

    注意：达梦优化器常忽略 bbox 而只走 strike_time 索引；压测 bbox 模式请用
    子查询 + INDEX(idx_biz_lightning_time_lon_lat)（见 dameng_sql_bench）。
    """
    bbox = dm_bbox_prefilter_for_point(lon, lat, bbox_prefilter_m=bbox_prefilter_m)
    ref = dm_point_from_text_sql(lon, lat)
    return (
        f"{bbox} "
        f"AND l.lightning_point IS NOT NULL "
        f"AND {dm_geo_dwithin_sql('l.lightning_point', ref, radius_m)}"
    )


def dm_point_from_text_sql(lon: float, lat: float, *, srid: int = 4326) -> str:
    return f"DMGEO2.ST_PointFromText('POINT({lon} {lat})', {srid})"


def dm_bbox_prefilter_for_point(
    lon: float,
    lat: float,
    *,
    bbox_prefilter_m: float = _DEFAULT_BBOX_PREFILTER_M,
    lon_col: str = "l.longitude",
    lat_col: str = "l.latitude",
) -> str:
    """以圆心半径生成 lon/lat BETWEEN 预筛条件。"""
    min_lon, max_lon, min_lat, max_lat = dm_bbox_for_radius_m(lon, lat, bbox_prefilter_m)
    return dm_bbox_prefilter_sql(
        min_lon, max_lon, min_lat, max_lat, lon_col=lon_col, lat_col=lat_col
    )


def dm_within_50km_from_point_bbox_sql(lon: float, lat: float, radius_m: float = _DEFAULT_RADIUS_M) -> str:
    """兼容旧导入；bbox 预筛已移除。"""
    return dm_within_50km_from_point_sql(lon, lat, radius_m)


def dm_within_50km_from_point_dwithin_sql(lon: float, lat: float, radius_m: float = _DEFAULT_RADIUS_M) -> str:
    """兼容别名；与 dm_within_50km_from_point_sql 相同。"""
    return dm_within_50km_from_point_sql(lon, lat, radius_m)
