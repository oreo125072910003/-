# Detached A/B test: restart DSH with the private chat mapped to a FRESH session,
# to see whether the restored old session is what blocks the social plugin.
# ASCII only; saved as UTF-8 with BOM afterwards.
param(
  [int]$DelaySeconds = 8
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'ab_test.log'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$state = 'G:\wechat-deepseek\data\workspace\state\accounts\28330caa72b639c40753bfa2400f8f17f3c191f1d00f33aaa509bbd00b6e0258\dsh-sessions.json'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

Write-Log ("=== A/B 测试:全新会话 (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds

Write-Log '停止 DSH'
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

Write-Log '把私聊映射切到全新会话(暂时不动旧历史文件)'
Copy-Item $state ($state + '.ab-test-bak') -Force
& $py -c @"
import json
p = r'$state'
d = json.load(open(p, encoding='utf-8-sig'))
d['conversations'].pop('wechat:private:1253808542', None)
prof = d.setdefault('profiles', {}).setdefault('wechat:private:1253808542', {})
prof.pop('cache', None); prof.pop('context', None)
json.dump(d, open(p,'w',encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('mapping cleared')
"@ | ForEach-Object { Write-Log ('  ' + $_) }

Write-Log '启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 55
Write-Log ('DSH 11230 = ' + (Test-Port 11230))
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log '=== 完成 ==='
