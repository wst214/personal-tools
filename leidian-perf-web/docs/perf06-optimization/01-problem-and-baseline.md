# 01 — 背景、数据规模与基线问题

## 1. 压测对象

- **工具**：`D:\mytools\leidian-perf-web`（页面 + `run_load.py` 直连 SQL 压测）
- **方言**：达梦 DM8（`PERF_DB_DIALECT=dameng`）
- **档位**：S5
- **场景**：PERF-06（达梦拆为三条独立 SQL）
  - `PERF-06-count`：50km 内闪电数量
  - `PERF-06-source_dist`：按 `source_type` 分布
  - `PERF-06-type_dist`：按 `lightning_type` 分布
- **典型窗口**：固定第一条雷暴过程的 `strike_start`～`strike_end`（示例约 2025-07-28 00:13～02:26），圆心约 `(109.12, 34.25)`，半径 50km

## 2. S5 数据规模（相关）

| 对象 | 量级（约） | 说明 |
|------|------------|------|
| 大气电场 std / biz | 各约 **1 亿行** | 库表总量；影响启动探活、写入清理等 |
| 闪电相关表 | 表级可达 **亿级** | 同上，勿与「单次查询扫描量」混淆 |
| 表+索引段 | 约数百 GB（含大覆盖索引） | 存储与建索成本 |
| **本过程窗**闪电候选 | 时间窗内约 **数万～约 7.5 万** 行量级（dbserver 观测） | PERF-06 实际过滤起点 |
| 过程窗内 50km 命中 | count ≈ **451** | 本窗验证结果 |

**读数约定**：下文 P95 / 索引收益均针对「固定雷暴过程窗 + 50km」查询路径，**不是**在全表亿级行上逐行扫出来的结论。表级「亿级」解释的是环境压力与为何不能启动期全表 `COUNT`；优化是否吃到 cover，看的是过程窗计划与并发尾延迟。

## 3. 基线暴露的问题

### 3.1 压测启动「解析上下文」极慢

在场景正式跑之前，`resolve_context_dameng` / 清理逻辑对大表做了：

- 全表 `COUNT(*)`
- `DISTINCT device_addr`
- 全表或单设备 `MIN/MAX(device_upload_time)`
- 写入清理前的 `COUNT(*) WHERE 标记条件`（无合适索引时等价大扫）

S5 上这些步骤可耗时数分钟，用户体感是「还没开压就已经卡住」。

### 3.2 PERF-06 在高并发下尾延迟差

| 条件 | 现象 |
|------|------|
| conc=20 + `geog_only` | 三条 P95 约 **28～50ms**，健康 |
| conc=50 + `geog_only` | count P95 常 **300～540ms**，慢 SQL 上百～上千 |
| 资源 | CPU peak 常接近 **95%**，connPeak≈50 |

根因方向：

1. SQL 路径：`ST_GeomToGeog` + `ST_DWithin` 单行代价高  
2. 计划：时间窗常走 `idx_biz_lightning_strike_time`，空间条件作过滤  
3. 并发：50 路同 SQL 抢 CPU，排队抬高 P50/P95

### 3.3 bbox 预筛「开了但不快」

曾引入环境变量 / 页面开关：

- `DM_PERF06_GEO=geog_only`（默认）：纯 Geography + ST_DWithin  
- `DM_PERF06_GEO=bbox_geog`：60km lon/lat `BETWEEN` + ST_DWithin  

并预先建了备用索引：

```sql
idx_biz_lightning_time_lon_lat (strike_time, longitude, latitude)
```

**问题**：扁平 SQL 带 `ST_DWithin` 时，达梦优化器**仍选** `idx_biz_lightning_strike_time`，复合索引空转；bbox 只在 `SLCT2` 过滤阶段生效，高并发下收益有限。

代表轮次：`9a3396ea`（2026-07-22，bbox+ST_DWithin，conc=50）— count P95≈454ms。

### 3.4 GROUP BY 回表

在改为「复合索引 + Haversine」后（`b3dc92f7`）：

- **count** P95≈40ms（已好）
- **source/type** P95≈420ms（仍差）

单线程 EXPLAIN 显示 GROUP BY 多了：

- `BLKUP2`：回表取 `source_type` / `lightning_type`（三列索引未覆盖）
- `HAGR2`：哈希聚合  

50 并发下回表争用把 CPU 打到 ~96%。

### 3.5 资源采集 EXPLAIN 误导

配套「采集资源与执行计划」一度用**默认 geog_only** 重建 SQL 做 EXPLAIN，与实际压测 SQL（bbox/Haversine）不一致，页面上仍显示 `strike_time` + `lightning_point IS NOT NULL`，容易误判。

## 4. 优化目标

1. 启动上下文秒级完成（按场景跳过无关大表探活/COUNT）  
2. 页面可选 PERF-06 空间模式，便于 A/B  
3. `bbox_geog` 真正吃到复合/覆盖索引，conc=50 下三条 P95 接近 conc=20 健康水平  
4. EXPLAIN 与压测 SQL 一致  
5. 过程与结果可归档复盘（本目录）
