$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Fail-Client([string]$Code) { throw $Code }
function Read-LocalJson([string]$Filename) {
    $item = Get-Item -LiteralPath $Filename -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 262144) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    return Get-Content -LiteralPath $Filename -Raw -Encoding UTF8 | ConvertFrom-Json
}
try {
    $inputConfig = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (-not [IO.Path]::IsPathRooted($inputConfig.sourceDirectory) -or -not [IO.Path]::IsPathRooted($inputConfig.dataDir) -or $inputConfig.expectedVersion -ne '4.1.10.27') { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    $source = [IO.Path]::GetFullPath($inputConfig.sourceDirectory).TrimEnd('\')
    $project = Read-LocalJson (Join-Path $source 'config\wechatagent.json')
    $exe = if ([IO.Path]::IsPathRooted($project.hook.wechatExecutable)) { [IO.Path]::GetFullPath($project.hook.wechatExecutable) } else { [IO.Path]::GetFullPath((Join-Path $source $project.hook.wechatExecutable)) }
    $scope = [IO.Path]::GetFullPath((Join-Path $source 'state\hook')) + '\'
    if (-not $exe.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase) -or $project.hook.expectedVersion -ne $inputConfig.expectedVersion -or $project.hook.baseUrl -ne $inputConfig.hookBaseUrl) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    $directory = Split-Path -Parent $exe
    $walk = Get-Item -LiteralPath $directory -Force
    while ($walk) { if ($walk.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }; $walk = $walk.Parent }
    if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne $inputConfig.expectedVersion) { Fail-Client 'WECHAT_CLIENT_VERSION_MISMATCH' }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { Fail-Client 'WECHAT_CLIENT_SIGNATURE_INVALID' }
    $build = Read-LocalJson (Join-Path $source 'state\hook\native\build.json')
    $dll = Join-Path $directory 'version.dll'
    if ($build.targetVersion -ne $inputConfig.expectedVersion -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.sha256) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    $media = Read-LocalJson (Join-Path $directory 'xiaozhushou-media-root.json')
    if ($media.version -ne 1 -or [IO.Path]::GetFullPath($media.dataRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($inputConfig.dataDir).TrimEnd('\')) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    $token = (Get-Content -LiteralPath (Join-Path $source 'state\hook\native-token.txt') -Raw -Encoding UTF8).Trim()
    $deployedToken = (Get-Content -LiteralPath (Join-Path $directory 'wechatagent-hook.token') -Raw -Encoding UTF8).Trim()
    if ($token -notmatch '^[a-f0-9]{64}$' -or $token -ne $deployedToken) { Fail-Client 'WECHAT_CLIENT_TOKEN_MISMATCH' }
    $url = [Uri]$inputConfig.hookBaseUrl
    if ($url.Scheme -ne 'http' -or $url.Host -ne '127.0.0.1' -or $url.AbsolutePath -ne '/' -or $url.Query -or $url.Fragment -or $url.UserInfo) { Fail-Client 'WECHAT_CLIENT_NOT_PREPARED' }
    $existing = @(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue)
    $others = @($existing | Where-Object { -not $_.Path -or $_.Path -ne $exe })
    if ($others.Count) {
        $otherVersion = if ($others[0].Path) { (Get-Item -LiteralPath $others[0].Path).VersionInfo.FileVersion } else { '' }
        @{ok=$false;code='WECHAT_OTHER_CLIENT_RUNNING';currentVersion=$otherVersion} | ConvertTo-Json -Compress
        exit 2
    }
    $started = $false
    if (-not $existing.Count) {
        if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq $url.Port).Count) { Fail-Client 'WECHAT_CLIENT_PORT_OCCUPIED' }
        # This window is interactive: the owner must be able to scan/confirm login.
        $client = Start-Process -FilePath $exe -ArgumentList ('StartPort='+$url.Port+' CallBackURL="http://127.0.0.1:'+ $project.ports.adapter + '/unused"') -WorkingDirectory $directory -WindowStyle Normal -PassThru
        $started = $true
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    do {
        $matching = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object Path -eq $exe)
        $health = $null
        try { $health = Invoke-RestMethod -Uri ($inputConfig.hookBaseUrl.TrimEnd('/')+'/WeChatAgent/health') -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 1 }
        catch { if ($_.Exception.Response.StatusCode -and [int]$_.Exception.Response.StatusCode -eq 401) { Fail-Client 'WECHAT_CLIENT_TOKEN_MISMATCH' } }
        if ($health) {
            if ([int]$health.pid -notin @($matching | ForEach-Object { [int]$_.Id })) { $matching = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) }
            if ($health.integration -ne 'WeChatAgent-1' -or $health.backend -ne 'wechat-hook' -or $health.version -ne $inputConfig.expectedVersion -or [int]$health.pid -notin @($matching | ForEach-Object { [int]$_.Id })) { Fail-Client 'WECHAT_CLIENT_IDENTITY_MISMATCH' }
            if ($health.startupState -eq 'ready') {
                if ($null -eq $health.databaseAccounts) { Fail-Client 'WECHAT_CLIENT_IDENTITY_MISMATCH' }
                if (@($health.databaseAccounts).Count -gt 1) { Fail-Client 'HOOK_MULTIPLE_ACCOUNT_DATABASES' }
                @{ok=$true;started=$started;loginRequired=(@($health.databaseAccounts).Count -eq 0)} | ConvertTo-Json -Compress
                exit 0
            }
        }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    Fail-Client 'WECHAT_CLIENT_HEALTH_TIMEOUT'
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^(WECHAT_CLIENT_[A-Z_]+|HOOK_MULTIPLE_ACCOUNT_DATABASES)$') { $code = 'WECHAT_CLIENT_NOT_PREPARED' }
    @{ok=$false;code=$code;stage=[int]$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress
    exit 1
}
