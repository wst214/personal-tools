#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--dameng" ]]; then
  shift
  if [[ ! -x "${ROOT}/dm-client/bin/disql" ]]; then
    echo "dm-client 未就绪。请先运行: ./scripts/pack-dm-client.sh" >&2
    exit 1
  fi
  echo "模式: 达梦（Linux disql 已打入镜像），DMHOST=${DMHOST:-192.168.1.41}"
  docker compose -f docker-compose.yml -f docker-compose.dameng.yml up -d --build "$@"
elif [[ "${1:-}" == "--infra" ]]; then
  shift
  export PGHOST="${PGHOST:-postgres}"
  export LEIDIAN_DOCKER_NETWORK="${LEIDIAN_DOCKER_NETWORK:-local_leidian-net}"
  echo "模式: 接入 Docker 网络 ${LEIDIAN_DOCKER_NETWORK}，PGHOST=${PGHOST}"
  docker compose -f docker-compose.yml -f docker-compose.infra.yml up -d --build "$@"
else
  export PGHOST="${PGHOST:-host.docker.internal}"
  echo "模式: 连宿主机 PostgreSQL，PGHOST=${PGHOST}"
  docker compose up -d --build "$@"
fi

echo "操作台: http://127.0.0.1:${PERF_WEB_PORT:-8100}"
