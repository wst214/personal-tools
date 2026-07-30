# PERF-06 / S5 达梦压测优化存档

本目录归档 **leidian-perf-web** 在达梦 S5 档位上，围绕 PERF-06（50km 闪电时空统计）及压测启动链路的问题排查与优化过程。

| 文档 | 内容 |
|------|------|
| [01-problem-and-baseline.md](./01-problem-and-baseline.md) | 背景、数据规模、基线问题 |
| [02-optimization-journey.md](./02-optimization-journey.md) | 分阶段优化过程与技术结论 |
| [03-before-after-results.md](./03-before-after-results.md) | 优化前后指标对比（含关键 runId） |
| [04-artifacts-and-how-to-retest.md](./04-artifacts-and-how-to-retest.md) | 代码/DDL 落点、复测步骤、回滚 |
| [05-haversine-vs-stdwithin.md](./05-haversine-vs-stdwithin.md) | 两种距离算法、索引不兼容原理、压测≠业务 |
| [06-two-phase-bbox-then-dwithin.md](./06-two-phase-bbox-then-dwithin.md) | 业务精确口径的两段式（GTT+ROWID） |

**口径结论（务必读）**

| 模式 | 距离语义 | S5 conc=50 典型 P95 | 用途 |
|------|----------|---------------------|------|
| `geog_only`（默认） | **ST_DWithin 椭球精确** | ~400～450ms | 业务语义对照 |
| **`bbox_then_dwithin`** | **仍 ST_DWithin 精确**（bbox 粗筛 + GTT） | **~95～100ms** | **推荐：精确 + 可压测** |
| `bbox_geog` | Haversine 球面近似 | ~40ms | 仅近似极限/对照，**不能当业务承诺** |

**关键复测 runId（见 stage-records）**

| runId | 时间 (UTC) | 模式 | 说明 |
|-------|------------|------|------|
| `9a3396ea` | 2026-07-22 01:23 | bbox+ST_DWithin 同句 | 假优化，索引未吃到 |
| `b3dc92f7` | 2026-07-22 01:37 | Haversine，无 cover | count 快，GROUP BY 慢 |
| `6f506ab0` | 2026-07-22 01:46 | Haversine+cover | 近似路径三条 ~40ms |
| `8e144d99` / `3ac23c69` | 2026-07-22 02:44+ | geog_only | 业务路径 ~450ms |
| `e4c6b60a` | 2026-07-22 03:30 | **bbox_then_dwithin** | 精确两段 ~97ms |
| `b59ea1a8` | 2026-07-22 05:25 | 全场景含两段 PERF-06 | 写入+读+两段式总验收 |

相关：**PERF-05-AGG** 优化见 [../perf05-agg-optimization/](../perf05-agg-optimization/)。

存档更新日期：2026-07-22  
环境：达梦 DM8 `192.168.1.41:5236` / schema `PERF` / 操作台 `leidian-perf-web`
