@echo off
setlocal
cd /d "%~dp0"

echo [1/2] Starting Docker Compose stack...
docker compose up -d --build
if %errorlevel% neq 0 (
  echo.
  echo Failed. Make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo [2/2] Starting WSL Helper...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0wsl-helper\start.ps1" -Background
if %errorlevel% neq 0 (
  echo.
  echo WSL Helper failed to start.
  pause
  exit /b 1
)

echo.
echo mytools stack is up:
echo   Personal dev site   http://localhost:8090
echo   Stack panel         http://localhost:5770
echo   Linux remote panel  http://localhost:5757
echo   Tunnel panel        http://localhost:5760
echo   New API             http://localhost:5780
echo   WSL helper          http://127.0.0.1:5758
echo.
echo Stop Docker: docker compose down
pause
