#!/usr/bin/env bash
# 在 dbserver 上停止造数：结束 run_load.py，并清理达梦造数锁
# 注意：密码含 @ / ! 时不要用 disql user/pass@host 直连（会被拆坏），改用 Python 清锁。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="${ROOT}/python"

export DM_HOME="${DM_HOME:-/opt/dmdbms}"
export PATH="${DM_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${DM_HOME}/bin:${LD_LIBRARY_PATH:-}"

echo "== 当前造数相关进程 =="
ps aux | grep -E 'run_load\.py|server\.py' | grep -v grep || true

echo
echo "== 结束 run_load.py =="
pkill -f 'run_load\.py load' 2>/dev/null || true
pkill -f 'run_load\.py append-atmosphere' 2>/dev/null || true
sleep 2
pkill -9 -f 'run_load\.py load' 2>/dev/null || true
pkill -9 -f 'run_load\.py append-atmosphere' 2>/dev/null || true

echo
echo "== 清理达梦造数锁 perf_runtime_lock =="
if [[ -z "${DMPASSWORD:-}" ]]; then
  echo "WARN: 未设置 DMPASSWORD，请手动清锁："
  echo "  DELETE FROM PERF.perf_runtime_lock WHERE lock_name='LOAD'; COMMIT;"
elif [[ -x "${PY_DIR}/.venv/bin/python" ]]; then
  (
    cd "${PY_DIR}"
    DMHOST="${DMHOST:-localhost}" \
    DMPORT="${DMPORT:-5236}" \
    DMUSER="${DMUSER:-LEIDIAN_APP}" \
    DMSCHEMA="${DMSCHEMA:-PERF}" \
    DMPASSWORD="${DMPASSWORD}" \
    .venv/bin/python - <<'PY'
import os
from generators.dameng_conn import DamengConn
from generators.dm_write import dm_scalar, run_dm_script

conn = DamengConn(
    host=os.environ.get("DMHOST", "localhost"),
    port=os.environ.get("DMPORT", "5236"),
    user=os.environ.get("DMUSER", "LEIDIAN_APP"),
    password=os.environ["DMPASSWORD"],
    schema=os.environ.get("DMSCHEMA", "PERF"),
)
before = dm_scalar(conn, "SELECT count(*) FROM perf_runtime_lock WHERE lock_name = 'LOAD'")
run_dm_script(conn, "DELETE FROM perf_runtime_lock WHERE lock_name = 'LOAD';")
after = dm_scalar(conn, "SELECT count(*) FROM perf_runtime_lock WHERE lock_name = 'LOAD'")
print(f"lock rows before={before} after={after}")
PY
  )
else
  echo "WARN: 未找到 ${PY_DIR}/.venv/bin/python，尝试带引号的 disql…"
  HOST="${DMHOST:-localhost}"
  PORT="${DMPORT:-5236}"
  USER="${DMUSER:-LEIDIAN_APP}"
  # 密码含 @ 必须用双引号包起来，否则 disql 会把 @ 后半段当成 host
  disql -S "${USER}/\"${DMPASSWORD}\"@${HOST}:${PORT}" <<'EOSQL'
SET SCHEMA PERF;
DELETE FROM perf_runtime_lock WHERE lock_name = 'LOAD';
COMMIT;
EXIT;
EOSQL
fi

echo
echo "== 清理后 =="
ps aux | grep run_load | grep -v grep || echo "无 run_load 进程"
echo "完成。"
