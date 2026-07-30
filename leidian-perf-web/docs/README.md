# leidian-perf-web 文档索引

优化与复测存档均在本目录（`docs/`）下，不放入业务仓库或其他路径。

| 目录 / 文件 | 说明 |
|------|------|
| [perf06-optimization/](./perf06-optimization/) | PERF-06（50km 闪电）：Haversine / 两段 ST_DWithin / 索引与复测 |
| [perf05-agg-optimization/](./perf05-agg-optimization/) | PERF-05-AGG（电场分钟聚合）：TRUNC + 覆盖索引 |
| [business-landing-checklist.md](./business-landing-checklist.md) | 压测结论落到业务库的检查项（cover / GTT / Mapper；尚未进 Flyway） |

临时分析脚本仍在业务仓 `wst-temp/perf-notes/`（gitignore，非正式文档）。
