# Restart hooked WeChat with software rendering (Qt Quick software backend).
# Use only when the WeChat window keeps rendering white/blank.
$ErrorActionPreference = 'Stop'
$exe = 'G:\wechat-deepseek\data\workspace\state\hook\wechat-4.1.10.27\Weixin.exe'
$workdir = Split-Path -Parent $exe
$env:QT_QUICK_BACKEND = 'software'
$env:QT_OPENGL = 'software'
$env:QSG_RHI_BACKEND = 'software'
Write-Output 'stopping WeChat client...'
Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Start-Process -FilePath $exe -ArgumentList 'StartPort=30001 CallBackURL="http://127.0.0.1:11229/unused"' -WorkingDirectory $workdir -WindowStyle Normal
Write-Output 'started with software rendering; wait for hook and finish phone login confirmation if prompted.'
