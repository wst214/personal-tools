-- PERF-06 bbox 相关索引。已并入 03_partitioned_tables.sql 默认 DDL；
-- 本文件保留用于已初始化环境补建索引（无需重跑 init-schema）。
--
-- 1) idx_biz_lightning_time_lon_lat：时间+lon/lat（count 可用）
-- 2) idx_biz_lightning_perf06_cover：同上 + source_type/lightning_type（GROUP BY 免回表）
--
-- 压测 bbox_geog：/*+ INDEX(... idx_biz_lightning_perf06_cover) */ + lon/lat bbox + Haversine≤50km
-- （同句带 ST_DWithin 时达梦常忽略复合索引，故精算改用 Haversine）
--
-- 注意：S5 等大表在线 CREATE INDEX 耗时与 IO 较高，请在压测空窗执行。

CREATE INDEX IF NOT EXISTS idx_biz_lightning_time_lon_lat
ON biz_lightning_event (strike_time, longitude, latitude);

CREATE INDEX IF NOT EXISTS idx_biz_lightning_perf06_cover
ON biz_lightning_event (strike_time, longitude, latitude, source_type, lightning_type);
