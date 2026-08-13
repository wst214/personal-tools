# Apply DevToolbox embed helpers into running AnythingLLM.
$ErrorActionPreference = 'Continue'
$Container = if ($args[0]) { $args[0] } else { 'mytools-anythingllm' }
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Skin = Join-Path $Root 'toolbox-skin.css'
$Patch = Join-Path $Root 'patch-skin.py'
$SkinVer = 'notes5'

function Find-Docker {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $p = "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe"
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

$docker = Find-Docker
if (-not $docker) { Write-Output 'no_docker'; exit 1 }
if (-not (Test-Path -LiteralPath $Skin)) { Write-Output "missing $Skin"; exit 1 }
if (-not (Test-Path -LiteralPath $Patch)) { Write-Output "missing $Patch"; exit 1 }

$running = & $docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($running -ne 'true') {
  Write-Output "container_not_running:$Container"
  exit 1
}

& $docker cp $Skin "${Container}:/app/server/public/toolbox-skin.css" | Out-Null
& $docker cp $Patch "${Container}:/tmp/patch-skin.py" | Out-Null
$out = & $docker exec $Container python3 /tmp/patch-skin.py $SkinVer 2>&1
Write-Output ("skin:" + ($out | Out-String).Trim())

& $docker restart $Container | Out-Null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $h = & $docker inspect -f '{{.State.Health.Status}}' $Container 2>$null
  if ($h -eq 'healthy') { break }
  $r = & $docker inspect -f '{{.State.Running}}' $Container 2>$null
  if ($r -eq 'true' -and $h -ne 'starting') { break }
}
Write-Output 'restarted'
exit 0
