-- PERF 独立 Schema 初始化
-- 依据：性能测试开展方案.docx（表结构 / 分区 / PostGIS 约定）
-- 用途：压测专用库或独立 schema，不影响 Flyway public 表
-- 前置：PostgreSQL 16 + PostGIS 3.x（推荐镜像 postgis/postgis:16-3.4）
-- 执行：run_init.ps1 / run_init.sh

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS perf;

COMMENT ON SCHEMA perf IS '雷暴过程业务数据平台 — 性能测试独立 Schema（PERF 环境专用）';

SET search_path TO perf, public;
