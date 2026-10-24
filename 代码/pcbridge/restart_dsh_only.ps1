# Restart DSH only. No session rotation, no buffer wipe: chat history stays.
# ASCII only; saved as UTF-8 with BOM afterwards.
param(
  [int]$WaitSeconds = 90
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'restart_dsh.log'
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

Write-Log '=== restart DSH (history preserved) ==='
Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  ForEach-Object { [void]$_.CloseMainWindow() }
$deadline = (Get-Date).AddSeconds(18)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
}
if (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  Write-Log 'force kill'
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 4
}
Write-Log 'DSH stopped'

Start-Process -FilePath $exe
Start-Sleep -Seconds 35
Write-Log ('DSH 11230 = ' + (Test-Port 11230))
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log ('mcp 8765 = ' + (Test-Port 8765))
Write-Log ('hook 30001 = ' + (Test-Port 30001))
Write-Log '=== done ==='
