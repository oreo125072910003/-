@echo off
chcp 65001 >nul
start "" wscript.exe "%~dp0start_hidden.vbs"
echo 已在后台启动(无窗口)。日志在 bridge.log。
timeout /t 2 >nul
