$ErrorActionPreference = 'SilentlyContinue'
$dir = $PSScriptRoot
$token = 'REDACTED_TOKEN'
$log = Join-Path $dir 'watchdog_pcbridge.log'

function Write-Log([string]$m) {
    try { Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 } catch {}
}

$ok = $false
try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:8765/health?token=$token") -TimeoutSec 4
    if ($r.StatusCode -eq 200) { $ok = $true }
} catch {}

if ($ok) { exit 0 }

$stale = Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object { $_.CommandLine -match 'mcp_dsh_server' }
if ($stale) {
    foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force }
    Start-Sleep -Milliseconds 1500
}
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $dir + '\start_hidden.vbs"')
Write-Log ("pcbridge down (stale=" + [bool]$stale + "), restart requested")
