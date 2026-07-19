# PERF Schema 初始化脚本（达梦 DM8 / disql，Windows）
# 用法：
#   .\run_init.ps1
#   .\run_init.ps1 -DmHost 192.168.1.41 -DmPort 5236 -DmService LEIDIAN_PERF -User LEIDIAN_APP
#   .\run_init.ps1 -DropFirst

param(
    [string]$DmHost = $(if ($env:DMHOST) { $env:DMHOST } else { "localhost" }),
    [string]$DmPort = $(if ($env:DMPORT) { $env:DMPORT } else { "5236" }),
    [string]$DmService = $(if ($env:DMSERVICE) { $env:DMSERVICE } else { "LEIDIAN_PERF" }),
    [string]$User = $(if ($env:DMUSER) { $env:DMUSER } else { "LEIDIAN_APP" }),
    [string]$Password = $(if ($env:DMPASSWORD) { $env:DMPASSWORD } else { "Leidian@2026!" }),
    [switch]$DropFirst
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$disql = Get-Command disql -ErrorAction SilentlyContinue
if (-not $disql) {
    Write-Error "disql not found in PATH. Add DM8 bin directory to PATH."
}

$conn = $User
if ($Password) {
    $conn = "${User}/${Password}"
}
$conn = "${conn}@${DmHost}:${DmPort}"

function Invoke-SqlFile {
    param([string]$FilePath)
    Write-Host ">> $FilePath"
    & disql -S $conn "`$FilePath"
    if ($LASTEXITCODE -ne 0) {
        throw "disql failed: $FilePath (exit $LASTEXITCODE)"
    }
}

Write-Host "PERF schema init (DM8) -> ${conn} service=${DmService}"

if ($DropFirst) {
    Invoke-SqlFile (Join-Path $ScriptDir "90_drop_schema.sql")
}

$files = @(
    "00_init_schema.sql",
    "01_planning_tables.sql",
    "02_device_tables.sql",
    "03_partitioned_tables.sql",
    "04_functions_triggers.sql",
    "05_default_partitions.sql"
)

foreach ($f in $files) {
    Invoke-SqlFile (Join-Path $ScriptDir $f)
}

Write-Host "PERF schema init completed."
Write-Host "Verify: disql ${conn} -e `"SELECT TABLE_NAME FROM DBA_TABLES WHERE OWNER='PERF' ORDER BY 1;`""
