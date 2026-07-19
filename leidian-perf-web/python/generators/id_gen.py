"""PERF 造数 ID 生成器（单进程单调递增，保证千万级不重复）。

原 Snowflake 依赖系统时钟毫秒 + 12 位序列；在容器里高速造数时，若时钟粒度粗或
同毫秒序列回绕，可能产出重复 id。standard/biz 主键为 (id, device_upload_time)，
重复 id 配不同时间会写入成功，但 biz.standard_record_id 会出现重复，触发 1:1 校验失败。
"""

from __future__ import annotations

import threading

_WORKER_BITS = 10
_MAX_WORKER = (1 << _WORKER_BITS) - 1


class SnowflakeGenerator:
    def __init__(self, worker_id: int = 1) -> None:
        if worker_id < 0 or worker_id > _MAX_WORKER:
            raise ValueError(f"worker_id out of range: {worker_id}")
        self._worker_id = worker_id
        self._lock = threading.Lock()
        self._seq = 0

    def next_id(self) -> int:
        with self._lock:
            self._seq += 1
            return (self._worker_id << 52) | self._seq
