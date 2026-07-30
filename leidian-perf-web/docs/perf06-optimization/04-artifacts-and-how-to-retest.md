# 04 — 产物落点、复测与回滚

## 1. 代码与 DDL 落点

### 1.1 压测 SQL / 上下文

| 文件 | 作用 |
|------|------|
| `python/generators/dameng_sql_bench.py` | 快速 resolve_context；三模式 SQL；两段 GTT 执行；cover hint；只读跳过清理 |
| `python/generators/dameng_geo.py` | bbox / Haversine / ST_DWithin 辅助函数 |
| `python/generators/sql_bench.py` | `normalize_perf06_geo_mode`（`geog_only` / `bbox_geog` / `bbox_then_dwithin`） |
| `python/run_load.py` | CLI `--perf06-geo` |

### 1.2 页面与 API

| 文件 | 作用 |
|------|------|
| `web/index.html` | PERF-06空间下拉（三选项） |
| `web/app.js` | 提交 `perf06Geo`；启动前确认模式 |
| `web/server.py` | 传入 `perf06_geo`；静态资源 no-store |

### 1.3 EXPLAIN 采集

| 文件 | 作用 |
|------|------|
| `python/generators/dameng_explain_collect.py` | 优先 `sqlPreview`；推断 geo 模式；两段式剥注释并 EXPLAIN 第 1 段 SELECT |

### 1.4 索引 / GTT DDL

| 文件 | 作用 |
|------|------|
| `sql-dameng/03_partitioned_tables.sql` | `time_lon_lat` + `perf06_cover` |
| `sql-dameng/optional_perf06_bbox_index.sql` | 已建库补建索引 |
| `sql-dameng/optional_perf06_two_phase_gtt.sql` | 会话 GTT `perf06_cand_rowid` |
| `sql-postgres/03_partitioned_tables.sql` | Postgres 对齐 B-tree |

索引定义：

```sql
CREATE INDEX IF NOT EXISTS idx_biz_lightning_time_lon_lat
ON biz_lightning_event (strike_time, longitude, latitude);

CREATE INDEX IF NOT EXISTS idx_biz_lightning_perf06_cover
ON biz_lightning_event (strike_time, longitude, latitude, source_type, lightning_type);
```

GTT：

```sql
CREATE GLOBAL TEMPORARY TABLE IF NOT EXISTS perf06_cand_rowid (
    rid ROWID
) ON COMMIT PRESERVE ROWS;
```

---

## 2. 现网补建（达梦 S5）

索引：执行 `sql-dameng/optional_perf06_bbox_index.sql`，并用 `USER_INDEXES` 确认。  
GTT：执行 `optional_perf06_two_phase_gtt.sql`，或由压测首次自动 CREATE。

---

## 3. 复测步骤（推荐）

### 3.1 精确口径（推荐验收）

1. 操作台达梦 / S5  
2. PERF-06空间选 **`bbox_then_dwithin（两段精确）`**  
3. 查询并发 50，勾选 PERF-06  
4. 确认弹窗/日志为 `bbox_then_dwithin`  
5. 采集资源与执行计划（若 EXPLAIN 仍 -2007，重启操作台再采）  

期望：三条 P95 ≈ **90～110ms**；SQL 含 `INSERT INTO perf06_cand_rowid`。

```bash
python run_load.py benchmark --dialect dameng --stage S5 \
  --scenarios PERF-06 --perf06-geo bbox_then_dwithin
```

### 3.2 近似极限对照

选 `bbox_geog` → 期望 P95 ≈ **40ms**（非业务语义）。

### 3.3 业务原路径对照

选 `geog_only` → 期望 P95 ≈ **400～500ms**。

---

## 4. 回滚

| 动作 | 方法 |
|------|------|
| 回退 SQL 行为 | 页面选 `geog_only` / 环境变量 `DM_PERF06_GEO=geog_only` |
| 回退 cover 索引 | `DROP INDEX idx_biz_lightning_perf06_cover;`（慎用） |
| GTT | 可不删；结构保留、会话数据隔离 |

保留建议：保留两索引 + 三模式；**验收默认 `bbox_then_dwithin`**，`bbox_geog` 仅作近似对照。

---

## 5. 结果数据位置

| 路径 | 说明 |
|------|------|
| `data/stage-records.dameng.json` | 压测历史与配套资源 |
| 本目录 `03` / `05` / `06` | 指标与原理 |
| `leidan-pgsql/wst-temp/perf-notes/` | 临时分析脚本（gitignore） |

关键 runId：`9a3396ea`、`b3dc92f7`、`6f506ab0`、`e4c6b60a`、`b59ea1a8`。

---

## 6. 与业务库关系

索引、GTT、压测 SQL 均在 **leidian-perf-web 压测库**。  
**未**写入 `leidan-pgsql` 业务 Flyway。  
业务对齐步骤见 [../business-landing-checklist.md](../business-landing-checklist.md)（cover + GTT + Mapper 两段；双库迁移）；并发写场景考虑快照一致性。
