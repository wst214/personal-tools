"""各档位单过程闪电计算表。"""
from __future__ import annotations

import yaml
from pathlib import Path

from generators.lightning import _split_total, expected_in_50km_count

vol = yaml.safe_load(Path(__file__).resolve().parent.joinpath("config/volume-profiles.yaml").read_text(encoding="utf-8"))
d = vol["defaults"]
in_r = float(d["lightning_in_window_ratio"])
bnd_r = float(d["lightning_boundary_ratio"])

header = (
    f"{'档位':<4} {'过程数':>6} {'CMB':>8} {'Locator':>8} "
    f"{'闪电合计':>8} {'÷过程数':>8} {'CMB/过程':>8} {'Loc/过程':>8} {'50km期望':>8}"
)
print(header)
print("-" * len(header.encode("utf-8")) + " (approx)")
for stage, p in vol["stages"].items():
    n = int(p["thunderstorm_process"])
    cmb = int(p["lightning_cmb"])
    loc = int(p["lightning_locator"])
    total = cmb + loc
    avg = total / n
    cmb_s = _split_total(cmb, n)
    loc_s = _split_total(loc, n)
    exp = expected_in_50km_count(cmb_s[0], loc_s[0], in_r, bnd_r)
    print(
        f"{stage:<4} {n:>6} {cmb:>8,} {loc:>8,} {total:>8,} "
        f"{avg:>8.1f} {cmb_s[0]:>8} {loc_s[0]:>8} {exp:>8}"
    )
