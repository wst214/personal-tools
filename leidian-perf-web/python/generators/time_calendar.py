"""造数时间轴：按自然月铺开存量（非实时 1Hz 仿真）。"""

from __future__ import annotations

from calendar import monthrange
from datetime import datetime, timedelta


def add_months(dt: datetime, months: int) -> datetime:
    month0 = dt.month - 1 + months
    year = dt.year + month0 // 12
    month = month0 % 12 + 1
    day = min(dt.day, monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def resolve_calendar_months(stage: str, profile: dict, defaults: dict) -> int:
    if "calendar_months" in profile:
        return max(int(profile["calendar_months"]), 1)
    if stage == "S0":
        return 1
    return max(int(defaults.get("calendar_months", 12)), 1)


def calendar_month_start(t0: datetime, month_offset: int) -> datetime:
    anchor = t0.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return add_months(anchor, month_offset)


def calendar_data_end(t0: datetime, calendar_months: int) -> datetime:
    """数据时间轴上界（不含）：起始月 + calendar_months 后的月初。"""
    return calendar_month_start(t0, calendar_months)


def month_window(t0: datetime, month_offset: int) -> tuple[datetime, datetime]:
    start = calendar_month_start(t0, month_offset)
    last_day = monthrange(start.year, start.month)[1]
    end = start.replace(day=last_day, hour=23, minute=59, second=59)
    return start, end


def split_count_evenly(total: int, parts: int) -> list[int]:
    if parts <= 0:
        return []
    base = total // parts
    rem = total % parts
    return [base + (1 if i < rem else 0) for i in range(parts)]


def span_seconds(t0: datetime, span_end: datetime) -> int:
    return max(int((span_end - t0).total_seconds()), 1)


def parse_iso_datetime(value: str) -> datetime:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00").split("+")[0])


def resolve_atmosphere_span(
    profile: dict,
    defaults: dict,
    t0: datetime | None = None,
) -> tuple[datetime, datetime, bool]:
    """
    返回 (atm_start, atm_end_exclusive, full_1hz)。
    full_1hz 时按 atmosphere_start + atmosphere_days 连续铺秒；否则沿用日历月轴。
    """
    base_t0 = t0 or parse_iso_datetime(defaults["t0"])
    if not bool(profile.get("atmosphere_full_1hz")):
        months = resolve_calendar_months("", profile, defaults)
        return base_t0, calendar_data_end(base_t0, months), False

    start = (
        parse_iso_datetime(profile["atmosphere_start"])
        if profile.get("atmosphere_start")
        else base_t0
    )
    days = max(int(profile.get("atmosphere_days", 1)), 1)
    end = start + timedelta(days=days)
    return start, end, True


def months_covering(start: datetime, end_exclusive: datetime) -> int:
    """覆盖 [start, end) 所需的自然月个数（含起止月）。"""
    cur = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end_month = end_exclusive.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if end_exclusive > end_month:
        # end 落在某月内时仍需该月分区；若恰好月初则上一月已够
        pass
    n = 0
    while cur <= end_month and n < 120:
        n += 1
        cur = add_months(cur, 1)
    return max(n, 1)
