# PERF Schema 初始化脚本（Windows）
# 用法：
#   .\run_init.ps1
#   .\run_init.ps1 -Host localhost -Port 5432 -Database leidian_perf -User leidian
#   .\run_init.ps1 -DropFirst

param(
    [string]$PgHost = $(if ($env:PGHOST) { $env:PGHOST } else { "localhost" }),
    [string]$PgPort = $(if ($env:PGPORT) { $env:PGPORT } else { "5432" }),
    [string]$Database = $(if ($env:PGDATABASE) { $env:PGDATABASE } else { "leidian" }),
    [string]$User = $(if ($env:PGUSER) { $env:PGUSER } else { "leidian" }),
    [switch]$DropFirst
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$psql = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psql) {
    Write-Error "psql not found in PATH. Install PostgreSQL client or add psql to PATH."
}

$env:PGHOST = $PgHost
$env:PGPORT = $PgPort
$env:PGDATABASE = $Database
$env:PGUSER = $User

function Invoke-SqlFile {
    param([string]$FilePath)
    Write-Host ">> $FilePath"
    & psql -v ON_ERROR_STOP=1 -f $FilePath
    if ($LASTEXITCODE -ne 0) {
        throw "psql failed: $FilePath (exit $LASTEXITCODE)"
    }
}

Write-Host "PERF schema init -> ${User}@${PgHost}:${PgPort}/${Database}"

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
Write-Host "Verify: psql -c `"SELECT schemaname, tablename FROM pg_tables WHERE schemaname='perf' ORDER BY 1,2;`""
