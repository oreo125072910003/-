# Detached reproduce: map private chat back to the OLD session, start DSH with logs,
# capture whether the plugin fails and any error text, then restore the working
# session and restart so WeChat keeps working.
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 8
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'repro_old_session.log'
$outFile = Join-Path $root 'repro_stdout.log'
$errFile = Join-Path $root 'repro_stderr.log'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$state = 'G:\wechat-deepseek\data\workspace\state\accounts\28330caa72b639c40753bfa2400f8f17f3c191f1d00f33aaa509bbd00b6e0258\dsh-sessions.json'
$oldSid = 'social-b156bb208b9bcbc2320c9464e48fd091'
$goodSid = 'social-7dd00fc5b7e123ee0175c0c367620dc6'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

function Stop-Dsh {
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
  }
}

function Set-Mapping([string]$sid) {
  & $py -c @"
import json, sys
p = r'$state'
sid = sys.argv[1]
d = json.load(open(p, encoding='utf-8-sig'))
CHAT = 'wechat:private:1253808542'
if sid:
    d['conversations'][CHAT] = sid
else:
    d['conversations'].pop(CHAT, None)
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('mapping ->', sid or '(cleared)')
"@ $sid
}

Write-Log ("=== 复现旧会话 (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds

Write-Log '1) 停 DSH'
Stop-Dsh
Copy-Item $state ($state + '.repro-bak') -Force

Write-Log '2) 映射回旧会话'
Set-Mapping $oldSid

Write-Log '3) 启动 DSH (带日志)'
foreach ($f in @($outFile, $errFile)) { if (Test-Path $f) { Remove-Item $f -Force } }
$env:ELECTRON_ENABLE_LOGGING = '1'
Start-Process -FilePath $exe -ArgumentList '--enable-logging' `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile
Start-Sleep -Seconds 45

$oldOk = Test-Port 11230
Write-Log ('   旧会话下 11230 = ' + $oldOk)

if (-not $oldOk) {
  Write-Log '4) 插件失败,抓取日志尾部'
  if (Test-Path $outFile) {
    Get-Content $outFile -Encoding UTF8 | Select-Object -Last 40 | ForEach-Object { Write-Log ('  OUT ' + $_) }
  }
  if (Test-Path $errFile) {
    Get-Content $errFile -Encoding UTF8 | Select-String -Pattern 'error|Error|ERROR|social|session|resume|throw|invalid|fail' |
      Select-Object -Last 30 | ForEach-Object { Write-Log ('  ERR ' + $_.Line) }
  }
  Write-Log '5) 恢复可用会话并重启'
  Stop-Dsh
  Set-Mapping $goodSid
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 45
  Write-Log ('   恢复后 11230 = ' + (Test-Port 11230))
  Write-Log ('   恢复后 bridge 11229 = ' + (Test-Port 11229))
} else {
  Write-Log '旧会话居然起来了,保留映射'
}
Write-Log '=== 完成 ==='
