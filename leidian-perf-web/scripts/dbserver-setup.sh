#!/usr/bin/env bash
# dbserver 监控组件安装：node_exporter + PostgreSQL pg_stat_statements 等
# 适用：Ubuntu 24.04 + PostgreSQL 16（apt 安装）
# 用法（在 dbserver 上）：
#   chmod +x dbserver-setup.sh
#   sudo ./dbserver-setup.sh
set -euo pipefail

NODE_EXPORTER_VERSION="${NODE_EXPORTER_VERSION:-1.9.1}"
NODE_EXPORTER_PORT="${NODE_EXPORTER_PORT:-9100}"
PG_CLUSTER="${PG_CLUSTER:-16/main}"

log() { echo "[dbserver-setup] $*"; }
need_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "请使用 sudo 运行：sudo $0" >&2
    exit 1
  fi
}

install_node_exporter_binary() {
  if command -v node_exporter >/dev/null 2>&1; then
    log "node_exporter 已存在：$(command -v node_exporter)"
    return
  fi
  local arch tar_name url
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64) arch="arm64" ;;
    *) echo "不支持的架构: $arch" >&2; exit 1 ;;
  esac
  tar_name="node_exporter-${NODE_EXPORTER_VERSION}.linux-${arch}"
  url="https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VERSION}/${tar_name}.tar.gz"
  log "下载 node_exporter v${NODE_EXPORTER_VERSION} (${arch})"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$url" -o "$tmp/node_exporter.tar.gz"
  tar -xzf "$tmp/node_exporter.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/${tar_name}/node_exporter" /usr/local/bin/node_exporter

  cat >/etc/systemd/system/node_exporter.service <<EOF
[Unit]
Description=Prometheus Node Exporter
After=network-online.target
Wants=network-online.target

[Service]
User=nobody
Group=nogroup
Type=simple
ExecStart=/usr/local/bin/node_exporter --web.listen-address=:${NODE_EXPORTER_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now node_exporter
  log "node_exporter 已启动，端口 ${NODE_EXPORTER_PORT}"
}

configure_postgresql_monitoring() {
  local conf_dir="/etc/postgresql/${PG_CLUSTER}/conf.d"
  local snippet="${conf_dir}/perf-monitoring.conf"
  if [[ ! -d "/etc/postgresql/${PG_CLUSTER}" ]]; then
    echo "未找到 PostgreSQL 配置目录 /etc/postgresql/${PG_CLUSTER}" >&2
    echo "可设置环境变量 PG_CLUSTER，例如：PG_CLUSTER=16/main sudo $0" >&2
    exit 1
  fi
  mkdir -p "$conf_dir"
  cat >"$snippet" <<'EOF'
# PERF 压测监控（../tools/leidian-perf-web）
shared_preload_libraries = 'pg_stat_statements,auto_explain'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
track_io_timing = on
log_min_duration_statement = 500ms
auto_explain.log_min_duration = 500ms
auto_explain.log_analyze = on
auto_explain.log_buffers = on
EOF
  log "已写入 ${snippet}"
  systemctl restart "postgresql@${PG_CLUSTER}"
  log "PostgreSQL 已重启 (postgresql@${PG_CLUSTER})"
}

enable_pg_stat_statements() {
  local db="${PGDATABASE:-leidian_perf}"
  local app_user="${PGUSER:-leidian}"
  log "在数据库 ${db} 创建 pg_stat_statements 扩展"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$db" -c \
    "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
  log "授权 ${app_user} 可 reset pg_stat_statements（压测按场景统计慢 SQL）"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$db" -c \
    "GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid, oid, bigint) TO ${app_user};"
}

verify_all() {
  local db="${PGDATABASE:-leidian_perf}"
  log "验证 node_exporter"
  curl -fsS "http://127.0.0.1:${NODE_EXPORTER_PORT}/metrics" | head -n 3
  log "验证 pg_stat_statements"
  sudo -u postgres psql -d "$db" -Atc \
    "SELECT extname FROM pg_extension WHERE extname='pg_stat_statements';"
  sudo -u postgres psql -d "$db" -Atc \
    "SELECT name, setting FROM pg_settings WHERE name IN ('shared_preload_libraries','track_io_timing') ORDER BY 1;"
  log "完成。请在本机访问：http://$(hostname -I | awk '{print $1}'):${NODE_EXPORTER_PORT}/metrics"
}

main() {
  need_root
  install_node_exporter_binary
  configure_postgresql_monitoring
  enable_pg_stat_statements
  verify_all
}

main "$@"
