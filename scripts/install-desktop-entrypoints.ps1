param([Parameter(Mandatory=$true)][string]$EntryDirectory)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($EntryDirectory)) { throw 'EntryDirectory must be an absolute path.' }
$directory = Get-Item -LiteralPath $EntryDirectory
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Choose a physical entry directory.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$manager = Join-Path $projectRoot 'scripts\manage-desktop.ps1'
if ($manager.Contains('"') -or $manager.Contains('%')) { throw 'Unsupported entry script path.' }
$backup = Join-Path $directory.FullName ('备份\入口更新-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$entries = [ordered]@{'启动小助手.bat'='start';'停止小助手.bat'='stop';'重启并应用.bat'='restart';'查看状态.bat'='status'}
$encoding = [Text.UTF8Encoding]::new($false)
foreach ($entry in $entries.GetEnumerator()) {
    $destination = Join-Path $directory.FullName $entry.Key
    if (Test-Path -LiteralPath $destination) {
        if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Entry file is a link; it was not changed.' }
        Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $entry.Key)
    }
    $lines = @('@echo off','chcp 65001 >nul',('powershell -NoProfile -ExecutionPolicy Bypass -File "'+$manager+'" -Action '+$entry.Value),'if errorlevel 1 (','  echo 小助手操作未完成，原数据已保留。','  pause','  exit /b 1',')')
    if ($entry.Value -eq 'status') { $lines += 'pause' }
    [IO.File]::WriteAllText($destination,($lines -join "`r`n")+"`r`n",$encoding)
}
$readme = Join-Path $directory.FullName 'README.md'
if (Test-Path -LiteralPath $readme) { Copy-Item -LiteralPath $readme -Destination (Join-Path $backup 'README.md') }
$text = @"
# 小助手统一入口

主工程：``$projectRoot``。此处的启动、停止、重启和状态入口均使用该工程的最新已构建桌面版；保留原来的微信账号、聊天、DSH 登录和产品记录。

- 启动：双击「启动小助手.bat」。再次启动会显示已有窗口。
- 重启：双击「重启并应用.bat」，等当前任务停止并保存后启动。
- 停止：双击「停止小助手.bat」，只退出小助手。
- 状态：双击「查看状态.bat」，查看桌面和 DSH 宿主连接。
- 历史入口：已备份到本目录的「备份/入口更新」目录；历史资料链接保持原样。

DSH 永远是小助手的核心，继续使用已登录账号。产品数据位置由主工程 config/desktop-install.local.json 指定。

当前已验证原会话连续回复、截图、PNG 绘图、Word/PDF 和本地命令。微信图片/文件的实际投递仍依赖当前微信客户端兼容情况，失败会留存成果并说明状态。邮箱须已有有效的账号授权后才能收发。

本次更新不启动第二个 WeChatAgent，不重启或退出微信。入口备份位置：``$backup``。
"@
[IO.File]::WriteAllText($readme,$text,$encoding)
[pscustomobject]@{installed=$entries.Count;backup=$backup;projectRoot=$projectRoot} | ConvertTo-Json -Compress
