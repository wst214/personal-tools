"""达梦 DM8 造数结果校验（与 validate.py / psycopg2 完全隔离）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from generators.dameng_conn import DamengConn
from generators.dameng_geo import dm_within_50km_sql
from generators.dm_exec import DisqlNotFoundError
from generators.dm_write import dm_scalar
from generators.lightning import _split_total, expected_in_50km_count
from generators.raw_budget import abnormal_raw_count
from generators.validate import (
    LIGHTNING_STD_BIZ_PAIRS,
    LOWFREQ_PAIRS,
    CheckResult,
    _per_process_targets,
)
from generators.volume_matrix import build_expected_counts

DM_VALIDATE_STAGES = frozenset()  # 已支持全档位，保留常量兼容


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


def _check_std_biz_1_1_dm(
    conn: DamengConn,
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
    missing = dm_scalar(
        conn,
        f"""
        SELECT count(*) FROM {std_table} s
        LEFT JOIN {biz_table} b ON b.standard_record_id = s.id{join_extra}
        WHERE b.id IS NULL
        """,
    )
    orphan = dm_scalar(
        conn,
        f"""
        SELECT count(*) FROM {biz_table} b
        LEFT JOIN {std_table} s ON s.id = b.standard_record_id
        {orphan_filter}
        """,
    )
    dup = dm_scalar(
        conn,
        f"""
        SELECT count(*) - count(DISTINCT standard_record_id)
        FROM {biz_table}
        {biz_filter}
        """,
    )
    return missing, orphan, dup


def _lowfreq_raw_id_expr(column: str = "raw_message_id") -> str:
    """DM 低频表 raw_message_id 存 JSON 数组字符串，如 [123]。"""
    return (
        f"CAST(REPLACE(REPLACE({column}, '[', ''), ']', '') AS BIGINT)"
    )


def validate_stage_dameng(
    *,
    stage: str,
    conn: DamengConn,
    config_dir: Path | None = None,
) -> list[CheckResult]:
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
    msg_per = per_proc["msg_per"]

    try:
        for table, exp in expected.items():
            cnt = dm_scalar(conn, f"SELECT count(*) FROM {table}")
            ok = cnt == exp
            results.append(
                CheckResult(
                    f"row_count:{table}",
                    ok,
                    f"expected={exp}, actual={cnt}",
                )
            )

        invalid_lightning = dm_scalar(
            conn,
            """
            SELECT count(*) FROM biz_lightning_event
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

        invalid_mine = dm_scalar(
            conn,
            """
            SELECT count(*) FROM mine_site
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

        missing_fence = dm_scalar(
            conn,
            "SELECT count(*) FROM mine_site WHERE fence_geom IS NULL",
        )
        results.append(
            CheckResult(
                "geo:mine_fence_geom",
                missing_fence == 0,
                f"missing_fence_geom={missing_fence}",
            )
        )

        missing_biz, orphan_biz, dup_biz = _check_std_biz_1_1_dm(
            conn,
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
            missing, orphan, dup = _check_std_biz_1_1_dm(
                conn,
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

        raw_dup = dm_scalar(
            conn,
            """
            SELECT count(*) FROM (
                SELECT topic, partition_no, offset_no
                FROM raw_kafka_message
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

        invalid_window = dm_scalar(
            conn,
            """
            SELECT count(*) FROM thunderstorm_process
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

        invalid_timeline = dm_scalar(
            conn,
            """
            SELECT count(*) FROM thunderstorm_warning_event e
            WHERE NOT EXISTS (
                    SELECT 1 FROM thunderstorm_warning_message m
                    WHERE m.warning_event_id = e.id
                      AND m.warning_action = 'PUBLISH'
                      AND m.warning_time = e.event_start_time
                  )
               OR NOT EXISTS (
                    SELECT 1 FROM thunderstorm_warning_message m
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

        bad_warning = dm_scalar(
            conn,
            f"""
            SELECT count(*) FROM (
                SELECT p.id,
                       count(DISTINCT e.id) AS warning_event_count,
                       count(DISTINCT msg.id) AS warning_message_count
                FROM thunderstorm_process p
                LEFT JOIN thunderstorm_warning_event e
                  ON e.thunderstorm_process_id = p.id
                LEFT JOIN thunderstorm_warning_message msg
                  ON msg.warning_event_id = e.id
                GROUP BY p.id
                HAVING count(DISTINCT e.id) <> 1
                    OR count(DISTINCT msg.id) <> {msg_per}
            ) t
            """,
        )
        results.append(
            CheckResult(
                "relation:warning_per_process",
                bad_warning == 0,
                f"bad_processes={bad_warning}, expected_event=1, expected_messages={msg_per}",
            )
        )

        bad_closure = dm_scalar(
            conn,
            f"""
            SELECT count(*) FROM (
                SELECT p.id,
                       count(DISTINCT a.id) AS alarm_count,
                       count(DISTINCT n.id) AS notice_count,
                       count(DISTINCT i.id) AS inspection_count
                FROM thunderstorm_process p
                LEFT JOIN device_alarm_event a
                  ON a.thunderstorm_process_id = p.id
                LEFT JOIN thunderstorm_notice_event n
                  ON n.thunderstorm_process_id = p.id
                LEFT JOIN inspection_task i
                  ON i.thunderstorm_process_id = p.id
                GROUP BY p.id
                HAVING count(DISTINCT a.id) < {per_proc["alarm_min"]}
                    OR count(DISTINCT a.id) > {per_proc["alarm_max"]}
                    OR count(DISTINCT n.id) < {per_proc["notice_min"]}
                    OR count(DISTINCT n.id) > {per_proc["notice_max"]}
                    OR count(DISTINCT i.id) < {per_proc["inspect_min"]}
                    OR count(DISTINCT i.id) > {per_proc["inspect_max"]}
            ) t
            """,
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

        zero_lightning_processes = dm_scalar(
            conn,
            f"""
            SELECT count(*) FROM (
                SELECT p.id
                FROM thunderstorm_process p
                JOIN mine_site m ON m.mine_code = p.mine_code
                LEFT JOIN biz_lightning_event l
                  ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
                 AND {dm_within_50km_sql()}
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

        out_of_band = dm_scalar(
            conn,
            f"""
            SELECT count(*) FROM (
                SELECT p.id, count(l.id) AS lightning_count
                FROM thunderstorm_process p
                JOIN mine_site m ON m.mine_code = p.mine_code
                LEFT JOIN biz_lightning_event l
                  ON l.strike_time BETWEEN p.strike_start_time AND p.strike_end_time
                 AND {dm_within_50km_sql()}
                GROUP BY p.id
                HAVING count(l.id) < {band_low} OR count(l.id) > {band_high}
            ) t
            """,
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
            missing, orphan, dup = _check_std_biz_1_1_dm(conn, std_table, biz_table)
            ok = missing == 0 and orphan == 0 and dup == 0
            results.append(
                CheckResult(
                    f"relation:{std_table}_biz_1_1",
                    ok,
                    f"missing={missing}, orphan={orphan}, duplicate_key={dup}",
                )
            )

        rid_expr = _lowfreq_raw_id_expr()
        lowfreq_parts = [
            f"SELECT {rid_expr} AS rid FROM {std_table} WHERE raw_message_id IS NOT NULL"
            for std_table, _ in LOWFREQ_PAIRS
        ]
        missing_lowfreq_raw = dm_scalar(
            conn,
            f"""
            SELECT count(*) FROM (
                {" UNION ALL ".join(lowfreq_parts)}
            ) t
            LEFT JOIN raw_kafka_message r ON r.id = t.rid
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
        abnormal_cnt = dm_scalar(
            conn,
            "SELECT count(*) FROM raw_kafka_message WHERE process_status <> 'SUCCESS'",
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
    except DisqlNotFoundError as exc:
        raise RuntimeError(str(exc)) from exc

    return results
