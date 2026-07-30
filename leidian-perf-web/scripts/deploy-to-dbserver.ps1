# 备份 dbserver 旧目录并覆盖为最新 leidian-perf-web
# 用法：.\scripts\deploy-to-dbserver.ps1

param(
    [string]$DbServer = "192.168.1.41",
    [string]$RemoteUser = "leidian",
    [string]$RemoteDir = "~/leidian-perf-web",
    [string]$BackupRoot = "~/leidian-perf-web-backups"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Archive = Join-Path $env:TEMP "leidian-perf-web-sync-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
$RemoteArchive = "/tmp/leidian-perf-web-sync.tar.gz"
$RemoteScript = "/tmp/deploy-to-dbserver-remote.sh"
$remote = "${RemoteUser}@${DbServer}"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$localRemoteScript = Join-Path $PSScriptRoot "deploy-to-dbserver-remote.sh"

function Write-LfFile([string]$SourcePath, [string]$DestPath) {
    $text = [System.IO.File]::ReadAllText($SourcePath)
    $text = $text -replace "`r`n", "`n" -replace "`r", "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($DestPath, $text, $utf8NoBom)
}

function Invoke-Ssh([string]$Command) {
    & ssh -o StrictHostKeyChecking=accept-new $remote $Command
    if ($LASTEXITCODE -ne 0) {
        throw "Remote command failed (exit $LASTEXITCODE): $Command"
    }
}

Push-Location $Root
try {
    Write-Host ">> [1/6] Packing latest code..." -ForegroundColor Cyan
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
    if ($LASTEXITCODE -ne 0) { throw "tar pack failed" }
    $mb = [math]::Round((Get-Item $Archive).Length / 1MB, 2)
    Write-Host "    Archive: $Archive ($mb MB)" -ForegroundColor Green

    $lfScript = Join-Path $env:TEMP "deploy-to-dbserver-remote-$stamp.sh"
    Write-LfFile $localRemoteScript $lfScript

    Write-Host ">> [2/6] Upload archive + remote script (LF) ..." -ForegroundColor Cyan
    & scp -o StrictHostKeyChecking=accept-new $Archive "${remote}:${RemoteArchive}"
    if ($LASTEXITCODE -ne 0) { throw "scp archive failed" }
    & scp -o StrictHostKeyChecking=accept-new $lfScript "${remote}:${RemoteScript}"
    if ($LASTEXITCODE -ne 0) { throw "scp remote script failed" }

    Write-Host ">> [3/6] Backup old dir on dbserver ..." -ForegroundColor Cyan
    Invoke-Ssh "mkdir -p $BackupRoot && if [ -d $RemoteDir ]; then mv $RemoteDir $BackupRoot/leidian-perf-web-$stamp && echo backed_up=$BackupRoot/leidian-perf-web-$stamp; else echo no_old_dir; fi && mkdir -p $RemoteDir"

    Write-Host ">> [4/6] Extract fresh code ..." -ForegroundColor Cyan
    Invoke-Ssh "chmod +x $RemoteScript && bash $RemoteScript $RemoteDir $RemoteArchive"

    Write-Host ">> [5/6] Verify on dbserver ..." -ForegroundColor Cyan
    Invoke-Ssh "test -f $RemoteDir/python/generators/atmosphere.py && test -f $RemoteDir/python/config/sql-bench.yaml && echo verify_ok"

    Write-Host ">> [6/6] Done." -ForegroundColor Green
    Write-Host "    Live:  $RemoteDir on $DbServer" -ForegroundColor Yellow
    Write-Host "    Backup: $BackupRoot/leidian-perf-web-$stamp (if existed)" -ForegroundColor Yellow
}
finally {
    Pop-Location
}
