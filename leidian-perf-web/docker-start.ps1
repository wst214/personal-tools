$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$withPostgres = $args | Where-Object { $_ -eq "--with-postgres" }
$withDameng = $args | Where-Object { $_ -eq "--dameng" }
$profile = $args | Where-Object { $_ -eq "--infra" }
$rest = $args | Where-Object { $_ -notin @("--infra", "--with-postgres", "--dameng") }

if ($withDameng) {
    $disql = Join-Path $Root "dm-client\bin\disql"
    if (-not (Test-Path $disql)) {
        Write-Host ""
        Write-Host "[ERROR] dm-client not ready: missing dm-client\bin\disql" -ForegroundColor Red
        Write-Host "        Run first:  pack-dm-client.bat" -ForegroundColor Yellow
        Write-Host "        Or:         powershell -File .\scripts\pack-dm-client.ps1" -ForegroundColor Yellow
        Write-Host ""
        exit 1
    }
    $dmHost = if ($env:DMHOST) { $env:DMHOST } else { "192.168.1.41" }
    $dmPort = if ($env:DMPORT) { $env:DMPORT } else { "5236" }
    Write-Host "Mode: dameng (Linux disql in image), DMHOST=${dmHost}:${dmPort}"
    docker compose -f docker-compose.yml -f docker-compose.dameng.yml up -d --build @rest
} elseif ($withPostgres) {
    $env:PGHOST = "perf-postgres"
    $pgMapPort = if ($env:PERF_PG_PORT) { $env:PERF_PG_PORT } else { "5433" }
    Write-Host "模式: 内置 PostGIS perf-postgres:5432, 宿主机端口 $pgMapPort"
    docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build @rest
} elseif ($profile) {
    $env:PGHOST = if ($env:PGHOST) { $env:PGHOST } else { "postgres" }
    $env:LEIDIAN_DOCKER_NETWORK = if ($env:LEIDIAN_DOCKER_NETWORK) { $env:LEIDIAN_DOCKER_NETWORK } else { "local_leidian-net" }
    Write-Host "模式: 接入 Docker 网络 $($env:LEIDIAN_DOCKER_NETWORK)，PGHOST=$($env:PGHOST)"
    docker compose -f docker-compose.yml -f docker-compose.infra.yml up -d --build @rest
} else {
    $env:PGHOST = if ($env:PGHOST) { $env:PGHOST } else { "host.docker.internal" }
    Write-Host "模式: 连宿主机 PostgreSQL，PGHOST=$($env:PGHOST)"
    Write-Host "提示: 若宿主机库无 PostGIS，请改用 .\docker-start.ps1 --with-postgres"
    docker compose up -d --build @rest
}

$port = if ($env:PERF_WEB_PORT) { $env:PERF_WEB_PORT } else { "8100" }
Write-Host "Console: http://127.0.0.1:$port"
if ($withPostgres) {
    $pgPort = if ($env:PERF_PG_PORT) { $env:PERF_PG_PORT } else { "5433" }
    Write-Host "数据库: localhost:$pgPort / leidian_perf / leidian / leidian"
}
