@echo off
setlocal
cd /d "%~dp0"

set PORT=%1
if "%PORT%"=="" set PORT=8080

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tunnel.ps1" -Port %PORT%
set EXIT_CODE=%errorlevel%

if %EXIT_CODE% neq 0 (
  echo.
  echo [Error] Tunnel failed to start.
  echo.
  echo Common causes:
  echo   1. Proxy/VPN blocking Cloudflare - turn off TUN mode or add DIRECT rules
  echo   2. Local service not running on port %PORT%
  echo   3. Network cannot reach api.trycloudflare.com
  echo.
  pause
  exit /b 1
)
