@echo off
chcp 65001 >nul
setlocal
set SRC=G:\wechat-deepseek\data\workspace
set DST=G:\小助手\备份
if not exist "%DST%" mkdir "%DST%"
for /f "tokens=1-3 delims=/- " %%a in ("%date%") do set D=%%a%%b%%c
for /f "tokens=1-3 delims=:." %%a in ("%time%") do set T=%%a%%b%%c
set T=%T: =0%
set ZIP=%DST%\备份_%D%_%T%.zip
echo Backing up config + roles + key state to:
echo   %ZIP%
powershell -NoProfile -Command "$src='%SRC%'; $zip='%ZIP%'; $tmp=Join-Path $env:TEMP ('bak_'+[guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmp | Out-Null; Copy-Item (Join-Path $src 'config') (Join-Path $tmp 'config') -Recurse -Force; Copy-Item (Join-Path $src 'roles') (Join-Path $tmp 'roles') -Recurse -Force; $s=Join-Path $tmp 'state'; New-Item -ItemType Directory -Path $s | Out-Null; foreach($f in 'bridge-config.json','social-messages.json','wechat-io-config.json','runtime.json'){ $p=Join-Path $src ('state\'+$f); if(Test-Path $p){ Copy-Item $p (Join-Path $s $f) -Force } }; Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip -Force; Remove-Item $tmp -Recurse -Force; Write-Host ('SAVED ' + $zip)"
echo.
pause
