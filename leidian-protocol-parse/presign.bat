@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\minio\" (
  call npm install --omit=dev
)
node src\presign-cli.js %*
endlocal
