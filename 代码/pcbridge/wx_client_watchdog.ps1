# Keep the hooked WeChat client (4.1.10.27) alive.
# - starts it when no Weixin.exe is running
# - restarts it when the hook port 30001 stays closed for too long
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$IntervalSec = 20,
  [int]$HookPort = 30001,
  [string]$LogFile = 'F:\deepseek工作区\wechat-pc-bridge\wx_watchdog.log'
)

$ErrorActionPreference = 'Continue'
$exe = 'G:\wechat-deepseek\data\workspace\state\hook\wechat-4.1.10.27\Weixin.exe'
$workdir = Split-Path -Parent $exe
$startArgs = 'StartPort=' + $HookPort + ' CallBackURL="http://127.0.0.1:11229/unused"'

function Write-Log([string]$msg) {
  $line = (Get-Date -Format 'MM-dd HH:mm:ss') + '  ' + $msg
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Test-HookPort {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $HookPort -State Listen -ErrorAction SilentlyContinue)
  } catch { return $false }
}

function Start-Client([string]$reason) {
  try {
    Start-Process -FilePath $exe -ArgumentList $startArgs -WorkingDirectory $workdir `
      -RedirectStandardOutput 'F:\deepseek工作区\wechat-pc-bridge\wx_client.out.log' `
      -RedirectStandardError 'F:\deepseek工作区\wechat-pc-bridge\wx_client.err.log'
    Write-Log ("start client: " + $reason)
  } catch {
    Write-Log ("start failed: " + $_.Exception.Message)
  }
}

Write-Log ("watchdog started, interval=" + $IntervalSec + "s port=" + $HookPort)
$lastStart = Get-Date
$hookDownSince = $null

while ($true) {
  $procs = @(Get-Process Weixin -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    if (((Get-Date) - $lastStart).TotalSeconds -gt 15) {
      Start-Client 'no Weixin.exe'
      $lastStart = Get-Date
      $hookDownSince = $null
    }
    Start-Sleep -Seconds 5
    continue
  }

  if (-not (Test-HookPort)) {
    if ($null -eq $hookDownSince) { $hookDownSince = Get-Date }
    elseif (((Get-Date) - $hookDownSince).TotalSeconds -gt 90) {
      Write-Log 'hook port closed >90s, restarting client'
      foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }
      Start-Sleep -Seconds 4
      Start-Client 'hook stuck'
      $lastStart = Get-Date
      $hookDownSince = $null
    }
  } else {
    $hookDownSince = $null
  }

  Start-Sleep -Seconds $IntervalSec
}
