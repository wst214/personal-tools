@echo off
cd /d "%~dp0\.."
echo Building and starting mytools (personal-dev-site on http://localhost:8080)
docker compose up --build -d mytools-personal-dev-site
if %errorlevel% neq 0 (
  echo.
  echo Failed. Make sure Docker Desktop is running.
  pause
  exit /b 1
)
echo.
echo Started. Open http://localhost:8080 in your browser.
echo Stop with: docker compose down
pause
