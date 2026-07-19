"""雷暴过程及预警 / 告警 / 工况 / 运维闭环造数。"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Sequence

from generators.id_gen import SnowflakeGenerator


@dataclass
class ThunderstormProcessSpec:
    id: int
    mine_code: str
    process_start: datetime
    process_end: datetime
    strike_start: datetime
    strike_end: datetime
    data_window_start: datetime
    data_window_end: datetime
    process_status: str = "CLOSED"


@dataclass
class ProcessBundle:
    processes: list[ThunderstormProcessSpec] = field(default_factory=list)
    warning_events: list[list] = field(default_factory=list)
    warning_messages: list[list] = field(default_factory=list)
    device_alarms: list[list] = field(default_factory=list)
    notice_events: list[list] = field(default_factory=list)
    inspection_tasks: list[list] = field(default_factory=list)
    hidden_risks: list[list] = field(default_factory=list)
    repair_orders: list[list] = field(default_factory=list)


def _split_counts(total: int, count: int) -> list[int]:
    """将总量均匀分配到每个过程（余数依次 +1）。"""
    if count <= 0:
        return []
    base = total // count
    rem = total % count
    return [base + (1 if i < rem else 0) for i in range(count)]


def _strike_windows_overlap(
    a_start: datetime,
    a_end: datetime,
    b_start: datetime,
    b_end: datetime,
) -> bool:
    return a_start <= b_end and b_start <= a_end


def _random_process_start(
    rng: random.Random,
    t0: datetime,
    t_end: datetime,
    season_months: Sequence[int],
    season_ratio: float,
) -> datetime:
    span_days = max((t_end - t0).days, 1)
    for _ in range(100):
        offset_days = rng.randint(0, span_days - 1)
        candidate = t0 + timedelta(days=offset_days, hours=rng.randint(0, 20))
        if candidate >= t_end:
            continue
        in_season = candidate.month in season_months
        if in_season or rng.random() > season_ratio:
            return candidate
    return t0 + timedelta(hours=4)


def build_process_bundle(
    mine_code: str,
    process_count: int,
    warning_message_total: int,
    device_alarm_total: int,
    notice_total: int,
    inspection_total: int,
    hidden_risk_total: int,
    repair_total: int,
    t0: datetime,
    atmosphere_end: datetime,
    id_gen: SnowflakeGenerator,
    season_months: Sequence[int],
    season_ratio: float,
    duration_min: int,
    duration_max: int,
    notice_receivers: Sequence[dict],
    inspectors: Sequence[str],
    rng: random.Random,
) -> ProcessBundle:
    bundle = ProcessBundle()
    if process_count <= 0:
        return bundle

    msg_per = max(warning_message_total // process_count, 2)
    alarm_splits = _split_counts(device_alarm_total, process_count)
    notice_splits = _split_counts(notice_total, process_count)
    inspect_splits = _split_counts(inspection_total, process_count)
    strike_intervals: list[tuple[datetime, datetime]] = []

    for proc_idx in range(process_count):
        alarm_this = alarm_splits[proc_idx] if proc_idx < len(alarm_splits) else 0
        notice_this = notice_splits[proc_idx] if proc_idx < len(notice_splits) else 0
        inspect_this = inspect_splits[proc_idx] if proc_idx < len(inspect_splits) else 0

        start: datetime | None = None
        process_end: datetime | None = None
        strike_start: datetime | None = None
        strike_end: datetime | None = None
        duration_minutes = rng.randint(duration_min, duration_max)

        for _ in range(400):
            candidate_start = _random_process_start(rng, t0, atmosphere_end, season_months, season_ratio)
            candidate_duration = rng.randint(duration_min, duration_max)
            candidate_end = candidate_start + timedelta(minutes=candidate_duration)
            if candidate_end > atmosphere_end:
                continue
            candidate_strike_start = candidate_start + timedelta(minutes=rng.randint(5, 20))
            candidate_strike_end = candidate_end - timedelta(minutes=rng.randint(5, 15))
            if candidate_strike_end <= candidate_strike_start:
                candidate_strike_end = candidate_strike_start + timedelta(minutes=10)
            if any(
                _strike_windows_overlap(candidate_strike_start, candidate_strike_end, s, e)
                for s, e in strike_intervals
            ):
                continue
            start = candidate_start
            process_end = candidate_end
            strike_start = candidate_strike_start
            strike_end = candidate_strike_end
            duration_minutes = candidate_duration
            break

        if start is None or process_end is None or strike_start is None or strike_end is None:
            gap = timedelta(minutes=15)
            cursor = max((e for _, e in strike_intervals), default=t0 + timedelta(hours=4)) + gap
            duration_minutes = rng.randint(duration_min, duration_max)
            if cursor + timedelta(minutes=duration_minutes) > atmosphere_end:
                duration_minutes = max(
                    duration_min,
                    int((atmosphere_end - cursor).total_seconds() // 60) - 1,
                )
            start = cursor
            process_end = start + timedelta(minutes=duration_minutes)
            strike_start = start + timedelta(minutes=rng.randint(5, 20))
            strike_end = process_end - timedelta(minutes=rng.randint(5, 15))
            if strike_end <= strike_start:
                strike_end = strike_start + timedelta(minutes=10)

        strike_intervals.append((strike_start, strike_end))

        process_id = id_gen.next_id()
        spec = ThunderstormProcessSpec(
            id=process_id,
            mine_code=mine_code,
            process_start=start,
            process_end=process_end,
            strike_start=strike_start,
            strike_end=strike_end,
            data_window_start=strike_start - timedelta(minutes=5),
            data_window_end=strike_end + timedelta(minutes=5),
        )
        bundle.processes.append(spec)

        warning_event_id = id_gen.next_id()
        bundle.warning_events.append(
            [
                warning_event_id,
                process_id,
                mine_code,
                start,
                process_end,
                0,
                4,
                "CLOSED",
                start,
            ]
        )

        middle_actions = ["UPGRADE", "UPGRADE", "DOWNGRADE"]
        middle_levels = [2, 3, 2]
        for i in range(msg_per):
            if i == 0:
                action = "PUBLISH"
                msg_time = start
                level = 1
            elif i == msg_per - 1:
                action = "LIFT"
                msg_time = process_end
                level = 0
            else:
                mid = i - 1
                action = middle_actions[mid % len(middle_actions)]
                level = middle_levels[mid % len(middle_levels)]
                msg_time = start + timedelta(minutes=int(duration_minutes * (i + 1) / (msg_per + 1)))
            bundle.warning_messages.append(
                [
                    id_gen.next_id(),
                    warning_event_id,
                    process_id,
                    mine_code,
                    f"RULE-PERF-{level:02d}",
                    f"性能测试预警规则-{level}",
                    "电场抬升触发",
                    "ATMOSPHERE",
                    None,
                    msg_time,
                    level,
                    action,
                    msg_time,
                ]
            )

        alarm_ids: list[int] = []
        for j in range(alarm_this):
            alarm_time = start + timedelta(minutes=rng.randint(0, duration_minutes))
            alarm_id = id_gen.next_id()
            alarm_ids.append(alarm_id)
            bundle.device_alarms.append(
                [
                    alarm_id,
                    process_id,
                    mine_code,
                    f"ATM-DS-STD-00{1 + (j % 5)}",
                    alarm_time,
                    rng.randint(1, 3),
                    f"ALM-{100 + j}",
                    "设备电压异常",
                    "OPEN" if j % 3 else "CLOSED",
                    "standard_atmosphere_electric_field",
                    None,
                    alarm_time,
                ]
            )

        for j in range(notice_this):
            receiver = notice_receivers[j % len(notice_receivers)] if notice_receivers else {"name": "测试员", "role": "OPS"}
            msg_id = bundle.warning_messages[-1][0] if bundle.warning_messages else None
            notice_time = start + timedelta(minutes=rng.randint(0, duration_minutes))
            bundle.notice_events.append(
                [
                    id_gen.next_id(),
                    process_id,
                    warning_event_id,
                    msg_id,
                    mine_code,
                    notice_time,
                    "SMS" if j % 2 == 0 else "APP",
                    receiver["name"],
                    receiver["role"],
                    "雷暴预警通知",
                    "性能测试工况联动通知内容",
                    "SENT",
                    "WARNING",
                    warning_event_id,
                    notice_time,
                ]
            )

        for j in range(inspect_this):
            alarm_ref = alarm_ids[j % len(alarm_ids)] if alarm_ids else None
            plan_time = process_end + timedelta(hours=rng.randint(1, 24))
            bundle.inspection_tasks.append(
                [
                    id_gen.next_id(),
                    process_id,
                    alarm_ref,
                    mine_code,
                    f"ATM-DS-STD-00{1 + (j % 5)}",
                    "DONE" if j % 2 else "OPEN",
                    plan_time,
                    plan_time + timedelta(hours=2) if j % 2 else None,
                    inspectors[j % len(inspectors)] if inspectors else "巡检员A",
                    plan_time,
                    plan_time,
                    None,
                    "1.0",
                    "1.0",
                ]
            )

    risk_needed = hidden_risk_total
    for task in bundle.inspection_tasks:
        if risk_needed <= 0:
            break
        if rng.random() < 0.5:
            bundle.hidden_risks.append(
                [
                    id_gen.next_id(),
                    task[1],
                    task[0],
                    task[3],
                    task[4],
                    rng.randint(1, 3),
                    "性能测试隐患描述",
                    "OPEN" if rng.random() < 0.5 else "CLOSED",
                    task[6],
                    task[6],
                ]
            )
            risk_needed -= 1

    while len(bundle.hidden_risks) < hidden_risk_total and bundle.inspection_tasks:
        task = bundle.inspection_tasks[len(bundle.hidden_risks) % len(bundle.inspection_tasks)]
        bundle.hidden_risks.append(
            [
                id_gen.next_id(),
                task[1],
                task[0],
                task[3],
                task[4],
                1,
                "性能测试隐患描述",
                "OPEN",
                task[6],
                task[6],
            ]
        )

    repair_needed = repair_total
    for risk in bundle.hidden_risks:
        if repair_needed <= 0:
            break
        if rng.random() < 0.6:
            bundle.repair_orders.append(
                [
                    id_gen.next_id(),
                    risk[1],
                    risk[0],
                    risk[3],
                    risk[4],
                    "CLOSED",
                    "性能测试维修描述",
                    risk[8],
                    risk[8] + timedelta(days=1) if isinstance(risk[8], datetime) else None,
                    risk[8],
                ]
            )
            repair_needed -= 1

    while len(bundle.repair_orders) < repair_total and bundle.hidden_risks:
        risk = bundle.hidden_risks[len(bundle.repair_orders) % len(bundle.hidden_risks)]
        bundle.repair_orders.append(
            [
                id_gen.next_id(),
                risk[1],
                risk[0],
                risk[3],
                risk[4],
                "OPEN",
                "性能测试维修描述",
                risk[8],
                None,
                risk[8],
            ]
        )

    return bundle
