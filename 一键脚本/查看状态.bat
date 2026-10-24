@echo off
chcp 65001 >nul
echo ===== WeChatAgent services =====
powershell -NoProfile -ExecutionPolicy Bypass -File "G:\wechat-deepseek\data\workspace\scripts\manage.ps1" status
echo.
echo ===== pcbridge (MCP 8765) =====
powershell -NoProfile -Command "$c=Get-Content 'F:\deepseek工作区\wechat-pc-bridge\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json; try { $h=Invoke-RestMethod ('http://127.0.0.1:8765/health?token=' + $c.token) -TimeoutSec 5; Write-Host ('OK  workspace=' + $h.workspace + '  version=' + $h.version) } catch { Write-Host 'DOWN (watchdog should restart it within ~1 min)' }"
echo.
pause
