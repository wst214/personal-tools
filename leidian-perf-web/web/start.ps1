$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PythonDir = Join-Path (Split-Path -Parent $Root) "python"

Set-Location $Root

if (-not (Test-Path (Join-Path $PythonDir ".venv"))) {
    Write-Host "首次运行：安装 python 依赖..."
    Set-Location $PythonDir
    python -m venv .venv
    & .\.venv\Scripts\pip.exe install -q -r requirements.txt
    Set-Location $Root
}

$py = Join-Path $PythonDir ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }

Write-Host "启动 PERF 压测操作台 http://127.0.0.1:8100"
Write-Host "Python: $py"
& $py (Join-Path $Root "server.py")
