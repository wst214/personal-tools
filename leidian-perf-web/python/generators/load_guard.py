"""造数期间 PostgreSQL advisory lock：防止 COPY 与压测清理 / 全表统计互锁。"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Callable, Iterator

import psycopg2

# session 级 advisory lock（classid, objid）
LOAD_LOCK_KEY1 = 0x4C44  # 'LD'
LOAD_LOCK_KEY2 = 0x5045  # 'PE'

# 小表可安全 count(*)；大表仅在无造数锁时统计
SMALL_COUNT_TABLES = frozenset({"mine_site", "thunderstorm_process"})


class LoadInProgressError(RuntimeError):
    """造数锁仍被占用时拒绝压测 / 全表统计等操作。"""


def is_load_in_progress(dsn: str) -> bool:
    conn = psycopg2.connect(dsn, connect_timeout=5)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT 1 FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = %s AND objid = %s
                  AND granted
                LIMIT 1
                """,
                (LOAD_LOCK_KEY1, LOAD_LOCK_KEY2),
            )
            return cur.fetchone() is not None
    finally:
        conn.close()


def assert_no_load_in_progress(dsn: str, action: str = "操作") -> None:
    if is_load_in_progress(dsn):
        raise LoadInProgressError(
            f"造数进行中（库内造数锁已占用），请等待造数完成后再{action}"
        )


@contextmanager
def load_advisory_lock(
    dsn: str,
    log: Callable[[str], None] | None = None,
) -> Iterator[None]:
    """造数全程持有 advisory lock；连接断开时 PG 自动释放。"""
    emit = log or (lambda _m: None)
    conn = psycopg2.connect(
        dsn,
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=30,
        keepalives_interval=10,
        keepalives_count=5,
    )
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s, %s)", (LOAD_LOCK_KEY1, LOAD_LOCK_KEY2))
            acquired = bool(cur.fetchone()[0])
        if not acquired:
            raise LoadInProgressError("已有造数任务在运行（造数锁未释放），请勿重复启动")
        emit("[guard] 已获取造数锁：压测 / 全表统计 / 资源采集已阻塞，直至造数结束")
        yield
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s, %s)", (LOAD_LOCK_KEY1, LOAD_LOCK_KEY2))
        except Exception:
            pass
        conn.close()
        emit("[guard] 造数锁已释放")
