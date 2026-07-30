# PERF-05-AGG / S5 达梦压测优化存档

本目录归档大气电场过程窗 **只按时间桶聚合、跨设备合成一条曲线**（PERF-05-AGG）在达梦 S5 上的优化。

**口径（已定）**：`WHERE device_addr IN (...)` 过滤设备池后，`GROUP BY` **仅时间桶**，不按 `device_addr` 分桶。扫描量随台数变，结果行 ≈ 时间桶数。若业务要「每台一条曲线」，那是另一语义，不在本场景内。

| 文档 | 内容 |
|------|------|
| [01-problem-and-baseline.md](./01-problem-and-baseline.md) | 背景、语义约束、基线 |
| [02-optimization-journey.md](./02-optimization-journey.md) | 扁平 SQL、TRUNC、覆盖索引 |
| [03-before-after-results.md](./03-before-after-results.md) | 指标对比与 runId |
| [04-artifacts-and-how-to-retest.md](./04-artifacts-and-how-to-retest.md) | 落点、复测、回滚 |

**最终结论（S5 / conc=50 / 1 分钟桶）**

- SQL：扁平 `GROUP BY` 时间桶 + `TRUNC(device_upload_time,'MI')` + hint `idx_biz_atm_field_agg_cover`
- 典型 P95：**~390～455ms**（基线 old CTE ~1021ms）
- **无** Haversine/ST_DWithin 类语义分叉；增益可直接对应「同形态业务 SQL + 覆盖索引」
- 预聚合表用户暂缓；再压需预聚合或缩窗/降并发（AGG 查询并发建议 ≤20）

相关：PERF-06 见 [../perf06-optimization/](../perf06-optimization/)。

存档日期：2026-07-22（口径说明 2026-07-27 对齐）  
环境：达梦 DM8 `192.168.1.41:5236` / schema `PERF`
