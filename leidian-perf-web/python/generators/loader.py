"""造数编排：按阶段加载 perf schema。"""

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
    count_atmosphere_dense_rows,
    expand_atmosphere_devices,
    expected_full_1hz_rows,
    iter_atmosphere_full_1hz,
    iter_atmosphere_with_dense,
    plan_atmosphere_dense_seconds,
)
from generators.db import copy_rows, ensure_monthly_partitions, pg_connection
from generators.load_guard import load_advisory_lock
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
    add_months,
    calendar_data_end,
    calendar_month_start,
    months_covering,
    resolve_atmosphere_span,
    resolve_calendar_months,
)
from generators.volume_matrix import atmosphere_biz_only, atmosphere_raw_contribution

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


def truncate_perf_tables(cur, schema: str) -> None:
    for table in TRUNCATE_ORDER:
        cur.execute(f"TRUNCATE TABLE {schema}.{table} CASCADE")


def _emit(log: Callable[[str], None] | None, msg: str) -> None:
    if log:
        log(msg)
    else:
        print(msg, flush=True)


def _commit_phase(conn, log: Callable[[str], None] | None, label: str) -> None:
    """分段提交，避免 S2+ 整档单事务过长导致 WAL/连接超时。"""
    conn.commit()
    _emit(log, f"  ↳ 已提交：{label}")


def load_stage(
    stage: str,
    dsn: str,
    schema: str = "perf",
    config_dir: Path | None = None,
    t0: datetime | None = None,
    truncate: bool = False,
    seed: int = 42,
    batch_size: int = 50000,
    log: Callable[[str], None] | None = None,
) -> dict[str, int]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    mine_cfg = _load_yaml(root / "mine-sites.yaml")
    volume_cfg = _load_yaml(root / "volume-profiles.yaml")
    if stage not in volume_cfg["stages"]:
        raise ValueError(f"unknown stage: {stage}, expected one of {list(volume_cfg['stages'])}")

    profile = volume_cfg["stages"][stage]
    defaults = volume_cfg["defaults"]
    t0 = t0 or _parse_t0(defaults["t0"])
    rng = random.Random(seed)
    id_gen = SnowflakeGenerator(worker_id=1)
    seed_devices = _build_devices(mine_cfg)
    device_target = int(profile.get("atmosphere_device_count") or len(seed_devices))
    devices = expand_atmosphere_devices(
        seed_devices,
        target_count=device_target,
        lon0=float(mine_cfg["mine_site"]["dispatch_room_lon"]),
        lat0=float(mine_cfg["mine_site"]["dispatch_room_lat"]),
    )
    device_count = len(devices)

    atm_start, atm_end, full_1hz = resolve_atmosphere_span(profile, defaults, t0=t0)
    atmosphere_rows = int(profile["atmosphere_rows"])
    biz_only = atmosphere_biz_only(profile)
    if full_1hz:
        days = max(int(profile.get("atmosphere_days", 1)), 1)
        expected = expected_full_1hz_rows(device_count, days)
        if atmosphere_rows != expected:
            _emit(
                log,
                f"[{stage}] 警告：atmosphere_rows={atmosphere_rows:,} 与 "
                f"{device_count}台×{days}天×86400={expected:,} 不一致，按公式行数写入",
            )
            atmosphere_rows = expected
        # 过程落在满密窗内，保证 PERF-05 有 1Hz；分区多留 1 个月供写入压测
        process_t0 = atm_start
        process_placement_end = atm_end - timedelta(seconds=1)
        partition_end = add_months(atm_end.replace(day=1, hour=0, minute=0, second=0, microsecond=0), 2)
        data_end = partition_end
        calendar_months = months_covering(atm_start, partition_end)
        layer_note = "仅 biz" if biz_only else "行/层"
        _emit(
            log,
            f"[{stage}] 时间轴：真 1Hz {atm_start.isoformat(sep=' ', timespec='seconds')} ~ "
            f"{atm_end.isoformat(sep=' ', timespec='seconds')}（{days} 天 · {device_count} 台 · "
            f"目标 {atmosphere_rows:,} {layer_note}）",
        )
    else:
        calendar_months = resolve_calendar_months(stage, profile, defaults)
        data_end = calendar_data_end(t0, calendar_months)
        process_t0 = t0
        process_placement_end = data_end - timedelta(seconds=1)
        _emit(
            log,
            f"[{stage}] 时间轴：{t0.date()} 起 {calendar_months} 个自然月（至 "
            f"{calendar_month_start(t0, calendar_months - 1).strftime('%Y-%m')}），大气按月均分",
        )
    _emit(log, f"[{stage}] 生成雷暴过程与业务事件…")
    bundle = build_process_bundle(
        mine_code=mine_cfg["mine_site"]["mine_code"],
        process_count=int(profile["thunderstorm_process"]),
        warning_message_total=int(profile["warning_message"]),
        device_alarm_total=int(profile["device_alarm"]),
        notice_total=int(profile["notice_event"]),
        inspection_total=int(profile["inspection_task"]),
        hidden_risk_total=int(profile["hidden_risk"]),
        repair_total=int(profile["repair_order"]),
        t0=process_t0,
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
        ProcessWindow(
            p.process_start,
            p.process_end,
            p.strike_start,
            p.strike_end,
            p.data_window_start,
            p.data_window_end,
        )
        for p in bundle.processes
    ]

    _emit(
        log,
        f"[{stage}] 生成闪电数据（CMB {int(profile['lightning_cmb']):,} · "
        f"Locator {int(profile['lightning_locator']):,}）…",
    )
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
    if biz_only:
        _emit(
            log,
            f"[{stage}] 目标：大气电场 biz {atmosphere_rows:,} 行（跳过 std/raw 大气）· "
            f"raw {int(profile['raw_rows']):,} 行",
        )
    else:
        _emit(log, f"[{stage}] 目标：大气电场 {atmosphere_rows:,} 行 · raw {int(profile['raw_rows']):,} 行")

    with load_advisory_lock(dsn, log=log):
        return _load_stage_body(
            stage=stage,
            dsn=dsn,
            schema=schema,
            profile=profile,
            defaults=defaults,
            t0=t0,
            truncate=truncate,
            batch_size=batch_size,
            log=log,
            mine_cfg=mine_cfg,
            devices=devices,
            device_count=device_count,
            atmosphere_rows=atmosphere_rows,
            biz_only=biz_only,
            calendar_months=calendar_months,
            data_end=data_end,
            atm_start=atm_start,
            atm_end=atm_end,
            full_1hz=full_1hz,
            bundle=bundle,
            lightning=lightning,
            process_windows=process_windows,
            id_gen=id_gen,
            rng=rng,
        )


