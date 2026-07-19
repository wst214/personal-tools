#!/usr/bin/env bash
# Pack bin/ + drivers/ only from dbserver (skip data/log)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${ROOT}/dm-client"
DBSERVER="${DBSERVER:-192.168.1.41}"
SSH_USER="${SSH_USER:-leidian}"
REMOTE_DM_HOME="${REMOTE_DM_HOME:-/opt/dmdbms}"
REMOTE_ARCHIVE="/tmp/leidian-dmdbms-client.tgz"

remote="${SSH_USER}@${DBSERVER}"
echo "Fetch ${remote}:${REMOTE_DM_HOME} (bin drivers only) -> ${TARGET}"

ssh "$remote" "rm -f ${REMOTE_ARCHIVE}; tar czf ${REMOTE_ARCHIVE} -C ${REMOTE_DM_HOME} bin drivers include && ls -lh ${REMOTE_ARCHIVE}"

TMP="$(mktemp -d)"
LOCAL="${TMP}/client.tgz"
trap 'rm -rf "${TMP}"; ssh "$remote" "rm -f '"${REMOTE_ARCHIVE}"'" 2>/dev/null || true' EXIT

scp "${remote}:${REMOTE_ARCHIVE}" "${LOCAL}"
tar -xzf "${LOCAL}" -C "${TMP}"

if [[ -d "${TMP}/dmdbms/bin" ]]; then SRC="${TMP}/dmdbms"
elif [[ -d "${TMP}/bin" ]]; then SRC="${TMP}"
else echo "ERROR: bin/disql missing" >&2; exit 1; fi

find "${TARGET}" -mindepth 1 -maxdepth 1 ! -name '.gitignore' ! -name '.gitkeep' -exec rm -rf {} +
for item in "${SRC}"/*; do
  name="$(basename "${item}")"
  rm -rf "${TARGET}/${name}"
  mv "${item}" "${TARGET}/"
done

echo "OK: dm-client ready"
