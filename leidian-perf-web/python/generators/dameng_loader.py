"""达梦 DM8 造数编排（与 loader.py / psycopg2 完全隔离）。"""

from __future__ import annotations

import random
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

import yaml

from generators.atmosphere import (
    AtmosphereDevice,
    BIZ_COLUMNS as ATM_BIZ_COLUMNS,
    STD_COLUMNS as ATM_STD_COLUMNS,
    ProcessWindow,
    iter_atmosphere_rows,
)
from generators.dameng_conn import DamengConn, DamengRuntimeNotImplementedError
from generators.dameng_load_guard import load_advisory_lock
from generators.dm_exec import DisqlNotFoundError
from generators.dm_write import (
    call_create_monthly_partitions,
    format_dm_column_value,
    insert_rows,
    run_dm_script,
    truncate_tables,
)
from generators.geo import fence_wkt_square_multipolygon, point_at_distance
from generators.id_gen import SnowflakeGenerator
from generators.lightning import (
    BIZ_COLUMNS as LT_BIZ_COLUMNS,
    CMB_COLUMNS,
    LOCATOR_COLUMNS,
    generate_lightning_for_processes,
)
from generators.lowfreq import iter_lowfreq_rows
from generators.process import build_process_bundle
from generators.raw_budget import plan_raw_rows
from generators.raw_message import (
    RAW_COLUMNS,
    device_raw_row,
    iter_abnormal_raw_rows,
    iter_padding_device_raw,
    lightning_raw_row,
    radar_raw_row,
)
from generators.time_calendar import (
    calendar_data_end,
    calendar_month_start,
    resolve_calendar_months,
)

PARTITIONED_PARENTS = [
    "raw_kafka_message",
    "standard_atmosphere_electric_field",
    "biz_atmosphere_electric_field_event",
    "standard_lightning_strike_cmb",
    "standard_lightning_strike_locator",
    "biz_lightning_event",
]

TRUNCATE_ORDER = [
    "repair_order",
    "hidden_risk",
    "inspection_task",
    "thunderstorm_notice_event",
    "device_alarm_event",
    "thunderstorm_warning_message",
    "thunderstorm_warning_event",
    "thunderstorm_process",
    "biz_lightning_event",
    "standard_lightning_strike_locator",
    "standard_lightning_strike_cmb",
    "biz_atmosphere_electric_field_event",
    "standard_atmosphere_electric_field",
    "raw_kafka_message",
    "biz_surge_monitor_event",
    "standard_surge_monitor",
    "biz_ispd_pdu_event",
    "standard_ispd_pdu",
    "biz_spd_waveform_summary_event",
    "standard_spd_waveform_summary",
    "biz_spd_waveform_heartbeat_event",
    "standard_spd_waveform_heartbeat",
    "biz_disconnect_card_event",
    "standard_disconnect_card",
    "biz_power_board_event",
    "standard_power_board",
    "biz_remote_terminal_event",
    "standard_remote_terminal",
    "biz_surge_current_event",
    "standard_surge_current",
    "biz_grounding_resistance_event",
    "standard_grounding_resistance",
    "mine_site",
]

