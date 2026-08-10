@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting TestHub (MySQL + backend :8000 + frontend :3001)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-testhub.ps1"
if errorlevel 1 (
  echo Failed. Check logs in "%~dp0.run\"
  pause
  exit /b 1
)
echo Ready: http://localhost:3001
echo DevToolbox -^> System -^> TestHub will also auto-start this.
exit /b 0
