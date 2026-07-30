# 06 — 两段式 bbox_then_dwithin（精确 ST_DWithin）

## 1. 目标

在**保持椭球精确 50km（ST_DWithin）** 的前提下，避开「同句含 ST_DWithin → 复合索引失效」。

## 2. 思路（必须真拆开）

```text
第 1 段：时间窗 + 60km bbox → INDEX(cover) 取 ROWID → 写入会话 GTT
第 2 段：JOIN GTT + ST_DWithin≤50km → count / GROUP BY
```

禁止把外层 `ST_DWithin` + 内层 bbox 写成可被优化器合并的子查询；合并后仍含 `ST_DWithin`，复合索引照样作废。

实现：worker 内 **两次 execute**（DELETE/准备 GTT → `INSERT…SELECT ROWID` → `JOIN+ST_DWithin`）。

## 3. 实现要点

| 点 | 做法 |
|----|------|
| 真拆开 | 两次往返 + GTT，不是子查询 |
| 第 1 段取 ROWID | 覆盖索引叶子可带 rowid，避免为取 `id` 回表 |
| 不用大 IN 列表 | `perf06_cand_rowid` 会话 GTT + JOIN（密集区候选上万也稳） |
| 候选数 | 本窗 bbox≈477、精确命中 451；落地前应看各窗候选分布 |
| 一致性 | 压测只读 OK；业务有并发写需快照/版本另议 |
| ON COMMIT | `PRESERVE ROWS`（读场景 autocommit 下仍跨语句保留）；每 op 开头 DELETE 清空 |

DDL：`sql-dameng/optional_perf06_two_phase_gtt.sql`（压测也可自动 CREATE）。

页面/CLI：`bbox_then_dwithin`（别名 `two_phase` / `2phase`）。

## 4. 结果（S5 / conc=50）

| runId | 模式 | count P95 | source P95 | type P95 | TPS 量级 |
|-------|------|-----------|------------|----------|----------|
| `3ac23c69` 等 | geog_only | ~449 | ~414 | ~397 | ~210～310 |
| **`e4c6b60a`** | **bbox_then_dwithin** | **97** | **95** | **95** | **~610** |
| `6f506ab0` | Haversine+cover（近似） | 40 | 41 | 41 | ~1500 |
| `b59ea1a8` | 全场景验收（两段 PERF-06） | 98 | 98 | 96 | ~600 |

相对 geog_only：P95 约 **4～5×**，CPU peak 从 ~95% 降到 ~20～35%。  
相对 Haversine：略慢，但**语义仍是 ST_DWithin**。

## 5. EXPLAIN 采集

预览 SQL 带 `-- perf06_geo_mode=...` 时，旧逻辑把注释与语句拼成单行会导致整句被注释掉（`-2007`）。  
已修：去掉行注释 → 只 `EXPLAIN FOR` 第 1 段的 `SELECT ROWID`；备注标明第 2 段。  
详见 `dameng_explain_collect.py` 中 `_prepare_explain_sql_dameng`。

若采集仍报旧错：重启 `leidian-perf-web` 后再点「采集资源与执行计划」。

## 6. 操作提示

- 日志必须出现：`PERF-06 空间模式: bbox_then_dwithin`  
- SQL 预览须含：`INSERT INTO perf06_cand_rowid` 与 `--__PERF06_TWO_PHASE__`  
- 勿把 compound 日志「三个子场景顺序执行」误当成「SQL 子查询两段」
