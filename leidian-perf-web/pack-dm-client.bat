@echo off
REM Fetch Linux DM client from dbserver into dm-client/
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pack-dm-client.ps1" %*
exit /b %ERRORLEVEL%
