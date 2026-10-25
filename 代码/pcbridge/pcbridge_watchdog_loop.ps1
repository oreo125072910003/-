param(
    [string]$BridgeDirectory = $PSScriptRoot,
    [string]$PythonExecutable = '',
    [ValidateRange(1024,65535)][int]$Port = 8765,
    [switch]$ProbeOnly
)
$ErrorActionPreference = 'Stop'
$bridgeRoot = (Get-Item -LiteralPath $BridgeDirectory).FullName
$serverFile = Join-Path $bridgeRoot 'mcp_dsh_server.py'
$configFile = Join-Path $bridgeRoot 'config.json'
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) { throw 'Bridge source is missing.' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($config.token)) { throw 'Bridge control token is not configured.' }
$headers = @{Authorization=('Bearer '+$config.token)}
$logFile = Join-Path $bridgeRoot 'watchdog_pcbridge.log'
function Write-BridgeLog([string]$message) {
    try { Add-Content -LiteralPath $logFile -Value ('[{0}] {1}' -f (Get-Date -Format o), $message) -Encoding UTF8 } catch {}
}
function Test-Bridge {
    try {
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/health' -f $Port) -Headers $headers -TimeoutSec 4
        return ($health.ok -eq $true -and $health.sourceSha256 -eq $sourceHash -and $health.toolCount -eq 16)
    } catch { return $false }
}
$sourceStream = [IO.File]::OpenRead($serverFile)
$sourceHasher = [Security.Cryptography.SHA256]::Create()
try { $sourceHash = ([BitConverter]::ToString($sourceHasher.ComputeHash($sourceStream))).Replace('-','').ToLowerInvariant() }
finally { $sourceStream.Dispose(); $sourceHasher.Dispose() }
if ($ProbeOnly) {
    [pscustomobject]@{healthy=(Test-Bridge);sourceSha256=$sourceHash;port=$Port;processesStarted=0;processesStopped=0} | ConvertTo-Json -Compress
    return
}
if (-not [IO.Path]::IsPathRooted($PythonExecutable) -or -not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
    throw 'Pass an explicit absolute -PythonExecutable path; no shell or guessed runtime is launched.'
}
$pythonPath = (Get-Item -LiteralPath $PythonExecutable).FullName
$hashProvider = [Security.Cryptography.SHA256]::Create()
try { $mutexKey = ([BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes(($bridgeRoot.ToLowerInvariant()+':'+$Port))))).Replace('-','') }
finally { $hashProvider.Dispose() }
$created = $false
$mutex = [Threading.Mutex]::new($false, ('Local\xiaozhushou-pcbridge-watchdog-'+$mutexKey), [ref]$created)
$acquired = $false
try {
    try { $acquired=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired=$true }
    if (-not $acquired) { throw 'This bridge already has a watchdog owner.' }
    Write-BridgeLog ('watchdog started; sourceSha256='+$sourceHash)
    $ownedChild = $null
    while ($true) {
        if (-not (Test-Bridge)) {
            # An unhealthy existing process is a diagnostic condition, not kill authority.
            $matching = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" | Where-Object {
                $_.CommandLine -and $_.CommandLine.IndexOf($serverFile,[StringComparison]::OrdinalIgnoreCase) -ge 0
            }
            $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
            if (($ownedChild -and -not $ownedChild.HasExited) -or $matching -or $listener) {
                Write-BridgeLog 'bridge unhealthy but a process or listener remains; restart withheld for manual diagnosis'
            } else {
                $ownedChild = Start-Process -FilePath $pythonPath -ArgumentList @(('"'+$serverFile+'"')) -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru
                Write-BridgeLog ('started owned bridge child pid='+$ownedChild.Id)
            }
        }
        Start-Sleep -Seconds 20
    }
} finally {
    # The bridge is independent. Closing a watchdog must not kill user work.
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
