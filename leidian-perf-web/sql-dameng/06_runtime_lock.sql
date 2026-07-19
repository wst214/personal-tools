-- DM runtime lock table for load vs benchmark mutual exclusion
ALTER SESSION SET CURRENT_SCHEMA = "PERF";

CREATE TABLE IF NOT EXISTS perf_runtime_lock (
    lock_name   VARCHAR(32)  NOT NULL,
    holder      VARCHAR(128),
    locked_at   TIMESTAMP    DEFAULT SYSDATE,
    CONSTRAINT pk_perf_runtime_lock PRIMARY KEY (lock_name)
);

-- perf_runtime_lock: mutual exclusion for load vs benchmark
