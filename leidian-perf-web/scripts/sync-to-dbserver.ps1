# Sync leidian-perf-web code + data/stage-records*.json to dbserver
# Usage:
#   .\scripts\sync-to-dbserver.ps1
#   .\scripts\sync-to-dbserver.ps1 -DbServer 192.168.1.41 -RemoteUser leidian

param(
    [string]$DbServer = "192.168.1.41",
    [string]$RemoteUser = "leidian",
    [string]$RemoteDir = "~/leidian-perf-web",
    [switch]$SkipPack
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Archive = Join-Path $env:TEMP "leidian-perf-web-sync-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
$RemoteArchive = "/tmp/leidian-perf-web-sync.tar.gz"
$remote = "${RemoteUser}@${DbServer}"

Push-Location $Root
try {
    if (-not $SkipPack) {
        Write-Host ">> [1/4] Packing (exclude .venv, __pycache__, dm-client, .git)..." -ForegroundColor Cyan
        if (Test-Path $Archive) { Remove-Item $Archive -Force }
        $items = @(
            "python", "web", "sql-dameng", "sql-postgres", "scripts", "data",
            "monitoring", "postgres-init",
            "docker-compose.yml", "docker-compose.dameng.yml", "docker-compose.postgres.yml",
            "docker-start.sh", "docker-start.ps1", ".gitattributes"
        )
        $existing = $items | Where-Object { Test-Path $_ }
        & tar -czf $Archive `
            --exclude="python/.venv" `
            --exclude="**/__pycache__" `
            --exclude="**/*.pyc" `
            --exclude="dm-client" `
            --exclude=".git" `
            @existing
        $mb = [math]::Round((Get-Item $Archive).Length / 1MB, 2)
        Write-Host "    Archive: $Archive ($mb MB)" -ForegroundColor Green
    }
    else {
        $candidates = Get-ChildItem (Join-Path $env:TEMP "leidian-perf-web-sync-*.tar.gz") | Sort-Object LastWriteTime -Descending
        if (-not $candidates) { throw "No archive found; omit -SkipPack" }
        $Archive = $candidates[0].FullName
        Write-Host ">> Using existing archive: $Archive" -ForegroundColor Cyan
    }

    Write-Host ">> [2/4] Upload to $remote ..." -ForegroundColor Cyan
    & scp -o StrictHostKeyChecking=accept-new $Archive "${remote}:${RemoteArchive}"

    Write-Host ">> [3/4] Extract on dbserver ..." -ForegroundColor Cyan
    $remoteCmd = "set -e; mkdir -p $RemoteDir; cd $RemoteDir; tar -xzf $RemoteArchive; find . -name '*.sh' -exec sed -i 's/\r$//' {} \;; chmod +x web/start.sh scripts/*.sh python/run_load.sh sql-dameng/run_init.sh 2>/dev/null || true; rm -f $RemoteArchive; ls -la data/*.json 2>/dev/null || true; md5sum python/generators/dameng_loader.py 2>/dev/null || true"
    & ssh -o StrictHostKeyChecking=accept-new $remote $remoteCmd

    Write-Host ">> [4/4] Done. Start perf-web on dbserver:" -ForegroundColor Green
    Write-Host '    cd ~/leidian-perf-web/web; export PERF_WEB_HOST=0.0.0.0; ./start.sh' -ForegroundColor Yellow
}
finally {
    Pop-Location
}
