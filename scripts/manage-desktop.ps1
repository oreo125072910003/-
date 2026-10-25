param(
    [ValidateSet('start','stop','restart','status')][string]$Action = 'start',
    [string]$DataHome = $env:XIAOZHUSHOU_DATA_HOME
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localConfiguration = Join-Path $projectRoot 'config\desktop-install.local.json'
if (-not $DataHome -and (Test-Path -LiteralPath $localConfiguration -PathType Leaf)) {
    $DataHome = (Get-Content -LiteralPath $localConfiguration -Raw -Encoding UTF8 | ConvertFrom-Json).dataHome
}
if (-not $DataHome) { $DataHome = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'XiaoZhuShou' }
if (-not [IO.Path]::IsPathRooted($DataHome) -or $DataHome.Contains('"')) { throw 'DataHome must be an absolute path without quotes.' }
$DataHome = [IO.Path]::GetFullPath($DataHome)
$lockFile = Join-Path $DataHome 'db\.assistant-owner.lock'
function Get-DesktopOwner {
    if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) { return $null }
    $lock = Get-Content -LiteralPath $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $lock.pid -or [int]$lock.pid -le 0) { throw 'Invalid product owner record. No process was stopped.' }
    $owner = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
    if (-not $owner) { return $null }
    $releases = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\releases')) + '\'
    if (-not $owner.Path.StartsWith($releases,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $owner.Path) -ne '小助手.exe') {
        throw 'This data directory is owned by a different process. No process was stopped.'
    }
    return $owner
}
function Stop-Desktop {
    $owner = Get-DesktopOwner
    if (-not $owner) { return }
    $stopRequest = Start-Process -FilePath $owner.Path -ArgumentList @('--data-home',('"'+$DataHome+'"'),'--quit') -WorkingDirectory (Split-Path -Parent $owner.Path) -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (Get-DesktopOwner) {
        if ([DateTime]::UtcNow -ge $deadline) { throw 'The product has not confirmed exit. Data was preserved; no forced termination was used.' }
        Start-Sleep -Milliseconds 200
    }
    $remaining = [Math]::Max(1,[int]($deadline-[DateTime]::UtcNow).TotalMilliseconds)
    if (-not $owner.WaitForExit($remaining)) { throw 'The product released its data but has not exited. Restart was not attempted.' }
}
switch ($Action) {
    'start' { & (Join-Path $PSScriptRoot 'launch-desktop.ps1') -DataHome $DataHome }
    'stop' { Stop-Desktop; Write-Output '小助手已退出。' }
    'restart' { Stop-Desktop; & (Join-Path $PSScriptRoot 'launch-desktop.ps1') -DataHome $DataHome }
    'status' {
        $owner = Get-DesktopOwner
        $status = [ordered]@{running=[bool]$owner;version=$null;dataHome=$DataHome;harnessConnected=$false;harnessVersion=$null}
        if ($owner) { $status.version = (Get-Item -LiteralPath $owner.Path).VersionInfo.ProductVersion }
        try {
            $connection = Get-Content -LiteralPath (Join-Path $DataHome 'harness-host\client.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($connection.endpoint -notmatch '^http://127\.0\.0\.1:[1-9]\d{0,4}/?$') { throw 'Invalid local host endpoint.' }
            $token = (Get-Content -LiteralPath $connection.tokenFile -Raw -Encoding UTF8).Trim()
            $health = Invoke-RestMethod -Uri ($connection.endpoint.TrimEnd('/')+'/health') -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 5
            $status.harnessConnected = $health.protocol -eq 'xiaozhushou-harness-host-v1'
            $status.harnessVersion = $health.pluginVersion
        } catch { }
        [pscustomobject]$status | ConvertTo-Json -Compress
    }
}
