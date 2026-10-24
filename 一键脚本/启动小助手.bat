@echo off
chcp 65001 >nul
echo [WeChatAgent] starting all services...
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\wechat-deepseek\data\workspace\scripts\manage.ps1" start
if errorlevel 1 (
  echo [FAILED] see G:\wechat-deepseek\data\workspace\state\logs
) else (
  echo [DONE]
)
pause
