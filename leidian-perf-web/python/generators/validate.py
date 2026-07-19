"""造数结果校验（按阶段配置 + Word 方案 SQL 检查项）。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from generators.db import pg_connection
from generators.lightning import _split_total, expected_in_50km_count
from generators.raw_budget import abnormal_raw_count
from generators.volume_matrix import build_expected_counts


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str


LOWFREQ_PAIRS = [
    ("standard_grounding_resistance", "biz_grounding_resistance_event"),
    ("standard_surge_current", "biz_surge_current_event"),
    ("standard_spd_waveform_heartbeat", "biz_spd_waveform_heartbeat_event"),
    ("standard_spd_waveform_summary", "biz_spd_waveform_summary_event"),
    ("standard_remote_terminal", "biz_remote_terminal_event"),
    ("standard_power_board", "biz_power_board_event"),
    ("standard_disconnect_card", "biz_disconnect_card_event"),
    ("standard_ispd_pdu", "biz_ispd_pdu_event"),
    ("standard_surge_monitor", "biz_surge_monitor_event"),
]

LIGHTNING_STD_BIZ_PAIRS = [
    ("standard_lightning_strike_cmb", "CMB"),
    ("standard_lightning_strike_locator", "LOCATOR"),
]


def _load_profile(config_dir: Path, stage: str) -> dict[str, Any]:
    with (config_dir / "volume-profiles.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if stage not in cfg["stages"]:
        raise ValueError(f"unknown stage: {stage}")
    return cfg["stages"][stage]


def _load_defaults(config_dir: Path) -> dict[str, Any]:
    with (config_dir / "volume-profiles.yaml").open(encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return cfg.get("defaults", {})


def _scalar(cur, sql: str, params: tuple = ()) -> Any:
    cur.execute(sql, params)
    row = cur.fetchone()
    return row[0] if row else None


def _per_process_targets(profile: dict[str, Any]) -> dict[str, int]:
    """与 process.py _split_counts 分配规则一致。"""
    n = max(int(profile["thunderstorm_process"]), 1)

    def _range(total: int) -> tuple[int, int]:
        base = total // n
        return base, base + (1 if total % n else 0)

    alarm_min, alarm_max = _range(int(profile["device_alarm"]))
    notice_min, notice_max = _range(int(profile["notice_event"]))
    inspect_min, inspect_max = _range(int(profile["inspection_task"]))
    return {
        "msg_per": max(int(profile["warning_message"]) // n, 2),
        "alarm_min": alarm_min,
        "alarm_max": alarm_max,
        "notice_min": notice_min,
        "notice_max": notice_max,
        "inspect_min": inspect_min,
        "inspect_max": inspect_max,
    }


def _check_std_biz_1_1(
    cur,
    schema: str,
    std_table: str,
    biz_table: str,
    biz_source_type: str | None = None,
) -> tuple[int, int, int]:
    join_extra = f" AND b.source_type = '{biz_source_type}'" if biz_source_type else ""
    biz_filter = f" WHERE source_type = '{biz_source_type}'" if biz_source_type else ""
    orphan_filter = (
        f" WHERE b.source_type = '{biz_source_type}' AND s.id IS NULL"
        if biz_source_type
        else " WHERE s.id IS NULL"
    )
    missing = _scalar(
        cur,
        f"""
        SELECT count(*) FROM {schema}.{std_table} s
        LEFT JOIN {schema}.{biz_table} b
          ON b.standard_record_id = s.id{join_extra}
        WHERE b.id IS NULL
        """,
    )
    orphan = _scalar(
        cur,
        f"""
        SELECT count(*) FROM {schema}.{biz_table} b
        LEFT JOIN {schema}.{std_table} s ON s.id = b.standard_record_id
        {orphan_filter}
        """,
    )
    dup = _scalar(
        cur,
        f"""
        SELECT count(*) - count(DISTINCT standard_record_id)
        FROM {schema}.{biz_table}
        {biz_filter}
        """,
    )
    return int(missing), int(orphan), int(dup)


def validate_stage(
    stage: str,
    dsn: str,
    schema: str = "perf",
    config_dir: Path | None = None,
) -> list[CheckResult]:
    from generators.load_guard import assert_no_load_in_progress

    assert_no_load_in_progress(dsn, "执行数据校验")
    root = config_dir or Path(__file__).resolve().parent.parent / "config"
    profile = _load_profile(root, stage)
    defaults = _load_defaults(root)
    results: list[CheckResult] = []

    process_count = int(profile["thunderstorm_process"])
    per_proc = _per_process_targets(profile)
    in_window_ratio = float(defaults.get("lightning_in_window_ratio", 0.85))
    boundary_ratio = float(defaults.get("lightning_boundary_ratio", 0.10))

    cmb_counts = _split_total(int(profile["lightning_cmb"]), max(process_count, 1))
    loc_counts = _split_total(int(profile["lightning_locator"]), max(process_count, 1))
    per_process_expected = [
        expected_in_50km_count(cmb, loc, in_window_ratio, boundary_ratio)
        for cmb, loc in zip(cmb_counts, loc_counts)
    ]
    expected_50km = min(per_process_expected) if per_process_expected else 1
    band_low = max(int(min(per_process_expected) * 0.5), 1) if per_process_expected else 1
    band_high = max(int(max(per_process_expected) * 1.5), band_low) if per_process_expected else 1

    expected = build_expected_counts(stage, root)

    with pg_connection(dsn, schema=schema) as conn:
        with conn.cursor() as cur:
            for table, exp in expected.items():
                cnt = _scalar(cur, f"SELECT count(*) FROM {schema}.{table}")
                ok = cnt == exp
                results.append(
                    CheckResult(
                        f"row_count:{table}",
                        ok,
                        f"expected={exp}, actual={cnt}",
                    )
                )

            invalid_lightning = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.biz_lightning_event
                WHERE longitude NOT BETWEEN 73 AND 135
                   OR latitude NOT BETWEEN 3 AND 54
                """,
            )
            results.append(
                CheckResult(
                    "geo:lightning_bounds",
                    invalid_lightning == 0,
                    f"invalid_lightning={invalid_lightning}",
                )
            )

            invalid_mine = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.mine_site
                WHERE dispatch_room_lon NOT BETWEEN 73 AND 135
                   OR dispatch_room_lat NOT BETWEEN 3 AND 54
                   OR dispatch_room_point IS NULL
                """,
            )
            results.append(
                CheckResult(
                    "geo:mine_dispatch_room_point",
                    invalid_mine == 0,
                    f"invalid_mine_site={invalid_mine}",
                )
            )

            missing_fence = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.mine_site
                WHERE fence_geom IS NULL
                """,
            )
            results.append(
                CheckResult(
                    "geo:mine_fence_geom",
                    missing_fence == 0,
                    f"missing_fence_geom={missing_fence}",
                )
            )

            missing_biz, orphan_biz, dup_biz = _check_std_biz_1_1(
                cur,
                schema,
                "standard_atmosphere_electric_field",
                "biz_atmosphere_electric_field_event",
            )
            atm_ok = missing_biz == 0 and orphan_biz == 0 and dup_biz == 0
            results.append(
                CheckResult(
                    "relation:atmosphere_std_biz_1_1",
                    atm_ok,
                    f"missing={missing_biz}, orphan={orphan_biz}, duplicate_key={dup_biz}",
                )
            )

            for std_table, source_type in LIGHTNING_STD_BIZ_PAIRS:
                missing, orphan, dup = _check_std_biz_1_1(
                    cur,
                    schema,
                    std_table,
                    "biz_lightning_event",
                    source_type,
                )
                ok = missing == 0 and orphan == 0 and dup == 0
                results.append(
                    CheckResult(
                        f"relation:{std_table}_biz_1_1",
                        ok,
                        f"missing={missing}, orphan={orphan}, duplicate_key={dup}",
                    )
                )

            raw_dup = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    SELECT topic, partition_no, offset_no
                    FROM {schema}.raw_kafka_message
                    GROUP BY topic, partition_no, offset_no
                    HAVING count(*) > 1
                ) t
                """,
            )
            results.append(
                CheckResult(
                    "dedup:raw_kafka_tpo",
                    raw_dup == 0,
                    f"duplicate_groups={raw_dup}",
                )
            )

            invalid_window = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.thunderstorm_process
                WHERE process_start_time > process_end_time
                   OR strike_start_time > strike_end_time
                   OR data_window_start > data_window_end
                """,
            )
            results.append(
                CheckResult(
                    "time:process_window",
                    invalid_window == 0,
                    f"invalid_window={invalid_window}",
                )
            )

            invalid_timeline = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.thunderstorm_warning_event e
                WHERE NOT EXISTS (
                        SELECT 1 FROM {schema}.thunderstorm_warning_message m
                        WHERE m.warning_event_id = e.id
                          AND m.warning_action = 'PUBLISH'
                          AND m.warning_time = e.event_start_time
                      )
                   OR NOT EXISTS (
                        SELECT 1 FROM {schema}.thunderstorm_warning_message m
                        WHERE m.warning_event_id = e.id
                          AND m.warning_action = 'LIFT'
                          AND m.warning_time = e.event_end_time
                      )
                """,
            )
            results.append(
                CheckResult(
                    "time:warning_publish_lift",
                    invalid_timeline == 0,
                    f"invalid_warning_timeline={invalid_timeline}",
                )
            )

            msg_per = per_proc["msg_per"]
            bad_warning = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    SELECT p.id,
                           count(DISTINCT e.id) AS warning_event_count,
                           count(DISTINCT msg.id) AS warning_message_count
                    FROM {schema}.thunderstorm_process p
                    LEFT JOIN {schema}.thunderstorm_warning_event e
                      ON e.thunderstorm_process_id = p.id
                    LEFT JOIN {schema}.thunderstorm_warning_message msg
                      ON msg.warning_event_id = e.id
                    GROUP BY p.id
                    HAVING count(DISTINCT e.id) <> 1
                        OR count(DISTINCT msg.id) <> %s
                ) t
                """,
                (msg_per,),
            )
            results.append(
                CheckResult(
                    "relation:warning_per_process",
                    bad_warning == 0,
                    f"bad_processes={bad_warning}, expected_event=1, expected_messages={msg_per}",
                )
            )

            bad_closure = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    SELECT p.id,
                           count(DISTINCT a.id) AS alarm_count,
                           count(DISTINCT n.id) AS notice_count,
                           count(DISTINCT i.id) AS inspection_count
                    FROM {schema}.thunderstorm_process p
                    LEFT JOIN {schema}.device_alarm_event a
                      ON a.thunderstorm_process_id = p.id
                    LEFT JOIN {schema}.thunderstorm_notice_event n
                      ON n.thunderstorm_process_id = p.id
                    LEFT JOIN {schema}.inspection_task i
                      ON i.thunderstorm_process_id = p.id
                    GROUP BY p.id
                    HAVING count(DISTINCT a.id) < %s
                        OR count(DISTINCT a.id) > %s
                        OR count(DISTINCT n.id) < %s
                        OR count(DISTINCT n.id) > %s
                        OR count(DISTINCT i.id) < %s
                        OR count(DISTINCT i.id) > %s
                ) t
                """,
                (
                    per_proc["alarm_min"],
                    per_proc["alarm_max"],
                    per_proc["notice_min"],
                    per_proc["notice_max"],
                    per_proc["inspect_min"],
                    per_proc["inspect_max"],
                ),
            )
            results.append(
                CheckResult(
                    "relation:process_closure_per_process",
                    bad_closure == 0,
                    (
                        f"bad_processes={bad_closure}, "
                        f"alarm=[{per_proc['alarm_min']},{per_proc['alarm_max']}], "
                        f"notice=[{per_proc['notice_min']},{per_proc['notice_max']}], "
                        f"inspection=[{per_proc['inspect_min']},{per_proc['inspect_max']}]"
                    ),
                )
            )

            zero_lightning_processes = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    SELECT p.id
                    FROM {schema}.thunderstorm_process p
                    JOIN {schema}.mine_site m ON m.mine_code = p.mine_code
                    LEFT JOIN {schema}.biz_lightning_event l
                      ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
                     AND l.lightning_point IS NOT NULL
                     AND ST_DWithin(l.lightning_point, m.dispatch_room_point, 50000)
                    GROUP BY p.id
                    HAVING count(l.id) = 0
                ) z
                """,
            )
            results.append(
                CheckResult(
                    "geo:50km_lightning_per_process",
                    zero_lightning_processes == 0,
                    f"processes_without_50km_lightning={zero_lightning_processes}",
                )
            )

            out_of_band = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    SELECT p.id, count(l.id) AS lightning_count
                    FROM {schema}.thunderstorm_process p
                    JOIN {schema}.mine_site m ON m.mine_code = p.mine_code
                    LEFT JOIN {schema}.biz_lightning_event l
                      ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
                     AND l.lightning_point IS NOT NULL
                     AND ST_DWithin(l.lightning_point, m.dispatch_room_point, 50000)
                    GROUP BY p.id
                    HAVING count(l.id) < %s OR count(l.id) > %s
                ) t
                """,
                (band_low, band_high),
            )
            results.append(
                CheckResult(
                    "geo:50km_lightning_count_band",
                    out_of_band == 0,
                    (
                        f"out_of_band_processes={out_of_band}, "
                        f"expected_range=[{band_low},{band_high}] "
                        f"(~{expected_50km} in-window)"
                    ),
                )
            )

            for std_table, biz_table in LOWFREQ_PAIRS:
                missing, orphan, dup = _check_std_biz_1_1(cur, schema, std_table, biz_table)
                ok = missing == 0 and orphan == 0 and dup == 0
                results.append(
                    CheckResult(
                        f"relation:{std_table}_biz_1_1",
                        ok,
                        f"missing={missing}, orphan={orphan}, duplicate_key={dup}",
                    )
                )

            lowfreq_raw_parts = [
                f"SELECT unnest(raw_message_id) AS rid FROM {schema}.{std_table}"
                for std_table, _ in LOWFREQ_PAIRS
            ]
            missing_lowfreq_raw = _scalar(
                cur,
                f"""
                SELECT count(*) FROM (
                    {" UNION ALL ".join(lowfreq_raw_parts)}
                ) t
                LEFT JOIN {schema}.raw_kafka_message r ON r.id = t.rid
                WHERE r.id IS NULL
                """,
            )
            results.append(
                CheckResult(
                    "relation:lowfreq_raw_trace",
                    missing_lowfreq_raw == 0,
                    f"missing_raw_ids={missing_lowfreq_raw}",
                )
            )

            raw_total = int(profile["raw_rows"])
            abnormal_cnt = _scalar(
                cur,
                f"""
                SELECT count(*) FROM {schema}.raw_kafka_message
                WHERE process_status <> 'SUCCESS'
                """,
            )
            expected_abnormal = abnormal_raw_count(raw_total)
            ratio = float(abnormal_cnt) / raw_total if raw_total else 0.0
            ratio_ok = 0.0005 <= ratio <= 0.002 and int(abnormal_cnt) == expected_abnormal
            results.append(
                CheckResult(
                    "quality:raw_abnormal_ratio",
                    ratio_ok,
                    (
                        f"abnormal={abnormal_cnt}, expected={expected_abnormal}, "
                        f"ratio={ratio:.6f}, allowed=[0.0005,0.002]"
                    ),
                )
            )

    return results
