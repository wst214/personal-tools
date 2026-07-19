@echo off
setlocal
cd /d "%~dp0.."

echo Building and starting mytools-ops-panel on http://localhost:5770
docker compose up --build -d mytools-ops-panel
if %errorlevel% neq 0 (
  echo.
  echo Failed. Make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo.
echo Stack panel: http://localhost:5770
pause
