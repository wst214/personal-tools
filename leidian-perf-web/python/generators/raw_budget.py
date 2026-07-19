"""raw_kafka_message 行数预算：保证最终入库量等于配置 target。"""

from __future__ import annotations


def abnormal_raw_count(target_raw: int) -> int:
    """异常 raw 约 0.1%（§6.3），至少 1 条。"""
    return max(1, int(target_raw * 0.001))


def plan_raw_rows(
    target_raw: int,
    atmosphere_rows: int,
    lightning_raw_count: int,
    lowfreq_raw_count: int,
    radar_configured: int,
) -> tuple[int, int, int]:
    """
    分配雷达、padding、异常 raw，使：
    atmosphere + lightning + lowfreq + radar + padding + abnormal == target_raw

    atmosphere / lightning / lowfreq 为固定 1:1 raw，不可压缩。
    volume-profiles.yaml 中 raw_rows 须预留 radar_raw_rows + abnormal + 少量 padding。
    """
    if target_raw < 0:
        raise ValueError(f"raw_rows 不能为负: {target_raw}")

    abnormal = abnormal_raw_count(target_raw)
    fixed = atmosphere_rows + lightning_raw_count + lowfreq_raw_count + abnormal
    if fixed > target_raw:
        raise ValueError(
            f"raw_rows={target_raw} 不足：需要至少 atmosphere({atmosphere_rows}) "
            f"+ lightning({lightning_raw_count}) + lowfreq({lowfreq_raw_count}) "
            f"+ abnormal({abnormal}) = {fixed}。"
            f"请调大 volume-profiles.yaml 中该档 raw_rows。"
        )

    remaining = target_raw - fixed
    radar_rows = min(radar_configured, remaining)
    padding_rows = remaining - radar_rows
    return radar_rows, padding_rows, abnormal
