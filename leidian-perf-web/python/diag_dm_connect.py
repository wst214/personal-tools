#!/usr/bin/env python3
"""达梦 dmPython 连通性诊断：TCP + 单次建连 + N 路并发建连。"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def tcp_check(host: str, port: int, timeout: float = 5.0) -> None:
    with socket.create_connection((host, port), timeout):
        pass
    print(f"OK TCP {host}:{port}")


def dm_once(user: str, password: str, host: str, port: int) -> None:
    import dmPython

    db = dmPython.connect(user=user, password=password, server=host, port=port)
    try:
        cur = db.cursor()
        cur.execute("SELECT 1 FROM DUAL")
        row = cur.fetchone()
        cur.close()
        print(f"OK dmPython once {row}")
    finally:
        db.close()


def dm_concurrent(user: str, password: str, host: str, port: int, n: int) -> list[str]:
    import dmPython

    errs: list[str] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        try:
            db = dmPython.connect(user=user, password=password, server=host, port=port)
            try:
                time.sleep(1.0)
            finally:
                db.close()
        except Exception as exc:  # noqa: BLE001
            with lock:
                errs.append(f"w{i}:{exc}")

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(n)]
    for i, t in enumerate(threads):
        t.start()
        if i + 1 < n:
            time.sleep(0.05)
    for t in threads:
        t.join()
    return errs


def main() -> int:
    host = _env("DMHOST", "192.168.1.41")
    port = int(_env("DMPORT", "5236"))
    user = _env("DMUSER", "LEIDIAN_APP")
    password = _env("DMPASSWORD", "")
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20

    print(f"=== diag host={host}:{port} user={user} concurrent={n} ===")

    try:
        tcp_check(host, port)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL TCP {exc}")
        return 1

    try:
        dm_once(user, password, host, port)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL dmPython once {exc}")
        return 1

    errs = dm_concurrent(user, password, host, port, n)
    if errs:
        print(f"FAIL concurrent {len(errs)}/{n}")
        for msg in errs[:10]:
            print(f"  {msg}")
        if len(errs) > 10:
            print(f"  ... +{len(errs) - 10} more")
        return 1

    print(f"OK concurrent {n}/{n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
