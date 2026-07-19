# 从 Windows SSH 到 dbserver 停止造数
param(
    [string]$DbServer = "192.168.1.41",
    [string]$RemoteUser = "leidian",
    [string]$DmPassword = ""
)

$ErrorActionPreference = "Stop"
$remote = "${RemoteUser}@${DbServer}"
$scriptPath = Join-Path $PSScriptRoot "stop-dbserver-load.sh"

if (-not (Test-Path $scriptPath)) { throw "Missing $scriptPath" }

Write-Host ">> Upload stop script..." -ForegroundColor Cyan
& scp -o StrictHostKeyChecking=accept-new $scriptPath "${remote}:~/stop-dbserver-load.sh"

$envExport = ""
if ($DmPassword) {
    $envExport = "export DMPASSWORD='$($DmPassword -replace "'", "'\''")'; "
}

Write-Host ">> Run stop on dbserver (enter SSH password if prompted)..." -ForegroundColor Cyan
& ssh -o StrictHostKeyChecking=accept-new $remote "${envExport}chmod +x ~/stop-dbserver-load.sh; sed -i 's/\r$//' ~/stop-dbserver-load.sh; bash ~/stop-dbserver-load.sh"

Write-Host ">> Done." -ForegroundColor Green
