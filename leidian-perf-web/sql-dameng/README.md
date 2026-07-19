# sql-dameng — 达梦 DM8 PERF Schema DDL

与 `../sql-postgres/`（PostgreSQL + PostGIS）**完全独立**，表名与字段语义对齐，语法按 DM8 改写。

## 执行顺序

| 文件 | 说明 |
|------|------|
| `00_init_schema.sql` | 启用 DMGEO2、校验 SYSGEO2、创建 PERF schema |
| `01_planning_tables.sql` | 规划/业务闭环表 |
| `02_device_tables.sql` | 低频设备 standard/biz 表 |
| `03_partitioned_tables.sql` | 高频 RANGE 分区父表 |
| `04_functions_triggers.sql` | 月分区过程 + 空间点触发器 |
| `05_default_partitions.sql` | 默认 2025-03 ~ 2026-02 月分区 |
| `90_drop_schema.sql` | 删除 PERF schema（重置用） |
| `post_load_validate.sql` | 造数后手工校验 |

一键执行：

```bash
cd sql-dameng
./run_init.sh
# Windows
.\run_init.ps1
```

环境变量：`DMHOST` `DMPORT` `DMSERVICE` `DMUSER` `DMPASSWORD`

## 与 PostgreSQL 版主要差异

| 项目 | PostgreSQL (`sql-postgres/`) | 达梦 (`sql-dameng/`) |
|------|---------------------|----------------------|
| 空间扩展 | `CREATE EXTENSION postgis` | **DMGEO2**（`CALL SP_INIT_GEO2_SYS(1)`） |
| 空间类型 | `GEOGRAPHY` / `GEOMETRY` | `SYSGEO2.ST_GEOMETRY` |
| 空间索引 | `USING GIST` | `CREATE SPATIAL INDEX` |
| 50km 查询 | `ST_DWithin(geog, geog, 50000)`（PostGIS geography） | `ST_DWithin(ST_GeomToGeog(a), ST_GeomToGeog(b), 50000)`（**米**；geometry 直用会把 50000 当度） |
| 数组字段 | `BIGINT[]` | `VARCHAR(4000)` 逗号分隔 ID |
| 大文本 | `TEXT` | `CLOB` |
| 分区子表 | `PARTITION OF ... FOR VALUES` | `ALTER TABLE ADD PARTITION` |
| 默认时间 | `CURRENT_TIMESTAMP` | `SYSDATE` |
| 客户端 | `psql` | `disql` |

## 前置条件（必读）

### 1. DMGEO2 空间组件

PERF 达梦 DDL **依赖 DMGEO2**。50km 统计须 **ST_GeomToGeog + ST_DWithin**（单位米），与 PostGIS geography 语义对齐。

在 **dbserver** 上验证（通常用具备 DBA 权限的账号，如 `SYSDBA` 或专门的运维账号）：

```bash
export PATH=/opt/dmdbms/bin:$PATH
disql SYSDBA/<password>@localhost:5236

-- 启用（需安装包已含空间模块）
CALL SP_INIT_GEO2_SYS(1);

-- 应返回 1
SELECT COUNT(*) FROM SYS.SYSOBJECTS WHERE NAME = 'SYSGEO2' AND TYPE$ = 'SCH';
```

若仍为 `0`：当前 DM 安装**未包含空间组件**，需：

1. 使用带「空间数据 / DMGEO」选项的 DM8 安装介质重装或增补组件；或
2. 从达梦官方获取空间扩展包并按手册安装到 `$DM_HOME`。

**不要**在同一实例上同时启用 DMGEO1 与 DMGEO2；PERF 方案统一使用 **DMGEO2**。

### 2. 其他

- 实例可连接（默认端口 `5236`）
- 初始化 PERF schema 时建议使用具备 DBA 权限的账号（本项目压测默认业务账号为 `LEIDIAN_APP`，已授予 `DBA` 角色）

## 注意

- 本目录仅提供 **DDL**；Python 造数/压测使用 `dmPython` + `disql`（见同仓库 `leidian-perf-web/python/`）。
- 分区父表占位分区为 `LESS THAN 2025-03-01`，`05_default_partitions.sql` 再批量 `ADD PARTITION` 并追加 `_P_MAX`。
- 从 WKT CLOB 兜底版迁移到 GEO2 后，需 `90_drop_schema.sql` 重建 PERF schema。
- 若 `DMGEO2.ST_PointFromText` 报错，请对照 `$DM_HOME/doc` 下空间手册核对函数名（少数版本为 `DMGEO` / `SYSGEO`）。
