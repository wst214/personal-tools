# Idempotent Stirling-PDF launcher (host port 8090 -> container 8080).
# Keep this file ASCII-only so Windows PowerShell 5.x parses it under system ANSI.
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8090
$Name = 'mytools-stirling-pdf'
$MytoolsRoot = Split-Path -Parent (Split-Path -Parent $Root)
$Compose = Join-Path $MytoolsRoot 'docker-compose.yml'
$Service = 'mytools-stirling-pdf'
$Images = @(
  'stirlingtools/stirling-pdf:latest',
  'docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest'
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

if (Test-LocalPort $Port) {
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

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'tessdata') | Out-Null

$logs = New-Object System.Collections.Generic.List[string]
$started = $false

# 1) compose up
$r = Invoke-Docker $docker @('compose', '-f', $Compose, 'up', '-d', $Service)
$logs.Add("compose: exit=$($r.Code)`n$($r.Text)") | Out-Null
if ($r.Code -eq 0) { $started = $true }

# 2) fallback: docker run with image candidates
if (-not $started) {
  foreach ($img in $Images) {
    Invoke-Docker $docker @('rm', '-f', $Name) | Out-Null
    $dataVol = (Join-Path $Root 'data') + ':/configs'
    $tessVol = (Join-Path $Root 'tessdata') + ':/usr/share/tessdata'
    $r2 = Invoke-Docker $docker @(
      'run', '-d', '--name', $Name, '--restart', 'unless-stopped',
      '-p', "${Port}:8080",
      '-e', 'SECURITY_ENABLELOGIN=false',
      '-e', 'DISABLE_ADDITIONAL_FEATURES=false',
      '-e', 'SYSTEM_DEFAULTLOCALE=zh_CN',
      '-e', 'SYSTEM_GOOGLEVISIBILITY=false',
      '-e', 'SECURITY_XFRAMEOPTIONS=DISABLED',
      '-v', $dataVol,
      '-v', $tessVol,
      $img
    )
    $logs.Add("run ${img}: exit=$($r2.Code)`n$($r2.Text)") | Out-Null
    if ($r2.Code -eq 0) { $started = $true; break }
  }
}

if (-not $started) {
  $hint = 'Cannot pull/start Stirling-PDF image. Check Docker Desktop network / mirror, then retry.'
  Write-Result $false $false 'start_failed' ($hint + "`n" + ($logs -join "`n---`n"))
  exit 1
}

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if (Test-LocalPort $Port) {
    Write-Result $true $true 'ready' "Stirling-PDF listening on :$Port"
    exit 0
  }
  Start-Sleep -Seconds 2
}

Write-Result $false $true 'timeout' "started but port $Port not ready in 120s (first pull may need longer)"
exit 1
