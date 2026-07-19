@echo off
setlocal
pushd "%~dp0"
set "CODEX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%CODEX_NODE%" (
  "%CODEX_NODE%" src\server.js %*
) else (
  where node >nul 2>nul
  if %errorlevel%==0 (
    node src\server.js %*
  ) else (
    echo Node.js was not found. Please install Node.js 18+ or run inside Codex runtime.
    exit /b 1
  )
)
popd
