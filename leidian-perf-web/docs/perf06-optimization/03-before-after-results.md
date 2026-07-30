# 03 — 优化前后结果对比

数据来源：`data/stage-records.dameng.json` → `dialects.dameng.stages.S5.benchmarkHistory`  
档位：**S5**，场景：**PERF-06**，查询并发多为 **50**（另有 conc=20 对照）。

慢 SQL 阈值默认 **500ms**（样本=客户端；库内=V$SQL_HISTORY）。

---

## 1. 总览（conc=50）

| 轮次 | runId | 模式 | count P95 | source P95 | type P95 | 评价 |
|------|-------|------|-----------|------------|----------|------|
| 对照较好 geog | `eed824bd` | geog_only | 299 | 290 | 235 | 能过门槛，但偏慢 |
| 较差 geog | `d03d6c9c` / `f4159514` | geog_only | 514～544 | 448～491 | 426～459 | 高延迟 + 大量慢 SQL |
| 旧 bbox | `9a3396ea` | bbox+ST_DWithin | 454 | 374 | 367 | 索引未吃到，收益差 |
| Haversine | `b3dc92f7` | bbox+Haversine | **40** | 419 | 429 | count 已好，GROUP BY 差 |
| **Cover（近似）** | **`6f506ab0`** | **bbox+Haversine+cover** | **40** | **41** | **41** | **近似路径达标** |
| geog 复测 | `8e144d99` / `3ac23c69` | geog_only | 449～465 | 414～416 | 397～416 | 业务路径基线 |
| **两段精确** | **`e4c6b60a`** | **bbox_then_dwithin** | **97** | **95** | **95** | **精确 + 可压** |
| 全场景验收 | `b59ea1a8` | 两段 PERF-06 | 98 | 98 | 96 | 与 e4c6 一致 |

---

## 2. 详细：优化前代表轮次

### 2.1 geog_only @ conc=20（健康基线）

示例：`e8b6d3c0`（2026-07-21）

| 子场景 | P50 | P95 | TPS | 慢SQL(样本) |
|--------|-----|-----|-----|-------------|
| count | 19 | 28 | 875 | 0 |
| source_dist | 22 | 34 | 767 | 0 |
| type_dist | 21 | 31 | 799 | 0 |

说明：低并发下 Geography 路径可接受；不能代表 S5 峰值并发。

### 2.2 geog_only @ conc=50（问题态）

示例：`d03d6c9c`

| 子场景 | P50 | P95 | avg | TPS | 慢SQL 样本/库内 |
|--------|-----|-----|-----|-----|-----------------|
| count | 278 | **514** | 247 | 197 | 1576 / 276 |
| source_dist | 40 | **448** | 140 | 339 | 596 / 121 |
| type_dist | 42 | **426** | 135 | 352 | 344 / 88 |

SQL 特征：`lightning_point IS NOT NULL` + `ST_GeomToGeog` + `ST_DWithin(..., 50000)`。  
计划特征：`idx_biz_lightning_strike_time`。

### 2.3 bbox + ST_DWithin @ conc=50（假优化）

runId：`9a3396ea`（2026-07-22 01:23 UTC）

| 子场景 | P50 | P95 | TPS | 慢SQL 样本/库内 |
|--------|-----|-----|-----|-----------------|
| count | 234 | **454** | 230 | 495 / 179 |
| source_dist | 35 | 374 | 404 | 69 / 10 |
| type_dist | 35 | 367 | 417 | 60 / 16 |

SQL 已有 lon/lat `BETWEEN`，但 EXPLAIN 仍走 `strike_time`；复合索引空转。

### 2.4 bbox + Haversine（无覆盖索引）@ conc=50

runId：`b3dc92f7`（2026-07-22 01:37 UTC）  
hint：`idx_biz_lightning_time_lon_lat`

