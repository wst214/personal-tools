-- PERF 默认月分区
-- 默认窗口 2025-03-01 ~ 2026-01-31（含 90 天造数、雷暴季 6~8 月、跨月过程缓冲）
-- 自定义范围：SELECT create_monthly_partitions('perf.raw_kafka_message'::regclass, '2025-06-01', '2025-12-01');

SET search_path TO perf, public;

SELECT create_monthly_partitions('perf.raw_kafka_message'::regclass, DATE '2025-03-01', DATE '2026-02-01');
SELECT create_monthly_partitions('perf.standard_atmosphere_electric_field'::regclass, DATE '2025-03-01', DATE '2026-02-01');
SELECT create_monthly_partitions('perf.biz_atmosphere_electric_field_event'::regclass, DATE '2025-03-01', DATE '2026-02-01');
SELECT create_monthly_partitions('perf.standard_lightning_strike_cmb'::regclass, DATE '2025-03-01', DATE '2026-02-01');
SELECT create_monthly_partitions('perf.standard_lightning_strike_locator'::regclass, DATE '2025-03-01', DATE '2026-02-01');
SELECT create_monthly_partitions('perf.biz_lightning_event'::regclass, DATE '2025-03-01', DATE '2026-02-01');
