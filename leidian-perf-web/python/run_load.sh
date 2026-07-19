#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

STAGE="${1:-}"
if [[ -z "$STAGE" ]]; then
  echo "Usage: $0 <S0|S1|S2|S3|S4> [--truncate] [--t0 ISO8601]"
  exit 1
fi
shift || true

TRUNCATE=0
T0=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --truncate) TRUNCATE=1; shift ;;
    --t0) T0="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

ARGS=(run_load.py load --stage "$STAGE")
[[ "$TRUNCATE" -eq 1 ]] && ARGS+=(--truncate)
[[ -n "$T0" ]] && ARGS+=(--t0 "$T0")

.venv/bin/python "${ARGS[@]}"
echo "Done. Validate: python run_load.py validate --stage $STAGE"
