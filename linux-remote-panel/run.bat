@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv" (
    echo 正在创建虚拟环境...
    python -m venv .venv
)

call .venv\Scripts\activate.bat
pip install -r requirements.txt -q

echo.
echo 启动 Linux 远程面板...
echo 浏览器将自动打开 http://127.0.0.1:5757
echo 按 Ctrl+C 可停止服务
echo.

python app.py
