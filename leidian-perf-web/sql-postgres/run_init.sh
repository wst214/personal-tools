#!/usr/bin/env bash
# PERF Schema 初始化脚本
# 用法：
#   ./run_init.sh
#   PGDATABASE=leidian_perf ./run_init.sh
#   ./run_init.sh --drop-first

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-leidian}"
PGUSER="${PGUSER:-leidian}"

DROP_FIRST=0
if [[ "${1:-}" == "--drop-first" ]]; then
  DROP_FIRST=1
fi

export PGHOST PGPORT PGDATABASE PGUSER

run_sql() {
  echo ">> $1"
  psql -v ON_ERROR_STOP=1 -f "$1"
}

echo "PERF schema init -> ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

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
echo "Verify: psql -c \"SELECT schemaname, tablename FROM pg_tables WHERE schemaname='perf' ORDER BY 1,2;\""
