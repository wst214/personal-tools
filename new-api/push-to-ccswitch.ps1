# Push New API tokens into CC Switch as Codex providers. Prints one JSON line.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = Join-Path $Root 'push-to-ccswitch.py'
$Activate = if ($args.Count -gt 0) { $args[0] } else { '' }

if (-not (Test-Path $Py)) {
  @{ ok = $false; message = "找不到 push-to-ccswitch.py：$Py"; providers = @() } | ConvertTo-Json -Compress
  exit 1
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  $python = Get-Command py -ErrorAction SilentlyContinue
}
if (-not $python) {
  @{ ok = $false; message = '未找到 python，无法写入 CC Switch'; providers = @() } | ConvertTo-Json -Compress
  exit 1
}

$argList = @($Py)
if ($Activate -and $Activate -ne '-' -and $Activate -ne 'none') {
  $argList += $Activate
}

& $python.Source @argList
exit $LASTEXITCODE