def _load_stage_body(
    *,
    stage: str,
    dsn: str,
    schema: str,
    profile: dict[str, Any],
    defaults: dict[str, Any],
    t0: datetime,
    truncate: bool,
    batch_size: int,
    log: Callable[[str], None] | None,
    mine_cfg: dict[str, Any],
    devices: list[AtmosphereDevice],
    device_count: int,
    atmosphere_rows: int,
    biz_only: bool,
    calendar_months: int,
    data_end: datetime,
    atm_start: datetime,
    atm_end: datetime,
    full_1hz: bool,
    bundle: Any,
    lightning: Any,
    process_windows: list[ProcessWindow],
    id_gen: SnowflakeGenerator,
    rng: random.Random,
) -> dict[str, int]:
    stats: dict[str, int] = {}

    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            _emit(log, f"[{stage}] 检查/创建月分区…")
            partition_anchor = atm_start if full_1hz else t0
            partition_start = date(partition_anchor.year, partition_anchor.month, 1)
            # data_end 为时间轴上界（不含）；raw.receive_time 可能因 ingest_delay 或
            # padding 随机到该月初，须建到 data_end 所在月（含），不能只建到最后数据月。
            partition_end = data_end.date()
            if partition_end < partition_start:
                partition_end = partition_start
            ensure_monthly_partitions(cur, schema, partition_start, partition_end, PARTITIONED_PARENTS)
            _emit(
                log,
                f"[{stage}] 月分区范围 {partition_start} ~ {partition_end}（{calendar_months} 个自然月 + 边界缓冲）",
            )

            if truncate:
                _emit(log, f"[{stage}] 清空 perf 表…")
                truncate_perf_tables(cur, schema)

            ms = mine_cfg["mine_site"]
            fence_wkt = fence_wkt_square_multipolygon(
                float(ms["dispatch_room_lon"]),
                float(ms["dispatch_room_lat"]),
            )
            cur.execute(
                f"""
                INSERT INTO {schema}.mine_site (
                    id, mine_code, mine_name, unified_social_credit_code,
                    province_code, city_code, county_code, address,
                    dispatch_room_lon, dispatch_room_lat, fence_geom, status, create_time
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    ST_SetSRID(ST_GeomFromText(%s), 4326), %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                    mine_code = EXCLUDED.mine_code,
                    mine_name = EXCLUDED.mine_name,
                    dispatch_room_lon = EXCLUDED.dispatch_room_lon,
                    dispatch_room_lat = EXCLUDED.dispatch_room_lat,
                    fence_geom = EXCLUDED.fence_geom
                """,
                (
                    ms["id"],
                    ms["mine_code"],
                    ms["mine_name"],
                    ms["unified_social_credit_code"],
                    ms["province_code"],
                    ms["city_code"],
                    ms["county_code"],
                    ms["address"],
                    ms["dispatch_room_lon"],
                    ms["dispatch_room_lat"],
                    fence_wkt,
                    ms["status"],
                    t0,
                ),
            )
            _commit_phase(conn, log, "分区 / 矿区")

            def insert_copy(table: str, columns: list[str], rows: list[list], chunk: int | None = None) -> int:
                if not rows:
                    return 0
                return copy_rows(
                    cur,
                    f"{schema}.{table}",
                    columns,
                    rows,
                    batch_size=chunk or batch_size,
                )

            for table, columns, rows in [
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
                ("device_alarm_event", [
                    "id", "thunderstorm_process_id", "mine_code", "device_addr", "alarm_time",
                    "alarm_level", "alarm_code", "alarm_name", "alarm_status", "source_table",
                    "source_record_id", "create_time",
                ], bundle.device_alarms),
                ("thunderstorm_notice_event", [
                    "id", "thunderstorm_process_id", "warning_event_id", "warning_message_id", "mine_code",
                    "notice_time", "notice_channel", "receiver", "receiver_role", "notice_title",
                    "notice_content", "notice_status", "trigger_type", "trigger_event_id", "create_time",
                ], bundle.notice_events),
                ("inspection_task", [
                    "id", "thunderstorm_process_id", "device_alarm_event_id", "mine_code", "device_addr",
                    "task_status", "plan_time", "finish_time", "assignee", "create_time", "update_time",
                    "ext_json", "schema_version", "data_version",
                ], bundle.inspection_tasks),
                ("hidden_risk", [
                    "id", "thunderstorm_process_id", "inspection_task_id", "mine_code", "device_addr",
                    "risk_level", "risk_desc", "rectify_status", "discover_time", "create_time",
                ], bundle.hidden_risks),
                ("repair_order", [
                    "id", "thunderstorm_process_id", "hidden_risk_id", "mine_code", "device_addr",
                    "repair_status", "repair_desc", "start_time", "close_time", "create_time",
                ], bundle.repair_orders),
            ]:
                stats[table] = insert_copy(table, columns, rows)
            _emit(
                log,
                f"[{stage}] 基础表写入完成（过程/预警/工单等 {len(bundle.processes)} 个雷暴过程）",
            )
            _commit_phase(conn, log, "基础表（过程/预警/工单等）")

            stats["standard_lightning_strike_cmb"] = insert_copy(
                "standard_lightning_strike_cmb", list(CMB_COLUMNS), lightning.cmb_rows
            )
            stats["standard_lightning_strike_locator"] = insert_copy(
                "standard_lightning_strike_locator", list(LOCATOR_COLUMNS), lightning.locator_rows
            )
            stats["biz_lightning_event"] = insert_copy(
                "biz_lightning_event", list(LT_BIZ_COLUMNS), lightning.biz_rows
            )
            _emit(
                log,
                f"[{stage}] 闪电数据写入：CMB {len(lightning.cmb_rows):,} · "
                f"Locator {len(lightning.locator_rows):,} · "
                f"Biz {len(lightning.biz_rows):,}",
            )
            _commit_phase(conn, log, "闪电数据")

            offset_no = 0
            raw_rows_buffer: list[list] = []

            def flush_raw() -> None:
                nonlocal raw_rows_buffer
                if raw_rows_buffer:
                    stats["raw_kafka_message"] = stats.get("raw_kafka_message", 0) + insert_copy(
                        "raw_kafka_message", list(RAW_COLUMNS), raw_rows_buffer
                    )
                    raw_rows_buffer = []

            std_buffer: list[list] = []
            biz_buffer: list[list] = []

            def flush_atmosphere() -> None:
                nonlocal std_buffer, biz_buffer
                if std_buffer:
                    stats["standard_atmosphere_electric_field"] = stats.get(
                        "standard_atmosphere_electric_field", 0
                    ) + insert_copy("standard_atmosphere_electric_field", list(ATM_STD_COLUMNS), std_buffer)
                    std_buffer = []
                if biz_buffer:
                    stats["biz_atmosphere_electric_field_event"] = stats.get(
                        "biz_atmosphere_electric_field_event", 0
                    ) + insert_copy("biz_atmosphere_electric_field_event", list(ATM_BIZ_COLUMNS), biz_buffer)
                    biz_buffer = []
                flush_raw()
                conn.commit()
                done = stats.get(
                    "biz_atmosphere_electric_field_event"
                    if biz_only
                    else "standard_atmosphere_electric_field",
                    0,
                )
                if atmosphere_rows:
                    pct = min(100, int(done * 100 / atmosphere_rows))
                    _emit(log, f"[{stage}] 大气电场进度 {done:,}/{atmosphere_rows:,} ({pct}%)")

            if full_1hz:
                mode_note = "仅 biz，跳过 std/raw 大气" if biz_only else "std+biz+raw"
                _emit(
                    log,
                    f"[{stage}] 写入大气电场（真 1Hz 满密 {atmosphere_rows:,} 行 · "
                    f"{device_count} 台 · {mode_note} · "
                    f"{atm_start.isoformat(sep=' ', timespec='seconds')} ~ "
                    f"{atm_end.isoformat(sep=' ', timespec='seconds')}）…",
                )
                atm_iter = iter_atmosphere_full_1hz(
                    devices=devices,
                    start=atm_start,
                    end_exclusive=atm_end,
                    id_gen=id_gen,
                    process_windows=process_windows,
                    ingest_delay_max_seconds=int(defaults["ingest_delay_max_seconds"]),
                    rng=rng,
                )
            else:
                dense_minutes = int(defaults.get("atmosphere_dense_minutes", 1))
                dense_full = bool(defaults.get("atmosphere_dense_full_window", False))
                if "atmosphere_dense_minutes" in profile:
                    dense_minutes = int(profile["atmosphere_dense_minutes"])
                if "atmosphere_dense_full_window" in profile:
                    dense_full = bool(profile["atmosphere_dense_full_window"])
                dense_secs = plan_atmosphere_dense_seconds(
                    process_windows,
                    device_count=len(devices),
                    total_rows=atmosphere_rows,
                    dense_minutes=dense_minutes,
                    dense_full_window=dense_full,
                )
                dense_rows = count_atmosphere_dense_rows(dense_secs, len(devices))
                _emit(
                    log,
                    f"[{stage}] 写入大气电场（目标 {atmosphere_rows:,} 行；"
                    f"过程窗 1Hz 稠密 {dense_rows:,} 行，"
                    f"{'整窗' if dense_full else f'每过程前 {dense_minutes} 分钟'}）…",
                )
                atm_iter = iter_atmosphere_with_dense(
                    devices=devices,
                    t0=t0,
                    total_rows=atmosphere_rows,
                    calendar_months=calendar_months,
                    id_gen=id_gen,
                    process_windows=process_windows,
                    ingest_delay_max_seconds=int(defaults["ingest_delay_max_seconds"]),
                    rng=rng,
                    dense_minutes=dense_minutes,
                    dense_full_window=dense_full,
                )

            for std_row, biz_row, raw_id in atm_iter:
                biz_buffer.append(biz_row)
                if not biz_only:
                    std_buffer.append(std_row)
                    raw_rows_buffer.append(
                        device_raw_row(
                            raw_id=raw_id,
                            device_addr=str(std_row[2]),
                            receive_time=std_row[21],
                            offset_no=offset_no,
                        )
                    )
                    offset_no += 1
                if len(biz_buffer) >= batch_size:
                    flush_atmosphere()

            flush_atmosphere()
            _emit(
                log,
                f"[{stage}] 大气电场完成：standard {stats.get('standard_atmosphere_electric_field', 0):,} · "
                f"biz {stats.get('biz_atmosphere_electric_field_event', 0):,}",
            )
            _commit_phase(conn, log, "大气电场" + ("" if biz_only else " + 关联 raw"))

            target_raw = int(profile["raw_rows"])
            _emit(log, f"[{stage}] 组装 raw / 低频设备报文（目标 {target_raw:,}）…")
            lightning_raw_count = len(lightning.cmb_rows) + len(lightning.locator_rows)
            lowfreq_total = int(profile["other_device_rows"])
            lowfreq_devices = mine_cfg.get("lowfreq_devices", [])
            radar_configured = int(profile.get("radar_raw_rows", 0))
            atm_raw_rows = atmosphere_raw_contribution(profile)
            # biz_only 时 atmosphere_rows 仅表示 biz 目标，不计入 raw 预算
            if biz_only:
                atm_raw_rows = 0
            radar_total, padding, abnormal_total = plan_raw_rows(
                target_raw=target_raw,
                atmosphere_rows=atm_raw_rows,
                lightning_raw_count=lightning_raw_count,
                lowfreq_raw_count=lowfreq_total,
                radar_configured=radar_configured,
            )

            lowfreq_grouped: dict[str, dict[str, Any]] = {}
            lowfreq_span_start = atm_start if full_1hz else t0
            for item in iter_lowfreq_rows(
                lowfreq_devices, lowfreq_total, lowfreq_span_start, data_end, id_gen, rng
            ):
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
                raw_id = int(std_row[1][0])
                raw_rows_buffer.append(
                    device_raw_row(
                        raw_id=raw_id,
                        device_addr=str(std_row[2]),
                        receive_time=std_row[-5],
                        offset_no=offset_no,
                    )
                )
                offset_no += 1

            for cmb in lightning.cmb_rows:
                raw_rows_buffer.append(
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
                raw_rows_buffer.append(
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
                raw_rows_buffer.append(radar_raw_row(id_gen.next_id(), receive_time, offset_no))
                offset_no += 1

            if padding:
                raw_rows_buffer.extend(
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
                raw_rows_buffer.extend(
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

            final_raw = stats.get("raw_kafka_message", 0) + len(raw_rows_buffer)
            if final_raw != target_raw:
                raise RuntimeError(
                    f"raw 行数校验失败：期望 {target_raw}，实际 {final_raw} "
                    f"(atmosphere={atmosphere_rows}, lightning={lightning_raw_count}, "
                    f"lowfreq={lowfreq_total}, radar={radar_total}, padding={padding}, "
                    f"abnormal={abnormal_total})"
                )

            flush_raw()
            _commit_phase(conn, log, "补充 raw 报文")
            _emit(log, f"[{stage}] raw 报文写入完成：{stats.get('raw_kafka_message', 0):,} 行")
            stats["raw_target"] = target_raw
            stats["raw_radar"] = radar_total
            stats["raw_padding"] = padding
            stats["raw_lowfreq"] = lowfreq_total
            stats["raw_abnormal"] = abnormal_total

            for std_table, payload in lowfreq_grouped.items():
                stats[std_table] = insert_copy(std_table, payload["std_cols"], payload["std"])
                stats[payload["biz_table"]] = insert_copy(payload["biz_table"], payload["biz_cols"], payload["biz"])
            if lowfreq_grouped:
                _commit_phase(conn, log, "低频设备 standard/biz")

    stats["stage"] = stage  # type: ignore[assignment]
    _emit(log, f"[{stage}] 造数完成，共写入 {sum(v for k, v in stats.items() if isinstance(v, int) and k != 'stage'):,} 行（含各表累计）")
    return stats
