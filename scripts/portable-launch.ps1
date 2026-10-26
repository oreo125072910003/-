param([string]$DataHome = $env:XIAOZHUSHOU_DATA_HOME)
$ErrorActionPreference = 'Stop'
try {
    $executable = Join-Path $PSScriptRoot '小助手.exe'
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '请先解压完整压缩包，再双击“启动小助手.cmd”。不要单独移动启动文件。' }
    if (-not $DataHome) {
        # Reuse the existing installation without copying any account data.
        $candidates = @(
            (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'XiaoZhuShou'),
            (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\XiaoZhuShou')
        )
        $existing = @($candidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'db\assistant.sqlite') -PathType Leaf })
        if ($existing.Count -eq 1) { $DataHome = $existing[0] }
        elseif ($existing.Count -gt 1) { throw '找到多个小助手数据目录。请使用原安装的启动入口，或设置 XIAOZHUSHOU_DATA_HOME 后再启动，避免打开错误的记录。' }
    }
    if ($DataHome -and (-not [IO.Path]::IsPathRooted($DataHome) -or $DataHome.Contains('"'))) { throw '数据目录必须是没有引号的绝对路径。' }
    . (Join-Path $PSScriptRoot 'electron-process.ps1')
    $null = Start-AssistantElectron -Executable $executable -DataHome $DataHome
} catch {
    Write-Host $_.Exception.Message
    Read-Host '按回车关闭'
    exit 1
}
