@echo off
chcp 65001 >nul
echo [WeChatAgent] restart and apply (takes ~10-20s)...
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\wechat-deepseek\data\workspace\scripts\manage.ps1" restart
if errorlevel 1 (
  echo [FAILED] see G:\wechat-deepseek\data\workspace\state\logs
) else (
  echo [DONE]
)
pause
