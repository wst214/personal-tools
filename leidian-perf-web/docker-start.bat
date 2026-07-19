@echo off
REM PERF 操作台 Docker 启动（cmd 入口；内部调用 PowerShell）
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker-start.ps1" %*
exit /b %ERRORLEVEL%
