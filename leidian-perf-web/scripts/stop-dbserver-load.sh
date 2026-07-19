#!/usr/bin/env bash
# 在 dbserver 上停止造数：结束 run_load.py，并清理达梦造数锁
set -euo pipefail

export DM_HOME="${DM_HOME:-/opt/dmdbms}"
export PATH="${DM_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${DM_HOME}/bin:${LD_LIBRARY_PATH:-}"

echo "== 当前造数相关进程 =="
ps aux | grep -E 'run_load\.py|server\.py' | grep -v grep || true

echo
echo "== 结束 run_load.py =="
pkill -f 'run_load\.py load' 2>/dev/null || true
sleep 2
pkill -9 -f 'run_load\.py load' 2>/dev/null || true

echo
echo "== 清理达梦造数锁 perf_runtime_lock =="
if [[ -n "${DMPASSWORD:-}" ]] && command -v disql >/dev/null 2>&1; then
  disql -S "${DMUSER:-LEIDIAN_APP}/${DMPASSWORD}@$(hostname -I | awk '{print $1}'):${DMPORT:-5236}" <<'EOSQL'
SET SCHEMA PERF;
DELETE FROM perf_runtime_lock WHERE lock_name = 'LOAD';
COMMIT;
EXIT;
EOSQL
else
  echo "WARN: 未设置 DMPASSWORD，请手动执行: DELETE FROM PERF.perf_runtime_lock WHERE lock_name='LOAD'; COMMIT;"
fi

echo
echo "== 清理后 =="
ps aux | grep run_load | grep -v grep || echo "无 run_load 进程"
echo "完成。"
