function Start-AssistantElectron {
    param([Parameter(Mandatory=$true)][string]$Executable, [string]$DataHome, [switch]$Quit)
    if (-not [IO.Path]::IsPathRooted($Executable) -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Assistant executable is missing.' }
    if ($DataHome -and (-not [IO.Path]::IsPathRooted($DataHome) -or $DataHome.Contains('"'))) { throw 'Invalid data directory.' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.WorkingDirectory = Split-Path -Parent $Executable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = 'Hidden'
    # Developer shells often set Electron's Node mode. Carrying it into a GUI
    # launch makes the executable exit before opening the product.
    foreach ($name in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH')) { $start.EnvironmentVariables.Remove($name) }
    $arguments = @()
    if ($DataHome) { $arguments += '--data-home "'+$DataHome+'"' }
    if ($Quit) { $arguments += '--quit' }
    $start.Arguments = $arguments -join ' '
    return [Diagnostics.Process]::Start($start)
}
