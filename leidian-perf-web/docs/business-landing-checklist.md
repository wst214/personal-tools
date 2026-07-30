# 业务库落地清单（压测结论 → 业务）

本清单对应 `leidian-perf-web` 达梦 S5 已验证优化。**均未写入业务仓 Flyway**；落地时须 PostgreSQL + DM8 双库同语义迁移，并同步 Mapper/SQL。

## PERF-06（50km 闪电，精确口径）

目标形态：`bbox_then_dwithin`（bbox 粗筛 → GTT/候选 ROWID → `ST_DWithin` 精筛）。

| 项 | 动作 | 参考 |
|----|------|------|
| 覆盖索引 | 建 `idx_biz_lightning_time_lon_lat_src_type`（或业务等价 cover：时间 + lon/lat + 分组列） | `sql-dameng/optional_perf06_*.sql`、perf06 `04` |
| 会话 GTT | 建 `perf06_cand_rowid`（或业务命名）供候选 ROWID | `optional_perf06_two_phase_gtt.sql` |
| Mapper / DAO | **两段执行**：① INSERT 候选（bbox + cover）② JOIN + `ST_DWithin`；禁止同句 `ST_DWithin` 指望吃到 cover | perf06 `06-two-phase-*.md` |
| 验收 | 同过程窗 count 与纯 `ST_DWithin` 一致；EXPLAIN 段 1 走 cover、段 2 对候选精筛 | runId `e4c6b60a` / `b59ea1a8` |

不要把 `bbox_geog`（Haversine）当业务 SLA。

## PERF-05-AGG（电场分钟聚合）

目标形态：扁平 SQL + `TRUNC(...,'MI')` / PG `date_trunc('minute',…)` + `idx_biz_atm_field_agg_cover`。  
**口径**：多台 `IN`/`ANY` 过滤后 **只按时间桶** `GROUP BY`（跨设备合成一条）；不要加回 `device_addr`。

| 项 | 动作 | 参考 |
|----|------|------|
| 覆盖索引 | 建 `idx_biz_atm_field_agg_cover`（设备 + 时间 + 聚合列；设备列供 WHERE 过滤） | `optional_perf05_agg_cover_index.sql`（PG/DM）、perf05-agg `04` |
| 聚合 SQL | 去掉重 CTE；达梦 `TRUNC(ts,'MI')`、PG `date_trunc('minute',ts)` 扁平 GROUP BY | `_sql_perf05_agg`（`sql_bench.py` / `dameng_sql_bench.py`） |
| 验收 | 1 分钟桶语义不变、结果行≈桶数；EXPLAIN 命中 agg_cover / Index Only Scan | runId `b12fa15d` / `b59ea1a8`（达梦）；PG 复测另记 |

## 注意

- 压测库索引/SQL ≠ 业务已上线；未迁移则业务侧看不到同等 P95。
- Schema 变更走业务仓双库 Flyway；本目录只作压测存档与对照。
