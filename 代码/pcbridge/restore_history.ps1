# Detached: restore the OLD (papers) session by setting generation=16 together with
# its matching session id, then restart DSH. Falls back to the working gen-18 session
# if the plugin still fails.
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 8
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'restore_history.log'
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

function Set-Session([string]$sid, [int]$gen) {
  & $py -c @"
import json, sys
p = r'$state'
sid, gen = sys.argv[1], int(sys.argv[2])
d = json.load(open(p, encoding='utf-8-sig'))
CHAT = 'wechat:private:1253808542'
d['conversations'][CHAT] = sid
prof = d.setdefault('profiles', {}).setdefault(CHAT, {})
prof['generation'] = gen
for f in ('cache','context'):
    prof.pop(f, None)
prof['initializations'] = 0
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('映射 %s gen=%d' % (sid, gen))
"@ $sid $gen
}

Write-Log ("=== 恢复论文那段历史 (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds

Write-Log '1) 停 DSH'
Stop-Dsh
Write-Log '2) 设置 gen=16 + 旧会话'
Set-Session $oldSid 16
Write-Log '3) 启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 45
$ok = Test-Port 11230
Write-Log ('   11230 = ' + $ok)

if (-not $ok) {
  Write-Log '4) 仍然失败,回退到可用会话'
  $trace = 'G:\wechat-deepseek\data\workspace\state\apply-trace.log'
  if (Test-Path $trace) {
    Get-Content $trace -Encoding UTF8 | Select-Object -Last 4 | ForEach-Object { Write-Log ('  TRACE ' + $_.Substring(0,[Math]::Min(300,$_.Length))) }
  }
  Stop-Dsh
  Set-Session $goodSid 18
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 42
  Write-Log ('   回退后 11230 = ' + (Test-Port 11230))
} else {
  Write-Log '4) 成功:旧会话已接回,历史应已恢复'
}
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log '=== 完成 ==='
