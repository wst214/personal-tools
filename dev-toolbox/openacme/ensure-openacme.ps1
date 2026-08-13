# Idempotent OpenAcme launcher (port 3456).
# Keep this file ASCII-only so Windows PowerShell 5.x parses it under system ANSI.
# Official runtime: macOS / Linux. On Windows prefer WSL if CLI is not on PATH.
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

function Find-OpenAcmeCmd {
  $cmd = Get-Command openacme -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Start-OpenAcmeNative([string]$Exe) {
  $out = Join-Path $LogDir 'openacme.out.log'
  $err = Join-Path $LogDir 'openacme.err.log'
  Start-Process -FilePath $Exe `
    -ArgumentList @('start') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -PassThru | Out-Null
}

function Test-WslOpenAcme {
  $wsl = Get-Command wsl -ErrorAction SilentlyContinue
  if (-not $wsl) { return $false }
  try {
    # Login shell so ~/.local/bin (openacme symlink) is on PATH.
    $check = & wsl -e bash -lc 'command -v openacme >/dev/null 2>&1 && echo OK' 2>$null
    return (($check | Out-String).Trim() -eq 'OK')
  } catch {
    return $false
  }
}

function Apply-ToolboxSkin {
  $script = Join-Path $Root 'apply-toolbox-skin.sh'
  if (-not (Test-Path $script)) { return }
  try {
    & wsl -e bash '/mnt/d/mytools/dev-toolbox/openacme/apply-toolbox-skin.sh' 2>$null | Out-Null
  } catch {}
}

function Start-OpenAcmeWsl {
  Apply-ToolboxSkin
  Start-Process -FilePath 'wsl' `
    -ArgumentList @(
      '-e', 'bash', '-lc',
      'export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"; openacme start --no-browser --no-service >/tmp/openacme-devtoolbox.log 2>&1 || openacme start --no-browser >/tmp/openacme-devtoolbox.log 2>&1'
    ) `
    -WindowStyle Hidden `
    -PassThru | Out-Null
  return $true
}

function Write-Result([bool]$Ok, [bool]$Started, [string]$Code, [string]$Mode, [string]$Detail) {
  $payload = [ordered]@{
    ok = $Ok
    started = $Started
    code = $Code
    mode = $Mode
    message = $Detail
  }
  $payload | ConvertTo-Json -Compress
}

try {
  if (Test-LocalPort 3456) {
    Apply-ToolboxSkin
    Write-Result $true $false 'already_running' 'detect' 'port 3456 already open'
    exit 0
  }

  $native = Find-OpenAcmeCmd
  $mode = ''
  if ($native) {
    Apply-ToolboxSkin
    Start-OpenAcmeNative $native
    $mode = 'native'
  } elseif (Test-WslOpenAcme) {
    Start-OpenAcmeWsl | Out-Null
    $mode = 'wsl'
  } else {
    Write-Result $false $false 'not_installed' '' 'openacme CLI not found on Windows PATH or in WSL'
    exit 1
  }

  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalPort 3456) {
      Write-Result $true $true 'ready' $mode ("ready via $mode")
      exit 0
    }
    Start-Sleep -Seconds 1
  }

  Write-Result $false $true 'timeout' $mode ("started via $mode but port 3456 not ready in 45s")
  exit 1
} catch {
  Write-Result $false $false 'exception' '' $_.Exception.Message
  exit 1
}
