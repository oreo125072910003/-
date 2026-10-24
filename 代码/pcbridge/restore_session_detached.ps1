# Detached: stop DSH (this kills the calling agent too, so it runs outside),
# restore the private-chat session mapping so history comes back, then start DSH.
# ASCII only; saved as UTF-8 with BOM afterwards.
param(
  [int]$DelaySeconds = 20
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'restore_session.log'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

Write-Log ("=== 定时恢复会话 (延迟 ${DelaySeconds}s) ===")
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
  Write-Log '强制结束 DSH'
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 4
}
Write-Log 'DSH 已停止'

Write-Log '恢复会话映射'
& $py (Join-Path $root '_restore_session.py') 2>&1 | ForEach-Object { Write-Log ('  ' + $_) }

Write-Log '启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 40
Write-Log ('DSH 11230 = ' + (Test-Port 11230))
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log ('mcp 8765 = ' + (Test-Port 8765))
Write-Log ('hook 30001 = ' + (Test-Port 30001))
Write-Log '=== 完成 ==='
