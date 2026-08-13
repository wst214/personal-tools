# Idempotent AnythingLLM launcher (host port 3002 -> container 3001).
# Keep this file ASCII-only so Windows PowerShell 5.x parses it under system ANSI.
# Note: TestHub already uses host :3001, so AnythingLLM is mapped to :3002.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3002
$Name = 'mytools-anythingllm'
$MytoolsRoot = Split-Path -Parent (Split-Path -Parent $Root)
$Compose = Join-Path $MytoolsRoot 'docker-compose.yml'
$Service = 'mytools-anythingllm'
$Images = @(
  'mintplexlabs/anythingllm:latest',
  'mintplexlabs/anythingllm:master'
)

function Write-Result([bool]$Ok, [bool]$Started, [string]$Code, [string]$Message) {
  $obj = [ordered]@{
    ok      = $Ok
    started = $Started
    code    = $Code
    message = $Message
  }
  ($obj | ConvertTo-Json -Compress)
}

function Test-LocalPort([int]$P) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $P, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if (-not $ok) { $client.Close(); return $false }
    $connected = $client.Connected
    $client.Close()
    return $connected
  } catch {
    return $false
  }
}

function Find-Docker {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe",
    "${env:ProgramFiles(x86)}\Docker\Docker\resources\bin\docker.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path -LiteralPath $p) { return $p }
  }
  return $null
}

function Invoke-Docker([string]$DockerExe, [string[]]$Args) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $out = & $DockerExe @Args 2>&1
    $code = $LASTEXITCODE
    $text = ($out | ForEach-Object { "$_" }) -join "`n"
    return @{ Code = $code; Text = $text.Trim() }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Apply-Skin {
  $skinScript = Join-Path $Root 'apply-toolbox-skin.ps1'
  if (Test-Path -LiteralPath $skinScript) {
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $skinScript | Out-Null
    } catch {}
  }
}

if (Test-LocalPort $Port) {
  Apply-Skin
  Write-Result $true $false 'already_running' "port $Port already open"
  exit 0
}

$docker = Find-Docker
if (-not $docker) {
  Write-Result $false $false 'no_docker' 'Docker not found. Install Docker Desktop and retry.'
  exit 1
}

if (-not (Test-Path -LiteralPath $Compose)) {
  Write-Result $false $false 'no_compose' "missing docker-compose.yml at $Compose"
  exit 1
}

$storage = Join-Path $Root 'storage'
New-Item -ItemType Directory -Force -Path $storage | Out-Null
$envFile = Join-Path $Root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  @(
    'STORAGE_DIR=/app/server/storage'
    'JWT_SECRET=mytools-anythingllm-local-dev-secret-change-me'
    'DISABLE_TELEMETRY=true'
  ) | Set-Content -LiteralPath $envFile -Encoding Ascii
}

$logs = New-Object System.Collections.Generic.List[string]
$started = $false

$r = Invoke-Docker $docker @('compose', '-f', $Compose, 'up', '-d', $Service)
$logs.Add("compose: exit=$($r.Code)`n$($r.Text)") | Out-Null
if ($r.Code -eq 0) { $started = $true }

if (-not $started) {
  foreach ($img in $Images) {
    Invoke-Docker $docker @('rm', '-f', $Name) | Out-Null
    $vol = $storage + ':/app/server/storage'
    $envVol = $envFile + ':/app/server/.env'
    $r2 = Invoke-Docker $docker @(
      'run', '-d', '--name', $Name, '--restart', 'unless-stopped',
      '--cap-add', 'SYS_ADMIN',
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', "${Port}:3001",
      '-e', 'STORAGE_DIR=/app/server/storage',
      '-e', 'JWT_SECRET=mytools-anythingllm-local-dev-secret-change-me',
      '-e', 'DISABLE_TELEMETRY=true',
      '-v', $vol,
      '-v', $envVol,
      $img
    )
    $logs.Add("run ${img}: exit=$($r2.Code)`n$($r2.Text)") | Out-Null
    if ($r2.Code -eq 0) { $started = $true; break }
  }
}

if (-not $started) {
  $hint = 'Cannot pull/start AnythingLLM image. Check Docker Desktop network / mirror, then retry.'
  Write-Result $false $false 'start_failed' ($hint + "`n" + ($logs -join "`n---`n"))
  exit 1
}

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if (Test-LocalPort $Port) {
    Apply-Skin
    Write-Result $true $true 'ready' "AnythingLLM listening on :$Port"
    exit 0
  }
  Start-Sleep -Seconds 2
}

Write-Result $false $true 'timeout' "started but port $Port not ready in 120s (first pull may need longer)"
exit 1
