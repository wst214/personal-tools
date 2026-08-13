@echo off
cd /d "%~dp0"
echo Starting writing console...
start "" cmd /c "node server.mjs --open"
echo Browser should open at http://127.0.0.1:8310/
pause
