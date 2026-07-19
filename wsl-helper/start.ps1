param(
    [switch]$Background
)

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

function Test-HelperRunning {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:5758/health" -TimeoutSec 2 -UseBasicParsing
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (Test-HelperRunning) {
    Write-Host "WSL Helper already running at http://127.0.0.1:5758"
    exit 0
}

if (-not (Test-Path ".venv")) {
    python -m venv .venv
}

& .\.venv\Scripts\pip install -q -r requirements.txt

if ($Background) {
    $pythonw = Join-Path $dir ".venv\Scripts\pythonw.exe"
    if (-not (Test-Path $pythonw)) {
        $pythonw = Join-Path $dir ".venv\Scripts\python.exe"
    }
    Start-Process -FilePath $pythonw -ArgumentList "server.py" -WorkingDirectory $dir -WindowStyle Hidden

    $ready = $false
    foreach ($i in 1..10) {
        Start-Sleep -Milliseconds 500
        if (Test-HelperRunning) {
            $ready = $true
            break
        }
    }

    if ($ready) {
        Write-Host "WSL Helper started in background at http://127.0.0.1:5758"
        exit 0
    }

    Write-Error "WSL Helper failed to start. Try running start.ps1 without -Background for details."
    exit 1
}

Write-Host "WSL Helper running at http://127.0.0.1:5758"
Write-Host "Keep this window open while using Linux Remote Panel."
& .\.venv\Scripts\python server.py
