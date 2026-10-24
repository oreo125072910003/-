@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "found="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
  echo 停止进程 PID=%%p
  taskkill /PID %%p /F >nul 2>&1
  set "found=1"
)
if not defined found (
  echo 8765 端口上没发现正在运行的服务。
) else (
  echo 已停止。
)
pause
