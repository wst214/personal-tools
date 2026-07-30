# 04 — 产物、复测与回滚

## 落点

| 文件 | 作用 |
|------|------|
| `python/generators/dameng_sql_bench.py` | `_sql_perf05_agg`、`TRUNC('MI')`、agg_cover hint |
| `sql-dameng/03_partitioned_tables.sql` | `idx_biz_atm_field_agg_cover` |
| `sql-dameng/optional_perf05_agg_cover_index.sql` | 已建库补建 |
| `sql-postgres/03_partitioned_tables.sql` | 对齐 |

## 复测

1. 达梦 / S5；PERF-05 聚合分钟设为 **1**  
2. 查询并发 50；只跑或全跑含 PERF-05-AGG  
3. 确认 SQL hint 为 `idx_biz_atm_field_agg_cover`，EXPLAIN 命中该索引  

## 回滚

- SQL：恢复旧 CTE/表达式（代码回退）  
- 索引：`DROP INDEX idx_biz_atm_field_agg_cover;`（慎用）  

未写入业务 Flyway；业务对齐见 [../business-landing-checklist.md](../business-landing-checklist.md)（双库迁移 + 同步聚合 SQL）。

## 后续（可选）

预聚合表、缩短窗口、降低并发——用户暂缓预聚合。
