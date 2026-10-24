# Detached: stop DSH, clean "no tools" refusals out of the restored session,
# then restart DSH. ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 10
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'clean_refusals.log'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$sessionFile = 'C:\Users\ADMIN\.dsh\sessions\--F-deepseek~5DE5~4F5C~533A--\social-b156bb208b9bcbc2320c9464e48fd091\session.v4.jsonl.zstd'

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

Write-Log ("=== 清理自我否定回复 (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds
Write-Log '1) 停 DSH'
Stop-Dsh
Write-Log '2) 清理会话'
& $node (Join-Path $root '_clean_refusals.mjs') $sessionFile 2>&1 | ForEach-Object { Write-Log ('   ' + $_) }
Write-Log '3) 启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 45
Write-Log ('   11230 = ' + (Test-Port 11230))
Write-Log ('   bridge 11229 = ' + (Test-Port 11229))
Write-Log ('   hook 30001 = ' + (Test-Port 30001))
Write-Log '=== 完成 ==='
