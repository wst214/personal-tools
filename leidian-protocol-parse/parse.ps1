$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$CodexNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node -and (Test-Path $CodexNode)) {
  $Node = $CodexNode
}
if (-not $Node) {
  throw "Node.js was not found. Please install Node.js 18+ or run inside Codex runtime."
}
Push-Location $Root
try {
  & $Node src/cli.js @args
} finally {
  Pop-Location
}
