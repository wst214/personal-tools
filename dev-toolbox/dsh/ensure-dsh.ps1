# Idempotent DeepSeek Harness (dsh) launcher (port 3080).
# Keep this file ASCII-only so Windows PowerShell 5.x parses it under system ANSI.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
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

function Resolve-InstallDir {
  if ($env:DSH_INSTALL_DIR -and (Test-Path $env:DSH_INSTALL_DIR)) {
    return (Resolve-Path $env:DSH_INSTALL_DIR).Path
  }
  $default = 'D:\deepseek-ai'
  if (Test-Path $default) { return $default }
  return $default
}

function Find-DshCmd([string]$InstallDir) {
  $cmd = Join-Path $InstallDir 'node_modules\.bin\dsh.cmd'
  if (Test-Path $cmd) { return $cmd }
  $start = Join-Path $InstallDir 'start-web.cmd'
  if (Test-Path $start) { return $start }
  return $null
}

function Write-Result([bool]$Ok, [bool]$Started, [string]$Code, [string]$Detail) {
  $payload = [ordered]@{
    ok = $Ok
    started = $Started
    code = $Code
    message = $Detail
  }
  $payload | ConvertTo-Json -Compress
}

try {
  if (Test-LocalPort 3080) {
    Write-Result $true $false 'already_running' 'port 3080 already open'
    exit 0
  }

  $install = Resolve-InstallDir
  if (-not (Test-Path $install)) {
    Write-Result $false $false 'not_installed' "install dir missing: $install (set DSH_INSTALL_DIR or npm install @deepseek-ai/dsh there)"
    exit 1
  }

  $exe = Find-DshCmd $install
  if (-not $exe) {
    Write-Result $false $false 'not_installed' "dsh not found under $install (run: npm install @deepseek-ai/dsh)"
    exit 1
  }

  $out = Join-Path $LogDir 'dsh.out.log'
  $err = Join-Path $LogDir 'dsh.err.log'
  $args = @()
  if ($exe -like '*\dsh.cmd') { $args = @('web') }

  Start-Process -FilePath $exe `
    -ArgumentList $args `
    -WorkingDirectory $install `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -PassThru | Out-Null

  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort 3080) {
      Write-Result $true $true 'ready' "dsh web listening on 127.0.0.1:3080 (cwd=$install)"
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }

  $tail = ''
  if (Test-Path $err) {
    $tail = (Get-Content $err -Tail 20 -ErrorAction SilentlyContinue | Out-String).Trim()
  }
  if (-not $tail -and (Test-Path $out)) {
    $tail = (Get-Content $out -Tail 20 -ErrorAction SilentlyContinue | Out-String).Trim()
  }
  $msg = if ($tail) { $tail } else { 'started but port 3080 not ready within 45s' }
  Write-Result $false $true 'timeout' $msg
  exit 1
} catch {
  Write-Result $false $false 'error' $_.Exception.Message
  exit 1
}
