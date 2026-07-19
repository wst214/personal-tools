"""低频设备 standard / biz 造数。"""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Iterator, Sequence

from generators.id_gen import SnowflakeGenerator

TABLE_MAP = {
    "grounding_resistance": (
        "standard_grounding_resistance",
        "biz_grounding_resistance_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "resistance_value", "temperature", "humidity", "ph_value", "soil_resistivity",
            "standby_battery_voltage", "measure_battery_voltage", "quality_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "resistance_value", "temperature", "humidity", "ph_value", "soil_resistivity",
            "standby_battery_voltage", "measure_battery_voltage", "risk_level", "event_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "surge_current": (
        "standard_surge_current",
        "biz_surge_current_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "lightning_strike_current", "lightning_strike_time", "lightning_strike_num",
            "battery_voltage", "voltage_state", "real_time", "longitude", "longitude_direction",
            "latitude", "latitude_direction", "card", "quality_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "lightning_strike_time", "lightning_strike_current", "lightning_strike_num",
            "battery_voltage", "voltage_state", "real_time", "longitude", "longitude_direction",
            "latitude", "latitude_direction", "card", "risk_level", "event_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "spd_waveform_heartbeat": (
        "standard_spd_waveform_heartbeat",
        "biz_spd_waveform_heartbeat_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "heartbeat_time", "heartbeat_frequency_minutes", "card", "quality_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "heartbeat_time", "heartbeat_frequency_minutes", "card", "risk_level", "event_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "spd_waveform_summary": (
        "standard_spd_waveform_summary",
        "biz_spd_waveform_summary_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "range_type", "positive_peak_current", "negative_peak_current",
            "positive_accumulated_value", "negative_accumulated_value", "strike_time", "waveform_hex",
            "quality_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "strike_time", "positive_peak_current", "negative_peak_current",
            "positive_accumulated_value", "negative_accumulated_value", "range_type", "waveform_hex",
            "risk_level", "event_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "remote_terminal": (
        "standard_remote_terminal",
        "biz_remote_terminal_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "power_supply_type", "voltage", "current", "active_power", "power_factor", "frequency",
            "total_active_energy", "relay_nc", "relay_24v", "relay_12v", "relay_6v",
            "dc_voltage_24v", "dc_voltage_12v", "dc_voltage_6v", "dc_voltage_5v", "quality_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "power_supply_type", "voltage", "current", "active_power", "power_factor", "frequency",
            "total_active_energy", "relay_nc", "relay_24v", "relay_12v", "relay_6v",
            "dc_voltage_24v", "dc_voltage_12v", "dc_voltage_6v", "dc_voltage_5v",
            "risk_level", "event_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "power_board": (
        "standard_power_board",
        "biz_power_board_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "voltage_15v", "voltage_24v", "voltage_12v", "voltage_6v", "upload_frequency", "card",
            "device_temperature", "fan_start_temperature", "fan_stop_temperature", "fan_control_status", "version",
            "quality_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "voltage_15v", "voltage_24v", "voltage_12v", "voltage_6v", "upload_frequency", "card",
            "device_temperature", "fan_start_temperature", "fan_stop_temperature", "fan_control_status", "version",
            "risk_level", "event_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "disconnect_card": (
        "standard_disconnect_card",
        "biz_disconnect_card_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "disconnect_status", "battery_voltage", "quality_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "disconnect_status", "battery_voltage", "risk_level", "event_status",
            "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "ispd_pdu": (
        "standard_ispd_pdu",
        "biz_ispd_pdu_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "lightning_strikes_number", "lightning_strikes_current", "environmental_humidity",
            "ambient_temperature", "target_temperature", "working_voltage", "leakage_current", "switch_status",
            "quality_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "lightning_strikes_number", "lightning_strikes_current", "environmental_humidity",
            "ambient_temperature", "target_temperature", "working_voltage", "leakage_current", "switch_status",
            "risk_level", "event_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
    "surge_monitor": (
        "standard_surge_monitor",
        "biz_surge_monitor_event",
        [
            "id", "raw_message_id", "device_addr", "type_id", "command_type",
            "leakage_current", "battery_voltage", "lightning_strikes_number", "lightning_strikes_current",
            "strike_time", "quality_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
        [
            "id", "standard_record_id", "source_topic", "source_type", "device_addr", "type_id", "command_type",
            "leakage_current", "battery_voltage", "lightning_strikes_number", "lightning_strikes_current",
            "strike_time", "risk_level", "event_status", "create_time", "update_time", "ext_json", "schema_version", "data_version",
        ],
    ),
}


def iter_lowfreq_rows(
    devices: Sequence[dict],
    total_rows: int,
    t0: datetime,
    span_end: datetime,
    id_gen: SnowflakeGenerator,
    rng: random.Random,
) -> Iterator[tuple[str, str, list, list]]:
    if not devices or total_rows <= 0:
        return
    span_minutes = max(int((span_end - t0).total_seconds() // 60), 1)
    per_device = max(total_rows // len(devices), 1)
    emitted = 0
    for dev in devices:
        table_key = dev["table"]
        std_table, biz_table, std_cols, biz_cols = TABLE_MAP[table_key]
        for i in range(per_device):
            if emitted >= total_rows:
                return
            std_id = id_gen.next_id()
            raw_id = id_gen.next_id()
            event_time = t0 + timedelta(minutes=rng.randint(0, span_minutes))
            create_time = event_time + timedelta(seconds=rng.randint(0, 3))
            std_row = _build_std_row(table_key, std_id, raw_id, dev, event_time, create_time, rng)
            biz_row = _build_biz_row(table_key, id_gen.next_id(), std_id, dev, std_row, create_time)
            emitted += 1
            yield std_table, biz_table, std_cols, std_row, biz_cols, biz_row


def _build_std_row(
    table_key: str,
    std_id: int,
    raw_id: int,
    dev: dict,
    event_time: datetime,
    create_time: datetime,
    rng: random.Random,
) -> list:
    base = [std_id, [raw_id], dev["device_addr"], dev["type_id"], "0001"]
    quality = "NORMAL"
    tail = [quality, create_time, create_time, None, "1.0", "1.0"]
    if table_key == "grounding_resistance":
        return base + [
            round(rng.uniform(1, 10), 2), round(rng.uniform(10, 35), 2), round(rng.uniform(30, 90), 2),
            round(rng.uniform(6, 8), 2), round(rng.uniform(50, 200), 2),
            round(rng.uniform(12, 13), 2), round(rng.uniform(12, 13), 2),
        ] + tail
    if table_key == "surge_current":
        return base + [
            round(rng.uniform(1, 50), 2), event_time, rng.randint(1, 5),
            round(rng.uniform(11, 13), 2), "0", event_time,
            109.12, "E", 34.25, "N", "CARD-01",
        ] + tail
    if table_key == "spd_waveform_heartbeat":
        return base + [event_time, 5, "CARD-SPD", ] + tail
    if table_key == "spd_waveform_summary":
        return base + [
            "FULL", round(rng.uniform(1, 20), 2), round(rng.uniform(-20, -1), 2),
            round(rng.uniform(0, 100), 4), round(rng.uniform(0, 100), 4),
            event_time, "ABCD0123",
        ] + tail
    if table_key == "remote_terminal":
        return base + [
            "AC", 220.0, 1.2, 200.0, 0.95, 50.0, 1000.0,
            "0", "1", "0", "0", 24.0, 12.0, 6.0, 5.0,
        ] + tail
    if table_key == "power_board":
        return base + [
            15.0, 24.0, 12.0, 6.0, 60, "CARD-PWB",
            35.0, 40, 30, "AUTO", "1.0",
        ] + tail
    if table_key == "disconnect_card":
        return base + ["CONNECTED", round(rng.uniform(11, 13), 2)] + tail
    if table_key == "ispd_pdu":
        return base + [
            rng.randint(0, 5), round(rng.uniform(1, 20), 2), round(rng.uniform(30, 90), 2),
            round(rng.uniform(10, 35), 2), round(rng.uniform(20, 40), 2),
            round(rng.uniform(220, 240), 2), round(rng.uniform(0, 5), 2), "00000000",
        ] + tail
    if table_key == "surge_monitor":
        return base + [
            round(rng.uniform(0, 5), 2), round(rng.uniform(11, 13), 2),
            rng.randint(0, 3), round(rng.uniform(1, 20), 2), event_time,
        ] + tail
    raise ValueError(f"unsupported table: {table_key}")


def _build_biz_row(
    table_key: str,
    biz_id: int,
    std_id: int,
    dev: dict,
    std_row: list,
    create_time: datetime,
) -> list:
    head = [biz_id, std_id, "device-raw-data", "DEVICE_RAW", dev["device_addr"], dev["type_id"], "0001"]
    tail = [0, "ACTIVE", create_time, create_time, None, "1.0", "1.0"]
    if table_key == "grounding_resistance":
        return head + std_row[5:12] + tail
    if table_key == "surge_current":
        # biz 列顺序：strike_time, strike_current, strike_num, battery..., geo..., card
        return head + [std_row[6], std_row[5], std_row[7]] + std_row[8:16] + tail
    if table_key == "spd_waveform_heartbeat":
        return head + std_row[5:8] + tail
    if table_key == "spd_waveform_summary":
        return head + [std_row[10], std_row[6], std_row[7], std_row[8], std_row[9], std_row[5], std_row[11]] + tail
    if table_key == "remote_terminal":
        return head + std_row[5:20] + tail
    if table_key == "power_board":
        return head + std_row[5:16] + tail
    if table_key == "disconnect_card":
        return head + std_row[5:7] + tail
    if table_key == "ispd_pdu":
        return head + std_row[5:13] + tail
    if table_key == "surge_monitor":
        return head + std_row[5:10] + tail
    raise ValueError(f"unsupported table: {table_key}")
