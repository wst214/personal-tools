@echo off
setlocal
cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo Creating venv...
  python -m venv .venv
  if %errorlevel% neq 0 (
    echo Python not found. Install Python 3.10+ first.
    pause
    exit /b 1
  )
  .venv\Scripts\pip install -r requirements.txt -q
)

echo.
echo NOTE: Docker is recommended. Run setup-docker.bat instead.
echo       Stop Docker container first if port 5760 is already in use.
echo.
echo Tunnel Panel: http://localhost:5760
echo Press Ctrl+C to stop.
echo.

.venv\Scripts\python app.py
