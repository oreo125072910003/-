param()
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configuration = Get-Content -LiteralPath (Join-Path $projectRoot 'config\wechat-locations.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeRoot = [IO.Path]::GetFullPath($configuration.workspace)
$runtimeScripts = Join-Path $runtimeRoot 'scripts'
foreach ($directory in @($runtimeRoot, $runtimeScripts)) {
    $info = Get-Item -LiteralPath $directory
    if (-not $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Image reader target must be a physical directory.' }
}
$names = @('wechat_image_normalize.py', 'resolve-wechat-image.py', 'reader-api.py')
$backup = Join-Path $projectRoot ('dist\image-reader-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$report = @()
foreach ($name in $names) {
    $source = Join-Path $projectRoot ('代码\项目\scripts\' + $name)
    $destination = Join-Path $runtimeScripts $name
    $existing = Get-Item -LiteralPath $destination
    if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Image reader target must be a regular file.' }
    Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $name)
    $before = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    Copy-Item -LiteralPath $source -Destination $destination -Force
    $after = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($after -ne (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash) { throw 'Image reader copy failed verification.' }
    $report += [pscustomobject]@{file=$name;before=$before;after=$after}
}
$result = [pscustomobject]@{applied=$true;backup=$backup;files=$report;newImageWorkersUseFix=$true;readerReloadNeededForOldCache=$true}
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $backup 'report.json') -Encoding UTF8
$result | ConvertTo-Json -Depth 4 -Compress