# 达梦全档位造数（与 PostgreSQL loader 隔离；大批量依赖 disql 批量 INSERT）


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _parse_t0(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _build_devices(mine_cfg: dict[str, Any]) -> list[AtmosphereDevice]:
    lon0 = float(mine_cfg["mine_site"]["dispatch_room_lon"])
    lat0 = float(mine_cfg["mine_site"]["dispatch_room_lat"])
    devices: list[AtmosphereDevice] = []
    for item in mine_cfg["atmosphere_devices"]:
        lon, lat = point_at_distance(lon0, lat0, float(item["distance_km"]), float(item["bearing_deg"]))
        devices.append(
            AtmosphereDevice(
                device_addr=item["device_addr"],
                type_id=str(item["type_id"]),
                longitude=lon,
                latitude=lat,
            )
        )
    return devices


def _emit(log: Callable[[str], None] | None, msg: str) -> None:
    if log:
        log(msg)


def _planning_table_specs(bundle: Any) -> list[tuple[str, list[str], list[list]]]:
    return [
        (
            "thunderstorm_process",
            [
                "id", "mine_code", "process_start_time", "process_end_time",
                "strike_start_time", "strike_end_time", "data_window_start", "data_window_end",
                "process_status", "create_time",
            ],
            [
                [
                    p.id, p.mine_code, p.process_start, p.process_end,
                    p.strike_start, p.strike_end, p.data_window_start, p.data_window_end,
                    p.process_status, p.process_start,
                ]
                for p in bundle.processes
            ],
        ),
        (
            "thunderstorm_warning_event",
            [
                "id", "thunderstorm_process_id", "mine_code", "event_start_time", "event_end_time",
                "current_warning_level", "max_warning_level", "event_status", "create_time",
            ],
            bundle.warning_events,
        ),
        (
            "thunderstorm_warning_message",
            [
                "id", "warning_event_id", "thunderstorm_process_id", "mine_code",
                "rule_code", "rule_name", "rule_summary", "data_source", "data_source_ref_id",
                "warning_time", "warning_level", "warning_action", "create_time",
            ],
            bundle.warning_messages,
        ),
        (
            "device_alarm_event",
            [
                "id", "thunderstorm_process_id", "mine_code", "device_addr", "alarm_time",
                "alarm_level", "alarm_code", "alarm_name", "alarm_status", "source_table",
                "source_record_id", "create_time",
            ],
            bundle.device_alarms,
        ),
        (
            "thunderstorm_notice_event",
            [
                "id", "thunderstorm_process_id", "warning_event_id", "warning_message_id", "mine_code",
                "notice_time", "notice_channel", "receiver", "receiver_role", "notice_title",
                "notice_content", "notice_status", "trigger_type", "trigger_event_id", "create_time",
            ],
            bundle.notice_events,
        ),
        (
            "inspection_task",
            [
                "id", "thunderstorm_process_id", "device_alarm_event_id", "mine_code", "device_addr",
                "task_status", "plan_time", "finish_time", "assignee", "create_time", "update_time",
                "ext_json", "schema_version", "data_version",
            ],
            bundle.inspection_tasks,
        ),
        (
            "hidden_risk",
            [
                "id", "thunderstorm_process_id", "inspection_task_id", "mine_code", "device_addr",
                "risk_level", "risk_desc", "rectify_status", "discover_time", "create_time",
            ],
            bundle.hidden_risks,
        ),
        (
            "repair_order",
            [
                "id", "thunderstorm_process_id", "hidden_risk_id", "mine_code", "device_addr",
                "repair_status", "repair_desc", "start_time", "close_time", "create_time",
            ],
            bundle.repair_orders,
        ),
    ]


def _insert_mine_site(conn: DamengConn, mine_cfg: dict[str, Any], t0: datetime) -> None:
    ms = mine_cfg["mine_site"]
    fence_wkt = fence_wkt_square_multipolygon(
        float(ms["dispatch_room_lon"]),
        float(ms["dispatch_room_lat"]),
    )
    cols = [
        "id", "mine_code", "mine_name", "unified_social_credit_code",
        "province_code", "city_code", "county_code", "address",
        "dispatch_room_lon", "dispatch_room_lat", "fence_geom", "status", "create_time",
    ]
    row = [
        ms["id"], ms["mine_code"], ms["mine_name"], ms["unified_social_credit_code"],
        ms["province_code"], ms["city_code"], ms["county_code"], ms["address"],
        ms["dispatch_room_lon"], ms["dispatch_room_lat"], fence_wkt, ms["status"], t0,
    ]
    vals = [format_dm_column_value(c, v) for c, v in zip(cols, row)]
    col_sql = ", ".join(cols)
    sql = f"INSERT INTO mine_site ({col_sql}) VALUES ({', '.join(vals)}); COMMIT;"
    run_dm_script(conn, sql)


def load_stage_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path | None = None,
    t0: datetime | None = None,
    truncate: bool = False,
    seed: int = 42,
    batch_size: int = 500,
    log: Callable[[str], None] | None = None,
) -> dict[str, int]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    mine_cfg = _load_yaml(root / "mine-sites.yaml")
    volume_cfg = _load_yaml(root / "volume-profiles.yaml")
    if stage not in volume_cfg["stages"]:
        raise ValueError(f"unknown stage: {stage}")

    profile = volume_cfg["stages"][stage]
    defaults = volume_cfg["defaults"]
    t0 = t0 or _parse_t0(defaults["t0"])
    rng = random.Random(seed)
    id_gen = SnowflakeGenerator(worker_id=1)
    devices = _build_devices(mine_cfg)
    atmosphere_rows = int(profile["atmosphere_rows"])
    calendar_months = resolve_calendar_months(stage, profile, defaults)
    data_end = calendar_data_end(t0, calendar_months)
    process_placement_end = data_end - timedelta(seconds=1)

    _emit(log, f"[DM {stage}] 生成雷暴过程与业务事件…")
    bundle = build_process_bundle(
        mine_code=mine_cfg["mine_site"]["mine_code"],
        process_count=int(profile["thunderstorm_process"]),
        warning_message_total=int(profile["warning_message"]),
        device_alarm_total=int(profile["device_alarm"]),
        notice_total=int(profile["notice_event"]),
        inspection_total=int(profile["inspection_task"]),
        hidden_risk_total=int(profile["hidden_risk"]),
        repair_total=int(profile["repair_order"]),
        t0=t0,
        atmosphere_end=process_placement_end,
        id_gen=id_gen,
        season_months=defaults["thunderstorm_season_months"],
        season_ratio=float(defaults["thunderstorm_season_ratio"]),
        duration_min=int(defaults["process_duration_min_minutes"]),
        duration_max=int(defaults["process_duration_max_minutes"]),
        notice_receivers=mine_cfg.get("notice_receivers", []),
        inspectors=mine_cfg.get("inspectors", []),
        rng=rng,
    )
    process_windows = [
        ProcessWindow(p.process_start, p.process_end, p.strike_start, p.strike_end)
        for p in bundle.processes
    ]

    _emit(log, f"[DM {stage}] 生成闪电数据…")
    lightning = generate_lightning_for_processes(
        processes=bundle.processes,
        total_cmb=int(profile["lightning_cmb"]),
        total_locator=int(profile["lightning_locator"]),
        dispatch_lon=float(mine_cfg["mine_site"]["dispatch_room_lon"]),
        dispatch_lat=float(mine_cfg["mine_site"]["dispatch_room_lat"]),
        id_gen=id_gen,
        in_window_ratio=float(defaults["lightning_in_window_ratio"]),
        boundary_ratio=float(defaults["lightning_boundary_ratio"]),
        outlier_ratio=float(defaults["lightning_outlier_ratio"]),
        rng=rng,
    )

    stats: dict[str, int] = {}

    def _run() -> dict[str, int]:
        nonlocal stats
        stats = {}
        partition_start = date(t0.year, t0.month, 1)
        partition_end = data_end.date()
        if partition_end < partition_start:
            partition_end = partition_start
        _emit(log, f"[DM {stage}] 检查/创建月分区 {partition_start} ~ {partition_end}…")
        for parent in PARTITIONED_PARENTS:
            call_create_monthly_partitions(conn, parent, partition_start, partition_end)

        if truncate:
            _emit(log, f"[DM {stage}] 清空 perf 表…")
            truncate_tables(conn, TRUNCATE_ORDER)

        _insert_mine_site(conn, mine_cfg, t0)
        stats["mine_site"] = 1

        for table, columns, rows in _planning_table_specs(bundle):
            stats[table] = insert_rows(conn, table, columns, rows, batch_size=batch_size)
        _emit(log, f"[DM {stage}] 规划表写入完成（{len(bundle.processes)} 个雷暴过程）")

        stats["standard_lightning_strike_cmb"] = insert_rows(
            conn, "standard_lightning_strike_cmb", CMB_COLUMNS, lightning.cmb_rows, batch_size=batch_size
        )
        stats["standard_lightning_strike_locator"] = insert_rows(
            conn, "standard_lightning_strike_locator", LOCATOR_COLUMNS, lightning.locator_rows, batch_size=batch_size
        )
        stats["biz_lightning_event"] = insert_rows(
            conn, "biz_lightning_event", LT_BIZ_COLUMNS, lightning.biz_rows, batch_size=batch_size
        )
        _emit(log, f"[DM {stage}] 闪电数据写入完成")

        offset_no = 0
        std_buffer: list[list] = []
        biz_buffer: list[list] = []
        raw_buffer: list[list] = []

        def flush_atmosphere() -> None:
            nonlocal std_buffer, biz_buffer, raw_buffer
            if std_buffer:
                stats["standard_atmosphere_electric_field"] = stats.get(
                    "standard_atmosphere_electric_field", 0
                ) + insert_rows(
                    conn,
                    "standard_atmosphere_electric_field",
                    ATM_STD_COLUMNS,
                    std_buffer,
                    batch_size=batch_size,
                )
                std_buffer = []
            if biz_buffer:
                stats["biz_atmosphere_electric_field_event"] = stats.get(
                    "biz_atmosphere_electric_field_event", 0
                ) + insert_rows(
                    conn,
                    "biz_atmosphere_electric_field_event",
                    ATM_BIZ_COLUMNS,
                    biz_buffer,
                    batch_size=batch_size,
                )
                biz_buffer = []
            if raw_buffer:
                stats["raw_kafka_message"] = stats.get("raw_kafka_message", 0) + insert_rows(
                    conn, "raw_kafka_message", RAW_COLUMNS, raw_buffer, batch_size=batch_size
                )
                raw_buffer = []
            done = stats.get("standard_atmosphere_electric_field", 0)
            if atmosphere_rows and done:
                pct = min(100, int(done * 100 / atmosphere_rows))
                _emit(log, f"[DM {stage}] 大气电场进度 {done:,}/{atmosphere_rows:,} ({pct}%)")

        _emit(log, f"[DM {stage}] 写入大气电场（目标 {atmosphere_rows:,} 行）…")
        for std_row, biz_row, raw_id in iter_atmosphere_rows(
            devices=devices,
            t0=t0,
            total_rows=atmosphere_rows,
            calendar_months=calendar_months,
            id_gen=id_gen,
            process_windows=process_windows,
            ingest_delay_max_seconds=int(defaults["ingest_delay_max_seconds"]),
            rng=rng,
        ):
            std_buffer.append(std_row)
            biz_buffer.append(biz_row)
            raw_buffer.append(
                device_raw_row(
                    raw_id=raw_id,
                    device_addr=str(std_row[2]),
                    receive_time=std_row[21],
                    offset_no=offset_no,
                )
            )
            offset_no += 1
            if len(std_buffer) >= batch_size:
                flush_atmosphere()
        flush_atmosphere()

        target_raw = int(profile["raw_rows"])
        lowfreq_total = int(profile["other_device_rows"])
        lowfreq_devices = mine_cfg.get("lowfreq_devices", [])
        radar_configured = int(profile.get("radar_raw_rows", 0))
        lightning_raw_count = len(lightning.cmb_rows) + len(lightning.locator_rows)
        radar_total, padding, abnormal_total = plan_raw_rows(
            target_raw=target_raw,
            atmosphere_rows=atmosphere_rows,
            lightning_raw_count=lightning_raw_count,
            lowfreq_raw_count=lowfreq_total,
            radar_configured=radar_configured,
        )

        _emit(log, f"[DM {stage}] 组装 raw / 低频设备报文（目标 {target_raw:,}）…")
        lowfreq_grouped: dict[str, dict[str, Any]] = {}
        for item in iter_lowfreq_rows(lowfreq_devices, lowfreq_total, t0, data_end, id_gen, rng):
            std_table, biz_table, std_cols, std_row, biz_cols, biz_row = item
            key = std_table
            if key not in lowfreq_grouped:
                lowfreq_grouped[key] = {
                    "biz_table": biz_table,
                    "std_cols": std_cols,
                    "biz_cols": biz_cols,
                    "std": [],
                    "biz": [],
                }
            lowfreq_grouped[key]["std"].append(std_row)
            lowfreq_grouped[key]["biz"].append(biz_row)
            raw_buffer.append(
                device_raw_row(
                    raw_id=int(std_row[1][0]),
                    device_addr=str(std_row[2]),
                    receive_time=std_row[-5],
                    offset_no=offset_no,
                )
            )
            offset_no += 1

        for cmb in lightning.cmb_rows:
            raw_buffer.append(
                lightning_raw_row(
                    raw_id=int(cmb[1]),
                    topic="lightning-strike-cmb",
                    source_type="CMB",
                    receive_time=cmb[16],
                    offset_no=offset_no,
                )
            )
            offset_no += 1
        for loc in lightning.locator_rows:
            raw_buffer.append(
                lightning_raw_row(
                    raw_id=int(loc[1]),
                    topic="lightning-strike-locator",
                    source_type="LOCATOR",
                    receive_time=loc[16],
                    offset_no=offset_no,
                )
            )
            offset_no += 1

        span_hours = max(int((data_end - t0).total_seconds() // 3600), 1)
        for i in range(radar_total):
            hour_offset = (i * span_hours) // max(radar_total, 1)
            receive_time = t0 + timedelta(hours=hour_offset)
            raw_buffer.append(radar_raw_row(id_gen.next_id(), receive_time, offset_no))
            offset_no += 1

        if padding:
            raw_buffer.extend(
                list(
                    iter_padding_device_raw(
                        start_offset=offset_no,
                        count=padding,
                        t0=t0,
                        span_end=data_end,
                        id_gen=id_gen,
                        rng=rng,
                    )
                )
            )
            offset_no += padding

        if abnormal_total:
            raw_buffer.extend(
                list(
                    iter_abnormal_raw_rows(
                        start_offset=offset_no,
                        count=abnormal_total,
                        t0=t0,
                        span_end=data_end,
                        id_gen=id_gen,
                        rng=rng,
                    )
                )
            )

        final_raw = stats.get("raw_kafka_message", 0) + len(raw_buffer)
        if final_raw != target_raw:
            raise RuntimeError(
                f"raw 行数校验失败：期望 {target_raw}，实际 {final_raw} "
                f"(atmosphere={atmosphere_rows}, lightning={lightning_raw_count}, "
                f"lowfreq={lowfreq_total}, radar={radar_total}, padding={padding}, "
                f"abnormal={abnormal_total})"
            )

        if raw_buffer:
            _emit(log, f"[DM {stage}] 写入剩余 raw 报文（{len(raw_buffer):,} 行）...")
            stats["raw_kafka_message"] = stats.get("raw_kafka_message", 0) + insert_rows(
                conn, "raw_kafka_message", RAW_COLUMNS, raw_buffer, batch_size=batch_size
            )
            _emit(log, f"[DM {stage}] 剩余 raw 报文写入完成")

        for std_table, payload in lowfreq_grouped.items():
            _emit(
                log,
                f"[DM {stage}] 写入低频设备表 {std_table} / {payload['biz_table']} "
                f"（{len(payload['std']):,} + {len(payload['biz']):,} 行）...",
            )
            stats[std_table] = stats.get(std_table, 0) + insert_rows(
                conn, std_table, payload["std_cols"], payload["std"], batch_size=batch_size
            )
            stats[payload["biz_table"]] = stats.get(payload["biz_table"], 0) + insert_rows(
                conn, payload["biz_table"], payload["biz_cols"], payload["biz"], batch_size=batch_size
            )
            _emit(log, f"[DM {stage}] 低频设备表 {std_table} / {payload['biz_table']} 写入完成")

        stats["raw_target"] = target_raw
        stats["raw_radar"] = radar_total
        stats["raw_padding"] = padding
        stats["raw_lowfreq"] = lowfreq_total
        stats["raw_abnormal"] = abnormal_total
        _emit(log, f"[DM {stage}] raw 报文写入完成：{stats.get('raw_kafka_message', 0):,} 行")
        _emit(log, f"[DM {stage}] 达梦造数完成")
        return stats

    try:
        with load_advisory_lock(conn, log=log):
            return _run()
    except DisqlNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc
