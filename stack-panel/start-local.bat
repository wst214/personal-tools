@echo off
setlocal
cd /d "%~dp0"

if not exist .venv (
  python -m venv .venv
  call .venv\Scripts\activate.bat
  pip install -r requirements.txt
) else (
  call .venv\Scripts\activate.bat
)

set MYTOOLS_ROOT=%~dp0..
set STACK_PANEL_PORT=5770

echo Stack panel (local): http://localhost:5770
python app.py
