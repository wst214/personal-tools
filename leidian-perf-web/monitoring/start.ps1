$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

docker compose up -d @args

$prom = if ($env:PROMETHEUS_PORT) { $env:PROMETHEUS_PORT } else { "9090" }
$graf = if ($env:GRAFANA_PORT) { $env:GRAFANA_PORT } else { "3000" }

Write-Host ""
Write-Host "Prometheus: http://127.0.0.1:$prom" -ForegroundColor Green
Write-Host "Grafana:    http://127.0.0.1:$graf  (admin / admin)" -ForegroundColor Green
Write-Host ""
Write-Host "验证抓取: http://127.0.0.1:$prom/targets  应显示 dbserver-node UP" -ForegroundColor Cyan
Write-Host "镜像慢: 编辑 .env 换 PROMETHEUS_IMAGE / GRAFANA_IMAGE（见 .env.example）" -ForegroundColor DarkGray
