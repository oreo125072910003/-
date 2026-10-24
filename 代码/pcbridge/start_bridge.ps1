# Start the WeChat social bridge with the token env it needs.
# Usable standalone or from other scripts. ASCII only; saved as UTF-8 with BOM.
param(
  [int]$WaitSeconds = 12
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'bridge_start.log'
$nodeExe = 'G:\wechat-deepseek\data\runtimes\0.3.9-db3bce768f85\node.exe'
$bridgeJs = 'G:\wechat-deepseek\data\workspace\components\qq-bridge\src\social-bridge.js'
$bridgeCfg = 'G:\wechat-deepseek\data\workspace\state\bridge-config.json'
$tokenFile = 'G:\wechat-deepseek\data\workspace\state\social-dsh-token.txt'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

if (Test-Port 11229) { Write-Log 'bridge already listening on 11229'; exit 0 }

if (-not (Test-Path $tokenFile)) { Write-Log 'missing token file'; exit 1 }
$env:SOCIAL_DSH_TOKEN = (Get-Content $tokenFile -Raw).Trim()
$env:SOCIAL_DSH_URL = 'http://127.0.0.1:11230'

$errFile = Join-Path $root 'bridge_start.err.log'
$outFile = Join-Path $root 'bridge_start.out.log'
foreach ($f in @($errFile, $outFile)) { if (Test-Path $f) { Remove-Item $f -Force } }

Write-Log 'starting bridge'
Start-Process -FilePath $nodeExe -ArgumentList @($bridgeJs, $bridgeCfg) -WindowStyle Hidden `
  -RedirectStandardOutput $outFile -RedirectStandardError $errFile

Start-Sleep -Seconds $WaitSeconds
$ok = Test-Port 11229
Write-Log ('bridge 11229 = ' + $ok)
if (-not $ok -and (Test-Path $errFile)) {
  Get-Content $errFile -Encoding UTF8 | Select-Object -First 12 | ForEach-Object { Write-Log ('  ERR ' + $_) }
}
exit 0
