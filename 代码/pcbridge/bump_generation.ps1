# Detached: bump the private-chat session generation so the plugin can create a
# fresh session id (the previous computed id collided with an existing one),
# then restart DSH. History of the old session stays on disk.
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 8
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'bump_generation.log'
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

Write-Log ("=== 提升 generation 并重启 (延迟 ${DelaySeconds}s) ===")
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

Write-Log '提升私聊 generation'
Copy-Item $state ($state + '.bump-bak') -Force
& $py -c @"
import json
p = r'$state'
d = json.load(open(p, encoding='utf-8-sig'))
CHAT = 'wechat:private:1253808542'
d['conversations'].pop(CHAT, None)
prof = d.setdefault('profiles', {}).setdefault(CHAT, {})
old = int(prof.get('generation') or 0)
prof['generation'] = old + 1
for f in ('cache', 'context'):
    prof.pop(f, None)
prof['initializations'] = 0
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('generation %d -> %d' % (old, prof['generation']))
"@ | ForEach-Object { Write-Log ('  ' + $_) }

Write-Log '启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 50
Write-Log ('DSH 11230 = ' + (Test-Port 11230))
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log '=== 完成 ==='
