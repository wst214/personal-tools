# Idempotent TestHub launcher: MySQL + Django :8000 + Vite :3001 (no console windows).
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Join-Path $Root 'venv\Scripts\python.exe'
$Frontend = Join-Path $Root 'frontend'
$LogDir = Join-Path $Root '.run'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Test-LocalPort([int]$Port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if (-not $ok) { $client.Close(); return $false }
    $connected = $client.Connected
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

function Ensure-Mysql {
  docker start mytools-testhub-mysql 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    docker run -d --name mytools-testhub-mysql `
      -e MYSQL_ROOT_PASSWORD=root123 `
      -e MYSQL_DATABASE=testhub `
      -e MYSQL_USER=testhub `
      -e MYSQL_PASSWORD=testhub123 `
      -p 3307:3306 mysql:8.0 `
      --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci 2>$null | Out-Null
  }
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-LocalPort 3307) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Ensure-Backend {
  if (Test-LocalPort 8000) { return 'already' }
  if (-not (Test-Path $Python)) { throw "venv python missing: $Python" }
  $out = Join-Path $LogDir 'backend.out.log'
  $err = Join-Path $LogDir 'backend.err.log'
  Start-Process -FilePath $Python `
    -ArgumentList @('manage.py', 'runserver', '0.0.0.0:8000') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err | Out-Null
  return 'started'
}

function Ensure-Frontend {
  if (Test-LocalPort 3001) { return 'already' }
  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $npm = if ($npmCmd) { $npmCmd.Source } else { 'npm.cmd' }
  $out = Join-Path $LogDir 'frontend.out.log'
  $err = Join-Path $LogDir 'frontend.err.log'
  Start-Process -FilePath $npm `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $Frontend `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err | Out-Null
  return 'started'
}

$result = [ordered]@{
  ok = $false
  mysql = 'unknown'
  backend = 'unknown'
  frontend = 'unknown'
  message = ''
}

try {
  # 已在跑：直接成功（不碰 Docker）
  if ((Test-LocalPort 8000) -and (Test-LocalPort 3001)) {
    $result.ok = $true
    $result.mysql = 'skipped'
    $result.backend = 'already'
    $result.frontend = 'already'
    $result.message = 'ready'
    $result | ConvertTo-Json -Compress
    exit 0
  }

  $mysqlOk = Ensure-Mysql
  $result.mysql = if ($mysqlOk) { 'ok' } else { 'failed' }
  if (-not $mysqlOk) {
    Write-Warning 'MySQL not ready; still trying backend/frontend (may already be up)'
  }

  $result.backend = Ensure-Backend
  $result.frontend = Ensure-Frontend

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $be = Test-LocalPort 8000
    $fe = Test-LocalPort 3001
    if ($be -and $fe) {
      $result.ok = $true
      $result.message = 'ready'
      $result | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Seconds 1
  }

  $result.message = "timeout backend=$(Test-LocalPort 8000) frontend=$(Test-LocalPort 3001); see $LogDir"
  $result | ConvertTo-Json -Compress
  exit 1
} catch {
  $result.message = $_.Exception.Message
  $result | ConvertTo-Json -Compress
  exit 1
}
