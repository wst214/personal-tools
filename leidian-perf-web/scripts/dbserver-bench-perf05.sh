#!/usr/bin/env bash
# dbserver 本机压测 PERF-05（达梦 localhost），完成后写入记录并推送到 perf-web 页面
#
# 用法：
#   chmod +x scripts/dbserver-bench-perf05.sh
#   export DMPASSWORD='你的密码'   # 密码含 @! 时用单引号
#   export PERF_WEB_PUSH_URL='http://192.168.1.10:8100'   # Windows 上 perf-web 地址
#   ./scripts/dbserver-bench-perf05.sh S2
#
# 可选环境变量：
#   PERF05_CONCURRENCY=50
#   PERF05_ITERATIONS=100
#   PERF_WEB_PUSH_URL   压测结束后 POST 到 perf-web，页面约 15s 内自动刷新
#   PERF_SAVE_RECORDS=0   设为 0 则仅推送、不在 dbserver 本地写 data/
#   DMHOST=localhost DMPORT=5236 DMUSER=LEIDIAN_APP DMSCHEMA=PERF
#   DM_HOME=/opt/dmdbms

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="${ROOT}/python"
STAGE="${1:-S2}"
CONCURRENCY="${PERF05_CONCURRENCY:-50}"
ITERATIONS="${PERF05_ITERATIONS:-100}"
SAVE_RECORDS="${PERF_SAVE_RECORDS:-1}"

export DM_HOME="${DM_HOME:-/opt/dmdbms}"
export PATH="${DM_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${DM_HOME}/bin:${LD_LIBRARY_PATH:-}"

export DMHOST="${DMHOST:-localhost}"
export DMPORT="${DMPORT:-5236}"
export DMUSER="${DMUSER:-LEIDIAN_APP}"
export DMSCHEMA="${DMSCHEMA:-PERF}"

if [[ -z "${DMPASSWORD:-}" ]]; then
  echo "ERROR: 请先设置 DMPASSWORD，例如: export DMPASSWORD='Leidian@2026!'" >&2
  exit 1
fi

if [[ ! -x "${PY_DIR}/.venv/bin/python" ]]; then
  echo "ERROR: 未找到 ${PY_DIR}/.venv/bin/python，请先在 dbserver 上初始化 venv + dmPython" >&2
  exit 1
fi

if ! command -v disql >/dev/null 2>&1; then
  echo "ERROR: 未找到 disql，请确认 DM_HOME=${DM_HOME}" >&2
  exit 1
fi

LOG="${PERF05_LOG:-${HOME}/perf05-${STAGE}-c${CONCURRENCY}-i${ITERATIONS}-$(date +%Y%m%d-%H%M%S).log}"

echo "PERF-05 benchmark on dbserver"
echo "  stage=${STAGE} concurrency=${CONCURRENCY} iterations=${ITERATIONS}"
echo "  host=${DMHOST}:${DMPORT} schema=${DMSCHEMA} user=${DMUSER}"
if [[ -n "${PERF_WEB_PUSH_URL:-}" ]]; then
  echo "  push=${PERF_WEB_PUSH_URL} (压测完成后自动出现在 perf-web)"
else
  echo "  WARN: 未设置 PERF_WEB_PUSH_URL，结果仅落本地 data/，页面不会自动更新" >&2
  echo "        例: export PERF_WEB_PUSH_URL='http://你的WindowsIP:8100'" >&2
fi
echo "  log=${LOG}"
echo

cd "${PY_DIR}"

BENCH_ARGS=(
  benchmark
  --dialect dameng
  --stage "${STAGE}"
  --scenarios PERF-05
  --concurrency "${CONCURRENCY}"
  --iterations "${ITERATIONS}"
  --host "${DMHOST}"
  --schema "${DMSCHEMA}"
  --user "${DMUSER}"
  --password "${DMPASSWORD}"
)

if [[ "${SAVE_RECORDS}" != "0" ]]; then
  BENCH_ARGS+=(--save-records)
fi
if [[ -n "${PERF_WEB_PUSH_URL:-}" ]]; then
  BENCH_ARGS+=(--push-url "${PERF_WEB_PUSH_URL}")
fi

set +e
.venv/bin/python run_load.py "${BENCH_ARGS[@]}" 2>&1 | tee "${LOG}"
exit_code=${PIPESTATUS[0]}
set -e

exit "${exit_code}"
