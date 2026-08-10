# Idempotent New API launcher via mytools docker compose (port 5780).
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$MytoolsRoot = Split-Path -Parent $Root
$ComposeFile = Join-Path $MytoolsRoot 'docker-compose.yml'
$LogDir = Join-Path $Root '.run'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null

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

$result = [ordered]@{
  ok = $false
  started = $false
  message = ''
}

try {
  if (Test-LocalPort 5780) {
    $result.ok = $true
    $result.started = $false
    $result.message = 'already running'
    $result | ConvertTo-Json -Compress
    exit 0
  }

  if (-not (Test-Path $ComposeFile)) {
    throw "找不到 docker-compose.yml：$ComposeFile"
  }

  $out = Join-Path $LogDir 'compose.out.log'
  $err = Join-Path $LogDir 'compose.err.log'
  $proc = Start-Process -FilePath 'docker' `
    -ArgumentList @('compose', '-f', $ComposeFile, 'up', '-d', 'mytools-new-api', 'mytools-new-api-gateway') `
    -WorkingDirectory $MytoolsRoot `
    -WindowStyle Hidden `
    -Wait `
    -PassThru `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err
  $result.started = $true

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort 5780) {
      $result.ok = $true
      $result.message = 'ready'
      $result | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Seconds 1
  }

  $tail = ''
  if (Test-Path $err) { $tail = (Get-Content $err -Raw -ErrorAction SilentlyContinue) }
  if (-not $tail -and (Test-Path $out)) { $tail = (Get-Content $out -Raw -ErrorAction SilentlyContinue) }
  $result.message = "timeout port=5780 exit=$($proc.ExitCode); $tail"
  $result | ConvertTo-Json -Compress
  exit 1
} catch {
  $result.message = $_.Exception.Message
  $result | ConvertTo-Json -Compress
  exit 1
}
