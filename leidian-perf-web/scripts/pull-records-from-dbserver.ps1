# 从 dbserver 拉取达梦压测记录到本机（未配置 PERF_WEB_PUSH_URL 时的备用方案）
param(
    [string]$DbServer = "192.168.1.41",
    [string]$RemoteUser = "leidian",
    [string]$LocalDataDir = (Join-Path $PSScriptRoot "..\data")
)

$ErrorActionPreference = "Stop"
$remote = "${RemoteUser}@${DbServer}:~/leidian-perf-web/data/stage-records.dameng.json"
$local = Join-Path (Resolve-Path $LocalDataDir) "stage-records.dameng.json"

Write-Host "Pull $remote -> $local"
scp $remote $local
Write-Host "Done. Refresh perf-web page (http://localhost:8100)."
