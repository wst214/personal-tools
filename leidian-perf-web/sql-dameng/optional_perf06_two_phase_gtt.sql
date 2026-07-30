-- PERF-06 两段式候选表（会话级 GTT）。
-- 结构全局一次创建；各会话数据隔离。压测也可由 dameng_sql_bench 自动 CREATE。
-- 第 1 段写入 ROWID（二级索引叶子可直接拿到，避免为取 id 回表）；
-- 第 2 段 JOIN + ST_DWithin 精筛。

CREATE GLOBAL TEMPORARY TABLE IF NOT EXISTS perf06_cand_rowid (
    rid ROWID
) ON COMMIT PRESERVE ROWS;
