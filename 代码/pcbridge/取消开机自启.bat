@echo off
chcp 65001 >nul
set "lnk=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-pc-bridge.lnk"
if exist "%lnk%" (
  del "%lnk%"
  echo 已取消开机自启(删掉了启动文件夹里的快捷方式)。
) else (
  echo 本来就没设开机自启。
)
echo 注意:这一步只取消自启,不会停掉当前正在跑的服务。
echo 要停服务请双击 stop_server.bat。
pause
