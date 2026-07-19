"""达梦造数锁（perf_runtime_lock 表）；与 PostgreSQL advisory lock 隔离。"""

from __future__ import annotations

import os
import socket
import uuid
from contextlib import contextmanager
from typing import Callable, Iterator

from generators.dameng_conn import DamengConn
from generators.dm_write import dm_scalar, run_dm_script

LOCK_NAME = "LOAD"
_HOLDER = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"


class LoadInProgressError(RuntimeError):
    pass


def _ensure_lock_table(conn: DamengConn) -> None:
    run_dm_script(
        conn,
        """
        CREATE TABLE IF NOT EXISTS perf_runtime_lock (
            lock_name VARCHAR(32) NOT NULL,
            holder VARCHAR(128),
            locked_at TIMESTAMP DEFAULT SYSDATE,
            CONSTRAINT pk_perf_runtime_lock PRIMARY KEY (lock_name)
        );
        """,
    )


def is_load_in_progress(conn: DamengConn) -> bool:
    try:
        _ensure_lock_table(conn)
        return dm_scalar(conn, f"SELECT count(*) FROM perf_runtime_lock WHERE lock_name = '{LOCK_NAME}'") > 0
    except Exception:
        return False


def assert_no_load_in_progress(conn: DamengConn, action: str = "操作") -> None:
    if is_load_in_progress(conn):
        raise LoadInProgressError(f"造数进行中（达梦造数锁已占用），请等待完成后再{action}")


@contextmanager
def load_advisory_lock(
    conn: DamengConn,
    log: Callable[[str], None] | None = None,
) -> Iterator[None]:
    emit = log or (lambda _m: None)
    _ensure_lock_table(conn)
    if is_load_in_progress(conn):
        raise LoadInProgressError("已有造数任务在运行（达梦造数锁未释放）")
    run_dm_script(
        conn,
        f"""
        INSERT INTO perf_runtime_lock (lock_name, holder, locked_at)
        VALUES ('{LOCK_NAME}', '{_HOLDER}', SYSDATE);
        """,
    )
    emit("[guard] 已获取达梦造数锁：压测 / 全表统计 / 资源采集已阻塞，直至造数结束")
    try:
        yield
    finally:
        run_dm_script(conn, f"DELETE FROM perf_runtime_lock WHERE lock_name = '{LOCK_NAME}';")
        emit("[guard] 达梦造数锁已释放")
