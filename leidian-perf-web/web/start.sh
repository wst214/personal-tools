#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_DIR="$(cd "$ROOT/../python" && pwd)"
cd "$ROOT"

if [[ ! -d "$PYTHON_DIR/.venv" ]]; then
  echo "首次运行：安装 python 依赖..."
  (cd "$PYTHON_DIR" && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt)
fi

PY="$PYTHON_DIR/.venv/bin/python"
[[ -x "$PY" ]] || PY=python3

echo "启动 PERF 压测操作台 http://127.0.0.1:8100"
exec "$PY" server.py
