#!/usr/bin/env python3
"""PERF-05-AGG 达梦 EXPLAIN 诊断（一次性）。

打印 50 台（可改）AGG 查询的执行计划，定位：
  - SORT / HSCN(哈希聚合是否排序) —— GROUP BY TRUNC(time,'MI') 是否触发排序
  - BLKUP2 —— 覆盖索引是否真正无回表
  - CSCN2(全表扫) vs SSEK2/CSEK2(索引) —— 索引是否命中
  - 分区名 _Y{yyyy}M{mm} —— 2h 窗是否只裁剪到 1 个月分区

用法（在 dbserver 或能连 DM 的机器上）：
  export DMPASSWORD='你的密码'
  export DMHOST=localhost DMPORT=5236 DMUSER=LEIDIAN_APP DMSCHEMA=PERF
  export STAGE=S8 DEVICE_LIMIT=50 AGG_BUCKET=10
  # dmPython 依赖 libdmdpi.so，必须把 DM 的 bin 加进 LD_LIBRARY_PATH，否则 import 报错
  export DM_HOME=/opt/dmdbms
  export LD_LIBRARY_PATH="$DM_HOME/bin:$LD_LIBRARY_PATH"
  .venv/bin/python _diag_perf05_agg_explain_dm.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from generators.dameng_conn import DamengConn
from generators.dameng_db import connect_dm_with_retry, setup_dm_bench_session
from generators.dameng_sql_bench import _sql_perf05_agg, resolve_context_dameng


def main() -> None:
    conn = DamengConn(
        host=os.environ.get("DMHOST", "localhost"),
        port=os.environ.get("DMPORT", "5236"),
        user=os.environ.get("DMUSER", "LEIDIAN_APP"),
        password=os.environ["DMPASSWORD"],
        schema=os.environ.get("DMSCHEMA", "PERF"),
    )
    stage = os.environ.get("STAGE", "S8")
    dev_limit = int(os.environ.get("DEVICE_LIMIT", "50"))
    bucket = int(os.environ.get("AGG_BUCKET", "10"))

    ctx = resolve_context_dameng(
        conn,
        config_dir=ROOT / "config",
        scenarios=["PERF-05-AGG"],
        stage=stage,
        device_limit_override=dev_limit,
    )
    ctx.perf05_agg_bucket_minutes = bucket

    sql = _sql_perf05_agg(ctx, 0, 0).strip()
    sql_oneline = " ".join(
        ln for ln in sql.splitlines() if not ln.lstrip().startswith("--")
    ).strip()

    print(f"=== AGG SQL (stage={stage} devices={dev_limit} bucket={bucket}min) ===")
    print(sql_oneline[:600])
    if len(sql_oneline) > 600:
        print(f"...(共 {len(sql_oneline)} 字符)")
    print("\n=== EXPLAIN FOR ===")
    db = connect_dm_with_retry(conn)
    try:
        cur = setup_dm_bench_session(db, conn, read_only=True)
        try:
            cur.execute(f"EXPLAIN FOR {sql_oneline}")
            rows = cur.fetchall()
        finally:
            cur.close()
    finally:
        db.close()

    if not rows:
        print("(无输出)")
        return
    for row in rows:
        cells = [str(c).strip() for c in row if c is not None and str(c).strip()]
        if cells:
            print(" ".join(cells))


if __name__ == "__main__":
    main()
