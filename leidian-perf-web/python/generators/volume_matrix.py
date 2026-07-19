"""各阶段、各物理表造数目标行数（与 loader / validate 一致）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from generators.raw_budget import plan_raw_rows

# (表名, 中文说明, 配置键或 None 表示由 lowfreq 拆分)
TABLE_SPECS: list[tuple[str, str, str | None]] = [
    ("mine_site", "矿区", "mine_site"),
    ("thunderstorm_process", "雷暴过程", "thunderstorm_process"),
    ("standard_atmosphere_electric_field", "大气电场 standard", "atmosphere_rows"),
    ("biz_atmosphere_electric_field_event", "大气电场 biz", "atmosphere_rows"),
    ("standard_lightning_strike_cmb", "大网雷击 CMB", "lightning_cmb"),
    ("standard_lightning_strike_locator", "小网雷击 Locator", "lightning_locator"),
    ("biz_lightning_event", "雷击业务事件", "biz_lightning_event"),
    ("thunderstorm_warning_event", "预警事件", "warning_event"),
    ("thunderstorm_warning_message", "预警信息", "warning_message"),
    ("device_alarm_event", "设备告警", "device_alarm"),
    ("thunderstorm_notice_event", "工况联动", "notice_event"),
    ("inspection_task", "巡检任务", "inspection_task"),
    ("hidden_risk", "隐患记录", "hidden_risk"),
    ("repair_order", "维修工单", "repair_order"),
    ("raw_kafka_message", "原始报文 raw", "raw_rows"),
    ("standard_grounding_resistance", "接地电阻 standard", "lowfreq"),
    ("biz_grounding_resistance_event", "接地电阻 biz", "lowfreq"),
    ("standard_surge_current", "浪涌电流 standard", "lowfreq"),
    ("biz_surge_current_event", "浪涌电流 biz", "lowfreq"),
    ("standard_spd_waveform_heartbeat", "SPD 心跳 standard", "lowfreq"),
    ("biz_spd_waveform_heartbeat_event", "SPD 心跳 biz", "lowfreq"),
    ("standard_spd_waveform_summary", "SPD 波形 standard", "lowfreq"),
    ("biz_spd_waveform_summary_event", "SPD 波形 biz", "lowfreq"),
    ("standard_remote_terminal", "远程终端 standard", "lowfreq"),
    ("biz_remote_terminal_event", "远程终端 biz", "lowfreq"),
    ("standard_power_board", "电源板 standard", "lowfreq"),
    ("biz_power_board_event", "电源板 biz", "lowfreq"),
    ("standard_disconnect_card", "断开卡 standard", "lowfreq"),
    ("biz_disconnect_card_event", "断开卡 biz", "lowfreq"),
    ("standard_ispd_pdu", "iSPD PDU standard", "lowfreq"),
    ("biz_ispd_pdu_event", "iSPD PDU biz", "lowfreq"),
    ("standard_surge_monitor", "浪涌监测 standard", "lowfreq"),
    ("biz_surge_monitor_event", "浪涌监测 biz", "lowfreq"),
]

LOWFREQ_TABLE_BY_KEY = {
    "grounding_resistance": (
        "standard_grounding_resistance",
        "biz_grounding_resistance_event",
    ),
    "surge_current": ("standard_surge_current", "biz_surge_current_event"),
    "spd_waveform_heartbeat": (
        "standard_spd_waveform_heartbeat",
        "biz_spd_waveform_heartbeat_event",
    ),
    "spd_waveform_summary": (
        "standard_spd_waveform_summary",
        "biz_spd_waveform_summary_event",
    ),
    "remote_terminal": ("standard_remote_terminal", "biz_remote_terminal_event"),
    "power_board": ("standard_power_board", "biz_power_board_event"),
    "disconnect_card": ("standard_disconnect_card", "biz_disconnect_card_event"),
    "ispd_pdu": ("standard_ispd_pdu", "biz_ispd_pdu_event"),
    "surge_monitor": ("standard_surge_monitor", "biz_surge_monitor_event"),
}


def _load_profile(config_dir: Path, stage: str) -> dict[str, Any]:
    with (config_dir / "volume-profiles.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if stage not in cfg["stages"]:
        raise ValueError(f"unknown stage: {stage}")
    return cfg["stages"][stage]


def _load_lowfreq_devices(config_dir: Path) -> list[dict[str, Any]]:
    with (config_dir / "mine-sites.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)["lowfreq_devices"]


def split_lowfreq_counts(total_rows: int, devices: list[dict[str, Any]]) -> dict[str, int]:
    """与 lowfreq.iter_lowfreq_rows 分配规则一致。"""
    out: dict[str, int] = {}
    for _, (std, biz) in LOWFREQ_TABLE_BY_KEY.items():
        out[std] = 0
        out[biz] = 0
    if total_rows <= 0 or not devices:
        return out
    per_device = max(total_rows // len(devices), 1)
    by_type: dict[str, int] = {k: 0 for k in LOWFREQ_TABLE_BY_KEY}
    emitted = 0
    for dev in devices:
        if emitted >= total_rows:
            break
        by_type[dev["table"]] = by_type.get(dev["table"], 0) + per_device
        emitted += per_device
    while emitted < total_rows:
        dev = devices[emitted % len(devices)]
        by_type[dev["table"]] = by_type.get(dev["table"], 0) + 1
        emitted += 1

    for key, (std, biz) in LOWFREQ_TABLE_BY_KEY.items():
        n = by_type.get(key, 0)
        out[std] = n
        out[biz] = n
    return out


def stage_total_target_rows(stage: str, config_dir: Path | None = None) -> int:
    """各阶段造数完成后 perf 全表目标行数合计（与 build_expected_counts 一致）。"""
    return sum(build_expected_counts(stage, config_dir).values())


def format_total_rows_label(total: int) -> str:
    """阶段结论表括号内展示：约3.8万条 / 约2707万条 / 约1.17亿条。"""
    if total >= 100_000_000:
        yi = total / 100_000_000
        text = f"{yi:.2f}".rstrip("0").rstrip(".")
        return f"约{text}亿条"
    if total >= 10_000:
        wan = total / 10_000
        text = f"{wan:.1f}".rstrip("0").rstrip(".") if wan < 1000 else f"{round(wan)}"
        return f"约{text}万条"
    return f"约{total:,}条"


def build_expected_counts(stage: str, config_dir: Path | None = None) -> dict[str, int]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    profile = _load_profile(root, stage)
    cmb = int(profile["lightning_cmb"])
    loc = int(profile["lightning_locator"])
    counts: dict[str, int] = {
        "mine_site": int(profile["mine_site"]),
        "thunderstorm_process": int(profile["thunderstorm_process"]),
        "standard_atmosphere_electric_field": int(profile["atmosphere_rows"]),
        "biz_atmosphere_electric_field_event": int(profile["atmosphere_rows"]),
        "standard_lightning_strike_cmb": cmb,
        "standard_lightning_strike_locator": loc,
        "biz_lightning_event": cmb + loc,
        "thunderstorm_warning_event": int(profile["warning_event"]),
        "thunderstorm_warning_message": int(profile["warning_message"]),
        "device_alarm_event": int(profile["device_alarm"]),
        "thunderstorm_notice_event": int(profile["notice_event"]),
        "inspection_task": int(profile["inspection_task"]),
        "hidden_risk": int(profile["hidden_risk"]),
        "repair_order": int(profile["repair_order"]),
        "raw_kafka_message": int(profile["raw_rows"]),
    }
    lowfreq = split_lowfreq_counts(int(profile["other_device_rows"]), _load_lowfreq_devices(root))
    counts.update(lowfreq)
    return counts


def raw_breakdown(stage: str, config_dir: Path | None = None) -> dict[str, int]:
    """raw 报文构成明细（与 raw_budget.plan_raw_rows 一致）。"""
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    profile = _load_profile(root, stage)
    target_raw = int(profile["raw_rows"])
    atmosphere = int(profile["atmosphere_rows"])
    lightning = int(profile["lightning_cmb"]) + int(profile["lightning_locator"])
    lowfreq = int(profile["other_device_rows"])
    radar_cfg = int(profile.get("radar_raw_rows", 0))
    radar, padding, abnormal = plan_raw_rows(target_raw, atmosphere, lightning, lowfreq, radar_cfg)
    return {
        "raw_atmosphere": atmosphere,
        "raw_lightning": lightning,
        "raw_lowfreq": lowfreq,
        "raw_radar": radar,
        "raw_padding": padding,
        "raw_abnormal": abnormal,
        "raw_total": target_raw,
    }


def build_volume_rows(
    stage: str,
    actual_counts: dict[str, int] | None = None,
    config_dir: Path | None = None,
) -> list[dict[str, Any]]:
    targets = build_expected_counts(stage, config_dir)
    rows: list[dict[str, Any]] = []
    for table_key, label, _ in TABLE_SPECS:
        target = targets.get(table_key, 0)
        actual = actual_counts.get(table_key) if actual_counts else None
        passed = actual is not None and actual == target
        note = ""
        if actual is not None and not passed:
            note = f"偏差 {actual - target:+d}"
        elif actual is None:
            note = "未造数"
        rows.append(
            {
                "objectKey": table_key,
                "label": label,
                "target": target,
                "actual": actual,
                "passed": passed if actual is not None else None,
                "note": note,
            }
        )
    return rows


def all_stages_volume_matrix(config_dir: Path | None = None) -> dict[str, list[dict[str, Any]]]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    with (root / "volume-profiles.yaml").open(encoding="utf-8") as f:
        stages = yaml.safe_load(f)["stages"]
    return {code: build_word_volume_rows(code, None, root) for code in stages}


LOWFREQ_STD_TABLES = [std for std, _ in LOWFREQ_TABLE_BY_KEY.values()]


def _load_word_config(config_dir: Path) -> dict[str, Any]:
    with (config_dir / "word-volume-targets.yaml").open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def _word_actual(spec: dict[str, Any], physical_counts: dict[str, int]) -> int | None:
    if spec.get("aggregate") == "lowfreq_standard_sum":
        if not physical_counts:
            return None
        return sum(physical_counts.get(t, 0) for t in LOWFREQ_STD_TABLES)
    table = spec.get("table")
    if not table or not physical_counts:
        return None
    return physical_counts.get(table)


def build_word_volume_rows(
    stage: str,
    physical_counts: dict[str, int] | None = None,
    config_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """Word §3.2 业务对象行：目标来自 word-volume-targets，实际来自物理表统计。"""
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    cfg = _load_word_config(root)
    stage_targets = cfg["stages"][stage]
    rows: list[dict[str, Any]] = []
    for spec in cfg["objects"]:
        key = spec["key"]
        target = int(stage_targets[key])
        actual = _word_actual(spec, physical_counts) if physical_counts else None
        # Word 记录：实际 ≥ 目标即达标，超出不算未达标
        passed = actual is not None and actual >= target
        note = ""
        if actual is None:
            note = "未造数"
        elif actual < target:
            note = f"不足 {target - actual}"
        elif actual > target:
            note = f"超出 +{actual - target}"
        rows.append(
            {
                "objectKey": key,
                "label": spec["label"],
                "target": target,
                "actual": actual,
                "passed": passed if actual is not None else None,
                "note": note,
                "source": "word",
            }
        )
    return rows


def build_physical_volume_rows(
    stage: str,
    actual_counts: dict[str, int] | None = None,
    config_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """物理表明细（造数/校验技术目标）。"""
    return build_volume_rows(stage, actual_counts, config_dir)
