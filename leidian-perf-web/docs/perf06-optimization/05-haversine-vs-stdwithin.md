# 05 — Haversine vs ST_DWithin：原理与压测/业务分叉

## 1. 两种距离算法

| | Haversine（球面近似） | ST_DWithin（椭球精确） |
|---|---|---|
| 地球模型 | 完美球体（半径约 6371km） | WGS84 椭球（赤道鼓、两极扁） |
| 实现 | `ASIN`/`SQRT` 等标准数学函数 | `DMGEO2.ST_DWithin` + `ST_GeomToGeog` |
| 精度 | 50km 量级约差 **几十～一百多米**（方位相关） | 地理椭球口径，业务「精确 50km」常用此 |
| 达梦支持 | 原生数学函数，不需空间扩展 | 需 DMGEO2 |
| 索引行为 | **能走** 复合/覆盖 B-tree（谓词在 lon/lat） | **同句内吃不到** 复合/覆盖 B-tree |

本过程窗实测：Haversine+bbox 与 ST_DWithin 的 **count 均为 451**（无边界分叉）；其它窗/中心点不保证永远一致。

---

## 2. 核心矛盾：ST_DWithin 与 B-tree 复合索引不兼容

达梦上，**同一条 SQL 含 `ST_DWithin` 时**，复合索引 hint 实测无效，计划常退回 `idx_biz_lightning_strike_time`。  
尝试过：INDEX hint、子查询拆分、`NO_MERGE` / `NO_INDEX` / `ROWNUM` 物化——**只要同句仍含 `ST_DWithin`，复合索引基本走不上**。

表述上这是**实测现象**（优化器把空间函数当黑盒、估不准选择性），不是达梦官方「显式禁止」文档条款。

---

## 3. 为何常只走单列 `strike_time`

1. `ST_DWithin` 作用在 **`lightning_point`**（空间类型），而 B-tree 复合/覆盖索引列是  
   `(strike_time, longitude, latitude[, source_type, lightning_type])`——**不含** `lightning_point`。  
2. 空间列不能塞进该 B-tree；单独 R-tree（`idx_biz_lightning_point_sp`）又难与时间窗+bbox 组合出理想计划。  
3. 走 B-tree 时必须回表取 `lightning_point` 再算距离（计划常见 `BLKUP2`）。  
4. 叠加「含 ST_DWithin 时 hint 失效」，优化器更倾向小体积的单列时间索引 + 回表过滤。

---

## 4. 「bbox + ST_DWithin」同句为何不行（假优化）

理论上「bbox 预筛 + ST_DWithin 精算」是经典两段，**写在同一条 SQL 里**在达梦上失败（`9a3396ea`）：

- 虽有 bbox 谓词，计划仍走 `strike_time`
- bbox 往往在回表后 `SLCT2` 才过滤，索引层未缩小范围
- 比纯 `geog_only` 不见得好，甚至更差（多了无效谓词开销）

对照实验（同过程窗）：

| SQL 形态 | 走的索引 |
|---|---|
| 时间 + ST_DWithin | `strike_time` |
| 时间 + bbox + ST_DWithin + INDEX hint | 仍是 `strike_time` |
| 时间 + bbox + INDEX（**无** ST_DWithin） | `time_lon_lat` ✅ |
| 时间 + bbox + Haversine + INDEX | `time_lon_lat` / cover ✅ |

**只要还含同句 `ST_DWithin`，复合索引就走不上。**

---

## 5. 近似快路径：Haversine + 覆盖索引

`bbox_geog`：bbox + Haversine≤50km + `idx_biz_lightning_perf06_cover`  
→ P95 ~40ms、TPS ~1500（`6f506ab0`）。

增益主要来自 **能免回表走覆盖索引**，不是 Haversine 算术本身更快。

---

## 6. 关键风险：压测近似 ≠ 业务精确

| 路径 | 算法 | 索引 | S5 conc=50 P95 |
|---|---|---|---|
| `bbox_geog` | Haversine | 覆盖索引 | ~40ms |
| `geog_only` | ST_DWithin | 吃不到复合索引 | ~450ms |
| `bbox_then_dwithin` | **ST_DWithin**（拆段） | 第 1 段吃复合索引 | ~97ms |

业务要椭球精确 50km，不能拿 Haversine 的 40ms 当承诺。  
精确且可压的路径见 [06-two-phase-bbox-then-dwithin.md](./06-two-phase-bbox-then-dwithin.md)。

索引与 SQL 改动在压测库；**未**写入业务 Flyway（见 04）。

---

## 7. 结论

- 达梦上「同句 ST_DWithin + B-tree 覆盖」目前没有既要又要的简单改法。  
- 近似压测：`bbox_geog`。  
- 精确压测/业务对齐：`bbox_then_dwithin`（真两段）或接受 `geog_only` 的延迟。
