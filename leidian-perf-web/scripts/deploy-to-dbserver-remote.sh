#!/usr/bin/env bash
set -eu
REMOTE_DIR="${1:-$HOME/leidian-perf-web}"
REMOTE_ARCHIVE="${2:-/tmp/leidian-perf-web-sync.tar.gz}"
if [ ! -f "$REMOTE_ARCHIVE" ]; then
  echo "ERROR: archive not found: $REMOTE_ARCHIVE" >&2
  exit 1
fi
mkdir -p "$REMOTE_DIR"
cd "$REMOTE_DIR"
echo "Extracting $REMOTE_ARCHIVE -> $REMOTE_DIR"
tar -xzf "$REMOTE_ARCHIVE"
if [ ! -f python/generators/atmosphere.py ]; then
  echo "ERROR: extract failed, atmosphere.py missing" >&2
  exit 1
fi
find . -name '*.sh' -type f | while read -r f; do sed -i 's/\r$//' "$f"; done
chmod +x web/start.sh scripts/*.sh python/run_load.sh sql-dameng/run_init.sh 2>/dev/null || true
rm -f "$REMOTE_ARCHIVE"
grep -q iter_atmosphere_with_dense python/generators/atmosphere.py && echo 'OK: dense 1Hz loader present'
grep -q PERF-05-1MIN python/config/sql-bench.yaml && echo 'OK: PERF-05-1MIN present'
grep -q atmosphere_dense_minutes python/config/volume-profiles.yaml && echo 'OK: dense config present'
echo Deploy extract complete.
