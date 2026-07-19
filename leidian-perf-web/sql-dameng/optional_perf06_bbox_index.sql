-- PERF-06 可选：bbox 预筛时建议创建复合索引（压测前手工执行）
-- SQL 语义：60km lon/lat bbox + ST_GeomToGeog + ST_DWithin(50000m)

CREATE INDEX IF NOT EXISTS idx_biz_lightning_time_lon_lat
ON biz_lightning_event (strike_time, longitude, latitude);
