#!/usr/bin/env bash
# PERF Schema 初始化脚本（达梦 DM8 / disql）
# 用法：
#   ./run_init.sh
#   DMHOST=192.168.1.41 DMSERVICE=LEIDIAN_PERF ./run_init.sh
#   ./run_init.sh --drop-first

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DMHOST="${DMHOST:-localhost}"
DMPORT="${DMPORT:-5236}"
DMSERVICE="${DMSERVICE:-LEIDIAN_PERF}"
DMUSER="${DMUSER:-LEIDIAN_APP}"
DMPASSWORD="${DMPASSWORD:-Leidian@2026!}"

DROP_FIRST=0
if [[ "${1:-}" == "--drop-first" ]]; then
  DROP_FIRST=1
fi

if ! command -v disql >/dev/null 2>&1; then
  echo "disql not found in PATH. Add DM8 bin directory to PATH." >&2
  exit 1
fi

CONN="${DMUSER}"
if [[ -n "${DMPASSWORD}" ]]; then
  CONN="${DMUSER}/${DMPASSWORD}"
fi
CONN="${CONN}@${DMHOST}:${DMPORT}"

run_sql() {
  local file="$1"
  echo ">> ${file}"
  disql -S "${CONN}" "\`${file}"
}

echo "PERF schema init (DM8) -> ${CONN} service=${DMSERVICE}"

if [[ "$DROP_FIRST" -eq 1 ]]; then
  run_sql "${SCRIPT_DIR}/90_drop_schema.sql"
fi

for f in \
  00_init_schema.sql \
  01_planning_tables.sql \
  02_device_tables.sql \
  03_partitioned_tables.sql \
  04_functions_triggers.sql \
  05_default_partitions.sql
do
  run_sql "${SCRIPT_DIR}/${f}"
done

echo "PERF schema init completed."
echo "Verify: disql ${CONN} -e \"SELECT TABLE_NAME FROM DBA_TABLES WHERE OWNER='PERF' ORDER BY 1;\""
