@echo off
chcp 65001 >nul
set "DIR=C:\Users\ADMIN\.dsh\profiles\desktop"
if not exist "%DIR%\cordis.patch.yml.bak-20261022" (
  echo 找不到备份文件 %DIR%\cordis.patch.yml.bak-20261022
  pause
  exit /b 1
)
copy /y "%DIR%\cordis.patch.yml.bak-20261022" "%DIR%\cordis.patch.yml" >nul
echo 已把 DSH 的 profile 配置恢复成改动前的样子。
echo 然后重新打开 DeepSeek Harness 即可。
pause
