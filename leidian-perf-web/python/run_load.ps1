param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8")]
    [string]$Stage,
    [string]$PgHost = $(if ($env:PGHOST) { $env:PGHOST } else { "localhost" }),
    [string]$PgPort = $(if ($env:PGPORT) { $env:PGPORT } else { "5432" }),
    [string]$Database = $(if ($env:PGDATABASE) { $env:PGDATABASE } else { "leidian_perf" }),
    [string]$User = $(if ($env:PGUSER) { $env:PGUSER } else { "leidian" }),
    [switch]$Truncate,
    [string]$T0,
    [int]$Seed = 42
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Test-Path ".venv")) {
    Write-Host "Creating venv and installing requirements..."
    python -m venv .venv
    & .\.venv\Scripts\pip.exe install -q -r requirements.txt
}

$args = @("run_load.py", "load", "--stage", $Stage, "--database", $Database, "--host", $PgHost, "--port", $PgPort, "--user", $User, "--seed", $Seed)
if ($Truncate) { $args += "--truncate" }
if ($T0) { $args += @("--t0", $T0) }

$env:PGHOST = $PgHost
$env:PGPORT = $PgPort
$env:PGDATABASE = $Database
$env:PGUSER = $User

Write-Host "Running: python $($args -join ' ')"
& .\.venv\Scripts\python.exe @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done. Validate: python run_load.py validate --stage $Stage"
