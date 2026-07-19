"""达梦 DM8 连接（dmPython）；与 PostgreSQL psycopg2 完全隔离。"""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from generators.dameng_conn import DamengConn
from generators.dialect import catalog_schema


class DamengDriverNotFoundError(RuntimeError):
    pass


DM_BENCH_DEFAULT_ARRAYSIZE = 2000


def dm_bench_arraysize() -> int:
    """压测读游标 fetchmany 批次；可用 DM_BENCH_ARRAYSIZE / DM_BENCH_FETCH_BATCH 覆盖。"""
    for key in ("DM_BENCH_ARRAYSIZE", "DM_BENCH_FETCH_BATCH"):
        raw = os.environ.get(key)
        if raw is not None and str(raw).strip():
            try:
                val = int(raw)
                if val > 0:
                    return val
            except ValueError:
                pass
    return DM_BENCH_DEFAULT_ARRAYSIZE


def configure_dm_read_cursor(cur: Any) -> None:
    """读场景游标：避免 execute 后为 rowcount 物化整包；与 fetchmany 批次对齐。"""
    if hasattr(cur, "lazy_rowcount"):
        cur.lazy_rowcount = True
    cur.arraysize = dm_bench_arraysize()


def _import_dm_python():
    try:
        import dmPython  # type: ignore
    except ImportError as exc:
        raise DamengDriverNotFoundError(
            "未安装 dmPython。达梦压测/高频校验需在已安装 DM 客户端的机器执行："
            "pip install dmPython（或从 DM 安装目录获取）"
        ) from exc
    return dmPython


def connect_dm(conn: DamengConn) -> Any:
    dmPython = _import_dm_python()
    pwd = conn.password or ""
    return dmPython.connect(user=conn.user, password=pwd, server=conn.host, port=int(conn.port))


def connect_dm_with_retry(
    conn: DamengConn,
    *,
    retries: int = 3,
    delay_sec: float = 0.15,
) -> Any:
    """并发压测时 dmPython 建连可能瞬时失败（-70028），短重试兜底。"""
    last_exc: Exception | None = None
    for attempt in range(max(retries, 1)):
        try:
            return connect_dm(conn)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt + 1 < retries:
                time.sleep(delay_sec * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def setup_dm_bench_session(db: Any, conn: DamengConn, *, read_only: bool = False) -> Any:
    """压测 worker 会话：对齐 dm_connection 的 schema 引号；读场景 autocommit=True。"""
    if read_only:
        db.autocommit = True
    cur = db.cursor()
    cur.execute(f'ALTER SESSION SET CURRENT_SCHEMA = "{conn.owner}"')
    if read_only:
        configure_dm_read_cursor(cur)
    return cur


# DM8 使用 V$SESSIONS + STATE；Oracle 风格 V$SESSION + STATUS 仅作兜底
_ACTIVE_SESSION_COUNT_SQLS = (
    "SELECT count(*) FROM V$SESSIONS WHERE STATE = 'ACTIVE'",
    "SELECT count(*) FROM V$SESSION WHERE STATUS = 'ACTIVE'",
)


def fetch_active_session_count_on_cursor(cur: Any) -> int:
    last_exc: Exception | None = None
    for sql in _ACTIVE_SESSION_COUNT_SQLS:
        try:
            cur.execute(sql)
            row = cur.fetchone()
            return int(row[0]) if row else 0
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
    if last_exc is not None:
        raise last_exc
    return 0


def fetch_active_session_count_dameng(conn: DamengConn) -> int:
    """当前活跃会话数；视图不可用或无权限时返回 0。"""
    try:
        with dm_connection(conn) as db:
            cur = db.cursor()
            try:
                return fetch_active_session_count_on_cursor(cur)
            finally:
                cur.close()
    except Exception:
        return 0


def fetch_conn_peak_dameng(conn: DamengConn) -> int:
    """连接峰值快照；与 fetch_active_session_count_dameng 同口径。"""
    return fetch_active_session_count_dameng(conn)


class DamengConnPeakSampler:
    """压测过程中轮询 V$SESSIONS，记录连接峰值（单连接采样，避免反复建连）。"""

    def __init__(self, conn: DamengConn, interval_sec: float = 0.5) -> None:
        self._conn = conn
        self._interval = interval_sec
        self.peak = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _poll_once(self, db: Any) -> None:
        cur = db.cursor()
        try:
            cnt = fetch_active_session_count_on_cursor(cur)
            if cnt > self.peak:
                self.peak = cnt
        finally:
            cur.close()

    def start(self) -> None:
        def loop() -> None:
            try:
                db = connect_dm_with_retry(self._conn)
            except Exception:
                return
            try:
                while not self._stop.is_set():
                    try:
                        self._poll_once(db)
                    except Exception:
                        pass
                    self._stop.wait(self._interval)
            finally:
                try:
                    db.close()
                except Exception:
                    pass

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop(self) -> int:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
        return self.peak


@contextmanager
def dm_connection(conn: DamengConn) -> Iterator[Any]:
    owner = catalog_schema(conn.schema, "dameng")
    db = connect_dm(conn)
    try:
        cur = db.cursor()
        cur.execute(f'ALTER SESSION SET CURRENT_SCHEMA = "{owner}"')
        cur.close()
        yield db
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        raise
    finally:
        try:
            db.close()
        except Exception:
            pass


def dm_execute(conn: DamengConn, sql: str, *, commit: bool = True) -> None:
    with dm_connection(conn) as db:
        cur = db.cursor()
        try:
            cur.execute(sql)
        finally:
            cur.close()
        if commit:
            db.commit()


def dm_fetch_scalar(conn: DamengConn, sql: str) -> int:
    with dm_connection(conn) as db:
        cur = db.cursor()
        try:
            cur.execute(sql)
            row = cur.fetchone()
            if not row:
                return 0
            return int(row[0])
        finally:
            cur.close()


def dm_fetch_all(conn: DamengConn, sql: str) -> list[tuple]:
    with dm_connection(conn) as db:
        cur = db.cursor()
        try:
            cur.execute(sql)
            return list(cur.fetchall())
        finally:
            cur.close()
