# Send files to the WeChat private chat one at a time, verifying each in the local DB.
# Retries once per file. ASCII only; saved as UTF-8 with BOM afterwards.
param(
  [string[]]$Files,
  [string]$TargetTitle = "奥利奥偷工减料",
  [int]$GapSeconds = 8,
  [int]$MaxAttempts = 2
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'send_files.log'
$script = Join-Path $root 'send_wechat_native.ps1'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Count-FileMessages {
  $code = @'
import json, urllib.request, urllib.parse
base='http://127.0.0.1:5031'; tok='REDACTED_TOKEN'
q=urllib.request.Request(base+'/api/v1/messages?talker=wxid_h0t6y5w6yke022&limit=10', headers={'Authorization':'Bearer '+tok})
d=json.loads(urllib.request.urlopen(q, timeout=10).read().decode())
print(sum(1 for m in (d.get('messages') or []) if int(m.get('localType') or 0)==25769803825 and int(m.get('createTime') or 0) >= START))
'@
  return $code
}

foreach ($f in $Files) {
  if (-not (Test-Path -LiteralPath $f)) { Write-Log ("MISSING " + $f); continue }
  $name = Split-Path $f -Leaf
  $sizeMB = [math]::Round((Get-Item $f).Length / 1MB, 2)
  $ok = $false
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $start = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - 1
    Write-Log ("send $name ($sizeMB MB) attempt $attempt start=$start")
    & powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File $script `
      -NormalizeWindow -ScanRows -ScanOtherTitle "群里只有一个好人" -Path $f -Mode file -TargetTitle $TargetTitle 2>&1 |
      ForEach-Object { Write-Log ('  ' + $_) }
    Start-Sleep -Seconds 6
    $pyCode = @"
import json, urllib.request
base='http://127.0.0.1:5031'; tok='REDACTED_TOKEN'
q=urllib.request.Request(base+'/api/v1/messages?talker=wxid_h0t6y5w6yke022&limit=10', headers={'Authorization':'Bearer '+tok})
d=json.loads(urllib.request.urlopen(q, timeout=10).read().decode())
n=sum(1 for m in (d.get('messages') or []) if int(m.get('localType') or 0)==25769803825 and int(m.get('createTime') or 0) >= $start)
print('NEWFILE', n)
"@
    $out = & $py -X utf8 -c $pyCode 2>&1 | Out-String
    Write-Log ('  check: ' + $out.Trim())
    if ($out -match 'NEWFILE ([1-9])') { $ok = $true; break }
    Start-Sleep -Seconds 3
  }
  Write-Log ("RESULT $name -> " + $(if ($ok) { 'DELIVERED' } else { 'FAILED' }))
  Start-Sleep -Seconds $GapSeconds
}
Write-Log '=== done ==='
