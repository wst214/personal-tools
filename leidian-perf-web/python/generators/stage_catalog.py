"""分阶段造数目标（来自 volume-profiles.yaml）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from generators.volume_matrix import format_total_rows_label, stage_total_target_rows

STAGE_LABELS = {
    "S0": "建模验证",
    "S1": "基线档",
    "S2": "增长档",
    "S3": "压力档",
    "S4": "推荐存量档",
    "S5": "压测加压档",
    "S6": "加压扩展档",
    "S7": "200台15天真1Hz",
    "S8": "100台30天真1Hz",
    "S9": "500台30天仅biz",
}


def _fmt_wan(n: int) -> str:
    if n >= 10_000_000:
        return f"{n / 10_000_000:.2f}千万".replace(".00", "")
    if n >= 10_000:
        return f"{n / 10_000:.0f}万"
    return str(n)


def load_stage_catalog(config_dir: Path | None = None) -> list[dict[str, Any]]:
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    with (root / "volume-profiles.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    stages: list[dict[str, Any]] = []
    for code, profile in cfg["stages"].items():
        atm = int(profile["atmosphere_rows"])
        raw = int(profile["raw_rows"])
        cmb = int(profile["lightning_cmb"])
        loc = int(profile["lightning_locator"])
        total_rows = stage_total_target_rows(code, root)
        if profile.get("atmosphere_biz_only"):
            summary = f"大气biz {_fmt_wan(atm)} · raw {_fmt_wan(raw)}"
        else:
            summary = f"大气 {_fmt_wan(atm)} · raw {_fmt_wan(raw)}"
        stages.append(
            {
                "code": code,
                "label": STAGE_LABELS.get(code, code),
                "summary": summary,
                "totalRows": total_rows,
                "totalRowsLabel": format_total_rows_label(total_rows),
                "targets": {
                    "mine_site": int(profile["mine_site"]),
                    "thunderstorm_process": int(profile["thunderstorm_process"]),
                    "atmosphere_rows": atm,
                    "atmosphere_device_count": int(profile.get("atmosphere_device_count") or 0) or None,
                    "raw_rows": raw,
                    "lightning_cmb": cmb,
                    "lightning_locator": loc,
                    "biz_lightning_event": cmb + loc,
                    "other_device_rows": int(profile["other_device_rows"]),
                    "device_alarm": int(profile["device_alarm"]),
                    "notice_event": int(profile["notice_event"]),
                },
            }
        )
    return stages
