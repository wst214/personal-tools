#!/usr/bin/env bash
# 在 dbserver 本机造 S8（达梦，清空后全量）
# S8：100 台 × 30 天真 1Hz（std/biz/raw），过程/闪电等量级同 S7；写入压测落在大气窗之后
#
# 用法：
#   export DMPASSWORD='Leidian@2026!'
#   chmod +x scripts/dbserver-load-s8.sh
#   ./scripts/dbserver-load-s8.sh
#
# 后台跑（默认，SSH 断开也继续）：
#   ./scripts/dbserver-load-s8.sh
# 前台跟日志：
#   ./scripts/dbserver-load-s8.sh --foreground
#
# 可选环境变量：
#   DMHOST=localhost DMPORT=5236 DMUSER=LEIDIAN_APP DMSCHEMA=PERF
#   DM_HOME=/opt/dmdbms
#   S8_LOAD_LOG=~/s8-load.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="${ROOT}/python"
STAGE="S8"
FOREGROUND=0
LOG_FILE="${S8_LOAD_LOG:-$HOME/s8-load.log}"

for arg in "$@"; do
  case "$arg" in
    --foreground|-f) FOREGROUND=1 ;;
    --help|-h)
      echo "Usage: $0 [--foreground]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

export DM_HOME="${DM_HOME:-/opt/dmdbms}"
export PATH="${DM_HOME}/bin:${PATH}"
export LD_LIBRARY_PATH="${DM_HOME}/bin:${LD_LIBRARY_PATH:-}"

export DMHOST="${DMHOST:-localhost}"
export DMPORT="${DMPORT:-5236}"
export DMUSER="${DMUSER:-LEIDIAN_APP}"
export DMSCHEMA="${DMSCHEMA:-PERF}"
export PERF_DB_DIALECT=dameng

if [[ -z "${DMPASSWORD:-}" ]]; then
  echo "ERROR: 请先设置 DMPASSWORD，例如: export DMPASSWORD='Leidian@2026!'" >&2
  exit 1
fi

if [[ ! -x "${PY_DIR}/.venv/bin/python" ]]; then
  echo "ERROR: 未找到 ${PY_DIR}/.venv/bin/python" >&2
  echo "  从备份拷回: cp -a ~/leidian-perf-web-backups/*/python/.venv ${PY_DIR}/.venv" >&2
  exit 1
fi

if ! grep -q '^  S8:' "${PY_DIR}/config/volume-profiles.yaml"; then
  echo "ERROR: volume-profiles.yaml 中没有 S8，请先同步最新代码" >&2
  exit 1
fi

if ! grep -q 'atmosphere_device_count: 100' "${PY_DIR}/config/volume-profiles.yaml"; then
  echo "ERROR: S8 需要 atmosphere_device_count: 100，请确认已同步含 S8 的 volume-profiles.yaml" >&2
  exit 1
fi

if ! command -v disql >/dev/null 2>&1; then
  echo "ERROR: 未找到 disql，请确认 DM_HOME=${DM_HOME}" >&2
  exit 1
fi

if pgrep -f 'run_load\.py (load|append-atmosphere)' >/dev/null 2>&1; then
  echo "ERROR: 已有造数/续造进程在跑，请先停掉或等待结束" >&2
  ps aux | grep -E 'run_load.py (load|append-atmosphere)' | grep -v grep || true
  exit 1
fi

cd "${PY_DIR}"

CMD=(
  .venv/bin/python run_load.py load
  --stage "${STAGE}"
  --dialect dameng
  --truncate
  --host "${DMHOST}"
  --port "${DMPORT}"
  --user "${DMUSER}"
  --password "${DMPASSWORD}"
)

echo "== S8 造数 =="
echo "  root: ${ROOT}"
echo "  host: ${DMUSER}@${DMHOST}:${DMPORT} schema=${DMSCHEMA}"
echo "  log:  ${LOG_FILE}"
echo "  profile: 100台×30天真1Hz，约 2.59亿行/层（std+biz+raw），过程等同 S7"
echo "  WARN: --truncate 会清空当前 PERF 库数据"
echo

if [[ "${FOREGROUND}" -eq 1 ]]; then
  echo "前台执行…"
  "${CMD[@]}" 2>&1 | tee "${LOG_FILE}"
  echo "完成。日志: ${LOG_FILE}"
else
  nohup "${CMD[@]}" >"${LOG_FILE}" 2>&1 &
  PID=$!
  echo "已后台启动 pid=${PID}"
  echo "看进度: tail -f ${LOG_FILE}"
  echo "查进程: ps -p ${PID} -o pid,etime,cmd"
  echo "停造数: pkill -f 'run_load.py load'   # 或 scripts/stop-dbserver-load.sh"
fi
