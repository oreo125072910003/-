@echo off
chcp 65001 >nul
echo [WeChatAgent] stopping all services...
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\wechat-deepseek\data\workspace\scripts\manage.ps1" stop
echo [DONE]
pause
