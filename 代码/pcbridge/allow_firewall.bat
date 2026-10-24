@echo off
chcp 65001 >nul
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限,正在提权...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
netsh advfirewall firewall add rule name="dsh-pc-bridge 8765" dir=in action=allow protocol=TCP localport=8765
if %errorlevel% equ 0 (
  echo.
  echo 已放行入站 TCP 8765。手机现在可以连这台电脑了。
) else (
  echo.
  echo 添加规则失败,可以手动在「Windows 安全中心 → 防火墙 → 高级设置」里放行 8765。
)
pause
