# v4: restart DSH only (so it loads the patched dsh-access.mjs), keeping the session clean.
# No manage.ps1 calls: that script hangs after printing status.
# ASCII only; converted to UTF-8 with BOM afterwards.
$ErrorActionPreference = 'Stop'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'reset_session.log'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$nodeExe = 'G:\wechat-deepseek\data\runtimes\0.3.9-db3bce768f85\node.exe'
$bridgeJs = 'G:\wechat-deepseek\data\workspace\components\qq-bridge\src\social-bridge.js'
$bridgeCfg = 'G:\wechat-deepseek\data\workspace\state\bridge-config.json'
$mcpLog = Join-Path $root 'bridge.log'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

try {
  Write-Log 'v4 wait 10s'
  Start-Sleep -Seconds 10

  Write-Log 'quit DSH'
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(18)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Write-Log 'force kill DSH'
    Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
  }
  Write-Log 'DSH stopped'

  Write-Log 'cleaning state'
  & $py (Join-Path $root '_reset_wx_session.py') 2>&1 | ForEach-Object { Write-Log ('  ' + $_) }

  $before = 0
  if (Test-Path $mcpLog) { $before = (Get-Content $mcpLog -Encoding UTF8 | Measure-Object -Line).Lines }

  Write-Log 'start DSH'
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 35

  Write-Log ('DSH 11230 = ' + (Test-Port 11230))
  Write-Log ('bridge 11229 = ' + (Test-Port 11229))
  Write-Log ('mcp 8765 = ' + (Test-Port 8765))

  if (-not (Test-Port 11229)) {
    Write-Log 'restarting bridge directly'
    Start-Process -FilePath $nodeExe -ArgumentList @($bridgeJs, $bridgeCfg) -WindowStyle Hidden
    Start-Sleep -Seconds 10
    Write-Log ('bridge 11229 = ' + (Test-Port 11229))
  }

  if (Test-Path $mcpLog) {
    $new = Get-Content $mcpLog -Encoding UTF8 | Select-Object -Skip $before
    $hit = ($new | Select-String -Pattern 'initialize' -SimpleMatch).Count
    Write-Log ('mcp client reconnected lines = ' + $hit)
  }
  Write-Log 'done'
} catch {
  Write-Log ('ERROR: ' + $_.Exception.Message)
}
