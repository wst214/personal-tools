## 达梦写入改造计划（不影响 PG 链路）

目标：在保持 PostgreSQL 现有实现完全不变的前提下，逐步接入达梦 DM8 造数/校验/压测执行链。

### 原则（硬约束）

- 只新增达梦侧模块与显式分支，不在 PG 代码路径里引入 DM 依赖/行为
- **数据与记录严格分离**：
  - 库连接：PG `leidian_perf` / schema `perf` ≠ DM `LEIDIAN_PERF` / schema `PERF`
  - 记录：`stage-records.json` 的 `dialects.postgres` 与 `dialects.dameng` 互不写入
  - 环境模板：`env-profile.postgres.json` 与 `env-profile.dameng.json` 互不合并
  - 造数锁：PG advisory lock 不用于探测达梦状态
- 先小表后大表：先 S0/S1 可控写入，再逐步优化批量性能

### 里程碑

1. **写入层**（优先）
   - 方案 A：`dmPython`（首选，后续可做参数化批量与事务）
   - 方案 B：`disql`（保底，适合 DDL 与少量 DML；大批量需评估性能）
   - 产物：`generators/dameng_runtime.py` 的 `insert_rows_dameng()` 可用

2. **分区补齐**
   - 对标 PG `create_monthly_partitions`：对 DM 通过 `ALTER TABLE ADD PARTITION` 按月补齐
   - 产物：达梦侧 `ensure_monthly_partitions_dameng()`（按 `DBA_TAB_PARTITIONS` 探测缺失）

3. **逐阶段写入**
   - 先写无 GEO/复杂类型的小表（如 `thunderstorm_process`、事件类表）
   - 后写包含 GEO 的 `mine_site`（确认 DM GEO 类型与函数：WKT → `ST_GEOMETRYFROMTEXT` 或等价）
   - raw 报文表：大批量写入方式与字段映射（数组/JSON/CLOB）

4. **校验与压测**
   - `validate.py`：将统计/关联校验 SQL 改写为 DM 方言
   - `sql_bench.py`：替换 `pg_stat_statements` 统计为 DM 等价（或退化为 explain + 计时）
   - `resource_collect.py`：慢 SQL 采样策略按方言拆分

### 接入策略

- 先保持 `run_load.py`/`web/server.py` 中达梦“BLOCKED”不变
- 当 `insert_rows_dameng()` + 核心表写入完成后，再逐步放开达梦的 `load`/`validate`/`benchmark`

