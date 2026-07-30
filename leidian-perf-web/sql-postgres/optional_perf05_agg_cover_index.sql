-- PERF-05-AGG 瘦覆盖索引。已并入 03_partitioned_tables.sql；
-- 本文件用于已初始化库补建（无需重跑 init-schema）。
-- 与达梦 idx_biz_atm_field_agg_cover 同列序，供扁平 GROUP BY 覆盖扫描。
-- 注意：大表在线 CREATE INDEX 可能较慢，请在压测空窗执行。

CREATE INDEX IF NOT EXISTS idx_biz_atm_field_agg_cover ON biz_atmosphere_electric_field_event (
    device_addr,
    device_upload_time,
    instantaneous_value,
    average_value,
    warning_level,
    rate_change,
    risk_level
);
