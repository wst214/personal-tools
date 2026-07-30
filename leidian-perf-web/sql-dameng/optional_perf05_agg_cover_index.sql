-- PERF-05-AGG 瘦覆盖索引。已并入 03_partitioned_tables.sql；
-- 本文件用于已初始化环境补建（无需重跑 init-schema）。
-- 相对 idx_biz_atm_field_page_cover：去掉 id/event_status 等分页列，专供聚合扫描。
-- 注意：S5 大表在线 CREATE INDEX 可能较慢，请在压测空窗执行。

CREATE INDEX IF NOT EXISTS idx_biz_atm_field_agg_cover ON biz_atmosphere_electric_field_event (
    device_addr,
    device_upload_time,
    instantaneous_value,
    average_value,
    warning_level,
    rate_change,
    risk_level
);