| 子场景 | P50 | P95 | TPS | 慢SQL | CPU peak（配套采集） |
|--------|-----|-----|-----|-------|----------------------|
| count | 26 | **40** | **1564** | 0 | ~2% |
| source_dist | 261 | **419** | 220 | 152 | **~96%** |
| type_dist | 282 | **429** | 195 | 194 | **~96%** |

单线程 EXPLAIN：GROUP BY 有 **BLKUP2**（回表取分组列）。

---

## 3. 详细：优化后（覆盖索引）

runId：`6f506ab0`（2026-07-22 01:46 UTC）  
模式：bbox_geog + Haversine + `idx_biz_lightning_perf06_cover`  
并发：50，每线程 500 次，共 25000 ops/子场景

| 子场景 | P50 | P95 | avg | max | TPS | 慢SQL 样本/库内 |
|--------|-----|-----|-----|-----|-----|-----------------|
| count | 26 | **40** | 27 | 263 | **1524** | 0 / 0 |
| source_dist | 28 | **41** | 28 | 544 | **1500** | 1 / 0 |
| type_dist | 27 | **41** | 28 | 257 | **1501** | 0 / 0 |

配套资源：

| 子场景 | cpuAvg | cpuPeak | 计划索引（采集 EXPLAIN） |
|--------|--------|---------|-------------------------|
| count | 0.5% | 0.8% | `idx_biz_lightning_time_lon_lat` |
| source_dist | 3.6% | 6.3% | **`idx_biz_lightning_perf06_cover`** |
| type_dist | 9.5% | 12.7% | **`idx_biz_lightning_perf06_cover`** |

相对 `b3dc92f7`：

| 指标 | source_dist | type_dist |
|------|-------------|-----------|
| P95 | 419 → **41**（约 **10×**） | 429 → **41**（约 **10×**） |
| TPS | 220 → **1500**（约 **7×**） | 195 → **1501**（约 **8×**） |
| CPU peak | ~96% → **~6～13%** | 同左 |

相对旧 bbox+ST_DWithin（`9a3396ea`）count P95：454 → 40（约 **11×**）。

---

## 3.1 详细：两段精确路径（bbox_then_dwithin）

runId：`e4c6b60a`（2026-07-22 03:30 UTC）；全场景复现 `b59ea1a8`（05:25 UTC）

| 子场景 | P50 | P95 | TPS | 慢SQL 样本 | CPU peak |
|--------|-----|-----|-----|------------|----------|
| count | 74 | **97** | 607 | 1 | ~21% |
| source_dist | 74 | **95** | 613 | 1 | ~35% |
| type_dist | 75 | **95** | 612 | 0 | ~35% |

相对同档 geog_only（~450ms）：约 **4.5×**；语义仍为 ST_DWithin（本窗 count=451）。  
原理与注意点见 [06-two-phase-bbox-then-dwithin.md](./06-two-phase-bbox-then-dwithin.md)。

---

## 4. 结果口径说明

- **通过门槛**（sql-bench.yaml）：count P95≤1000ms；分布类 P95≤1500ms。上述「问题态」多数仍 *passed=true*，但尾延迟与慢 SQL 不可接受。  
- **语义**：本过程窗验证 Haversine+bbox 与 ST_DWithin **count=451**；椭球 vs 球面在其它地理区可能有微小差异（约几十～百米级距离差）。  
- **模式选型**：业务/验收精确 → `bbox_then_dwithin` 或 `geog_only`；极限吞吐对照 → `bbox_geog`（近似）。  
- **count 在 Haversine 路径**：优化器对 `count(*)` 可能选更短的 `time_lon_lat`，可接受。

---

## 5. 一句话前后对比

**优化前（S5 / 50 并发 / geog_only）**：P95 数百毫秒，CPU 打满。  
**近似优化后（bbox_geog + cover）**：P95≈40ms，但距离为球面近似。  
**精确优化后（bbox_then_dwithin）**：P95≈100ms，仍为 ST_DWithin，推荐作为业务对齐压测口径。