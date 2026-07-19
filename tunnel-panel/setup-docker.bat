@echo off
setlocal
cd /d "%~dp0"

if not exist .env (
  echo Creating .env from .env.example ...
  copy /Y .env.example .env >nul
  echo.
  echo Please edit tunnel-panel\.env and set CPOLAR_AUTHTOKEN
  echo Get token: https://dashboard.cpolar.com
  echo.
  notepad .env
)

echo Building and starting tunnel panel (Cloudflare + cpolar)...
cd /d "%~dp0.."
docker compose up -d --build mytools-tunnel-panel
if %errorlevel% neq 0 (
  echo.
  echo Failed. Make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo.
echo Tunnel panel: http://localhost:5760
echo   - Cloudflare: no registration
echo   - cpolar: needs CPOLAR_AUTHTOKEN in tunnel-panel\.env
echo.
pause
