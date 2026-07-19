"""达梦空间 SQL 与校验口径全量自检。"""
from __future__ import annotations

import os
from pathlib import Path

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, dm_fetch_scalar, setup_dm_bench_session
from generators.dameng_geo import (
    dm_geo_dwithin_sql,
    dm_within_50km_from_point_sql,
    dm_within_50km_sql,
)
from generators.dameng_sql_bench import resolve_context_dameng, sql_preview_for_scenario
from generators.dameng_validate import validate_stage_dameng
from generators.lightning import _split_total, expected_in_50km_count
import yaml

ISSUES: list[str] = []
OK: list[str] = []


def check(cond: bool, ok: str, bad: str) -> None:
    if cond:
        OK.append(ok)
    else:
        ISSUES.append(bad)


def main() -> None:
    conn = DamengConn(
        host=os.environ.get("DMHOST", "192.168.1.41"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "SYSDBA"),
        password=os.environ.get("DMPASSWORD"),
        schema="PERF",
    )
    cfg_dir = Path(__file__).resolve().parent / "config"
    with (cfg_dir / "volume-profiles.yaml").open(encoding="utf-8") as f:
        vol = yaml.safe_load(f)
    profiles = vol["stages"]
    defaults = vol.get("defaults", {})
    s0 = profiles["S0"]
    in_r = float(defaults.get("lightning_in_window_ratio", 0.85))
    bnd_r = float(defaults.get("lightning_boundary_ratio", 0.10))
    proc_n = int(s0["thunderstorm_process"])
    cmb = _split_total(int(s0["lightning_cmb"]), proc_n)
    loc = _split_total(int(s0["lightning_locator"]), proc_n)
    expected = [expected_in_50km_count(c, l, in_r, bnd_r) for c, l in zip(cmb, loc)]

    # --- static SQL checks ---
    perf06 = sql_preview_for_scenario("PERF-06-count", resolve_context_dameng(conn))
    check("ST_GeomToGeog" in perf06, "PERF-06 SQL 含 GeomToGeog", "PERF-06 SQL 缺少 GeomToGeog")
    check("BETWEEN" not in perf06, "PERF-06 SQL 无 bbox", "PERF-06 SQL 仍含 bbox BETWEEN")
    check(
        "ST_GeomToGeog" in dm_within_50km_sql(),
        "校验 dm_within_50km_sql 含 GeomToGeog",
        "校验 dm_within_50km_sql 未转 Geography",
    )
    check(
        "ST_GeomToGeog" in dm_geo_dwithin_sql("a", "b"),
        "dm_geo_dwithin_sql 含 GeomToGeog",
        "dm_geo_dwithin_sql 未转 Geography",
    )
    ctx = resolve_context_dameng(conn)
    geo_filter = dm_within_50km_from_point_sql(ctx.lon, ctx.lat)
    check("ST_GeomToGeog" in geo_filter, "压测 geo filter 正确", "压测 geo filter 有问题")

    # --- live count checks ---
    cnt_perf06 = dm_fetch_scalar(conn, perf06.replace("AS lightning_count", ""))
    cnt_validate_sql = f"""
    SELECT count(*) FROM biz_lightning_event l
    JOIN thunderstorm_process p ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
    JOIN mine_site m ON m.mine_code = p.mine_code
    WHERE p.id = (SELECT min(id) FROM thunderstorm_process)
      AND {dm_within_50km_sql()}
    """
    cnt_proc = dm_fetch_scalar(conn, cnt_validate_sql)
    check(
        cnt_perf06 == cnt_proc,
        f"PERF-06 count={cnt_perf06} 与校验单过程 count={cnt_proc} 一致",
        f"PERF-06({cnt_perf06}) 与校验口径({cnt_proc}) 不一致",
    )

    # validate run
    results = validate_stage_dameng(stage="S0", conn=conn, config_dir=cfg_dir)
    failed = [r for r in results if not r.passed]
    geo_failed = [r for r in failed if r.name.startswith("geo:")]
    check(not geo_failed, "达梦 S0 地理校验全通过", f"地理校验失败: {[(r.name, r.detail) for r in geo_failed]}")
    if failed:
        ISSUES.append(f"其它校验失败 {len(failed)} 项: {[(r.name, r.detail) for r in failed[:5]]}")
    else:
        OK.append("达梦 S0 全部校验通过")

    print("=== OK ===")
    for line in OK:
        print(f"  [OK] {line}")
    print("=== ISSUES ===")
    if ISSUES:
        for line in ISSUES:
            print(f"  [!] {line}")
    else:
        print("  (none)")
    print(f"\nexpected_in_50km per process (S0): {expected}, min={min(expected)}")


if __name__ == "__main__":
    main()
