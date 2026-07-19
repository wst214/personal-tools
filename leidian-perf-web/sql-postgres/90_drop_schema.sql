-- 删除 PERF 独立 Schema（重置压测库时使用）
-- 警告：将删除 perf 下全部对象

DROP SCHEMA IF EXISTS perf CASCADE;
