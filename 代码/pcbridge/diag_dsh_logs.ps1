# Detached: stop DSH, restart it with Electron logging captured to files,
# so the social-bridge plugin startup error becomes visible.
# ASCII only; saved as UTF-8 with BOM afterwards.
param(
  [int]$DelaySeconds = 10
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'dsh_diag.log'
$outFile = Join-Path $root 'dsh_stdout.log'
$errFile = Join-Path $root 'dsh_stderr.log'
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

Write-Log ("=== 抓 DSH 启动日志 (延迟 ${DelaySeconds}s) ===")
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

foreach ($f in @($outFile, $errFile)) {
  if (Test-Path $f) { Remove-Item $f -Force }
}

$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_ENABLE_STACK_DUMPING = '1'
Write-Log '启动 DSH (带日志)'
Start-Process -FilePath $exe -ArgumentList '--enable-logging' `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile

Start-Sleep -Seconds 55
Write-Log ('DSH 11230 = ' + (Test-Port 11230))
Write-Log ('bridge 11229 = ' + (Test-Port 11229))
Write-Log ('mcp 8765 = ' + (Test-Port 8765))
if (Test-Path $outFile) { Write-Log ('stdout 行数 ' + (Get-Content $outFile | Measure-Object -Line).Lines) }
if (Test-Path $errFile) { Write-Log ('stderr 行数 ' + (Get-Content $errFile | Measure-Object -Line).Lines) }
Write-Log '=== 完成 ==='
