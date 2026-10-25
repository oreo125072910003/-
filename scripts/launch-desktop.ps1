param([string]$DataHome = $env:XIAOZHUSHOU_DATA_HOME)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.version -notmatch '^\d+\.\d+\.\d+(?:-[\w.-]+)?$') { throw 'Invalid desktop release version.' }
$executable = Join-Path $projectRoot ('dist\releases\'+$metadata.version+'\小助手-win32-x64\小助手.exe')
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Desktop release is not built. Run npm run package first.' }
$localConfiguration = Join-Path $projectRoot 'config\desktop-install.local.json'
if (-not $DataHome -and (Test-Path -LiteralPath $localConfiguration -PathType Leaf)) {
    $DataHome = (Get-Content -LiteralPath $localConfiguration -Raw -Encoding UTF8 | ConvertFrom-Json).dataHome
}
if ($DataHome -and -not [IO.Path]::IsPathRooted($DataHome)) { throw 'DataHome must be an absolute path.' }
if ($DataHome -and $DataHome.Contains('"')) { throw 'DataHome contains an invalid quote.' }
$options = @{FilePath=$executable;WorkingDirectory=(Split-Path -Parent $executable);PassThru=$true}
if ($DataHome) { $options.ArgumentList = @('--data-home',('"'+$DataHome+'"')) }
$process = Start-Process @options
[pscustomobject]@{version=$metadata.version;pid=$process.Id;explicitDataHome=[bool]$DataHome} | ConvertTo-Json -Compress
