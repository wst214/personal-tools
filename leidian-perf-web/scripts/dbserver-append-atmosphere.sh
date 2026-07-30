#!/usr/bin/env bash
# 在 dbserver 本机：仅续写大气电场（std/biz/raw），真 1Hz 满铺，默认再铺 15 天
# 自动接在现有 MAX(device_upload_time)+1s 之后；不写过程/闪电等，不清空
# 安全：只 INSERT 新时间段；起点若与已有数据重叠则直接失败，绝不改/删旧行
#
# 用法：
#   export DMPASSWORD='Leidian@2026!'
#   chmod +x scripts/dbserver-append-atmosphere.sh
#   ./scripts/dbserver-append-atmosphere.sh
#   ./scripts/dbserver-append-atmosphere.sh --days 15
#   ./scripts/dbserver-append-atmosphere.sh --foreground
#
# 可选环境变量：
#   DMHOST=localhost DMPORT=5236 DMUSER=LEIDIAN_APP DMSCHEMA=PERF
#   APPEND_DAYS=15
#   APPEND_START='2025-07-09T00:00:00'   # 不设则自动接续
#   APPEND_ATM_LOG=~/s7-append-atm.log

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="${ROOT}/python"
STAGE="${APPEND_STAGE:-S7}"
DAYS="${APPEND_DAYS:-15}"
FOREGROUND=0
LOG_FILE="${APPEND_ATM_LOG:-$HOME/s7-append-atm.log}"
START_ARG=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground|-f) FOREGROUND=1; shift ;;
    --days)
      DAYS="$2"; shift 2 ;;
    --start)
      START_ARG=(--start "$2"); shift 2 ;;
    --stage)
      STAGE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--days N] [--start ISO8601] [--stage S7] [--foreground]"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "${APPEND_START:-}" && ${#START_ARG[@]} -eq 0 ]]; then
  START_ARG=(--start "${APPEND_START}")
fi

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
  exit 1
fi

if ! grep -q 'append-atmosphere' "${PY_DIR}/run_load.py"; then
  echo "ERROR: run_load.py 无 append-atmosphere，请先同步最新代码" >&2
  exit 1
fi

if pgrep -f 'run_load\.py (load|append-atmosphere)' >/dev/null 2>&1; then
  echo "ERROR: 已有造数/续造进程在跑，请先停掉或等待结束" >&2
  ps aux | grep -E 'run_load.py (load|append-atmosphere)' | grep -v grep || true
  exit 1
fi

cd "${PY_DIR}"

CMD=(
  .venv/bin/python run_load.py append-atmosphere
  --stage "${STAGE}"
  --days "${DAYS}"
  --dialect dameng
  --host "${DMHOST}"
  --port "${DMPORT}"
  --user "${DMUSER}"
  --password "${DMPASSWORD}"
)
CMD+=("${START_ARG[@]}")

echo "== 大气续造（仅 std/biz/raw） =="
echo "  root: ${ROOT}"
echo "  stage: ${STAGE} days=${DAYS}"
echo "  host: ${DMUSER}@${DMHOST}:${DMPORT} schema=${DMSCHEMA}"
echo "  start: ${START_ARG[*]:-auto(MAX+1s)}"
echo "  log:  ${LOG_FILE}"
echo "  写表: standard_atmosphere_electric_field / biz_atmosphere_electric_field_event / raw_kafka_message"
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
  echo "停续造: pkill -f 'run_load.py append-atmosphere'"
fi
