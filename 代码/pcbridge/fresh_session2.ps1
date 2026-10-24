# Detached: switch the private chat to a guaranteed-free session id (generation 19)
# and verify end-to-end with a real download request.
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 8,
  [int]$Generation = 19
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'fresh_session2.log'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$py = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
$state = 'G:\wechat-deepseek\data\workspace\state\accounts\28330caa72b639c40753bfa2400f8f17f3c191f1d00f33aaa509bbd00b6e0258\dsh-sessions.json'
$tokenFile = 'G:\wechat-deepseek\data\workspace\state\social-dsh-token.txt'
$sessBase = 'C:\Users\ADMIN\.dsh\sessions\--F-deepseek~5DE5~4F5C~533A--'

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Test-Port([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(900) -and $client.Connected) }
  catch { return $false } finally { $client.Dispose() }
}

function Stop-Dsh {
  Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 4
  }
}

Write-Log ("=== 切到空闲会话 generation=$Generation (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds

Write-Log '1) 停 DSH'
Stop-Dsh

Write-Log '2) 清映射 + 设置 generation'
& $py -c @"
import json
p = r'$state'
d = json.load(open(p, encoding='utf-8-sig'))
CHAT = 'wechat:private:1253808542'
old = d['conversations'].pop(CHAT, None)
prof = d.setdefault('profiles', {}).setdefault(CHAT, {})
prof['generation'] = $Generation
for f in ('cache','context'):
    prof.pop(f, None)
prof['initializations'] = 0
json.dump(d, open(p,'w',encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('retired:', old, '| generation ->', prof['generation'])
"@ | ForEach-Object { Write-Log ('   ' + $_) }

Write-Log '3) 启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 45
Write-Log ('   11230 = ' + (Test-Port 11230))

Write-Log '4) 端到端测试'
$tok = (Get-Content $tokenFile -Raw).Trim()
$body = '{"conversationKey":"wechat:private:1253808542","message":"测试电脑工具:把 arXiv 2401.00001 下载下来,用 export_file 发到微信私聊,一句话报告结果。"}'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11230/followup' -Method POST -Body $body `
    -ContentType 'application/json' -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 280
  Write-Log ('   followup ' + $r.StatusCode)
  Write-Log ('   回复: ' + $r.Content.Substring(0,[Math]::Min(700,$r.Content.Length)))
} catch {
  $detail = ''
  try { $detail = $_.ErrorDetails.Message } catch {}
  Write-Log ('   followup 失败: ' + $_.Exception.Message.Substring(0,[Math]::Min(120,$_.Exception.Message.Length)))
  Write-Log ('   详情: ' + $detail)
}
Write-Log '5) 新会话目录检查'
Get-ChildItem $sessBase -Directory -Filter 'social-*' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 2 |
  ForEach-Object { Write-Log ('   ' + $_.Name + '  ' + $_.LastWriteTime.ToString('HH:mm:ss')) }
Write-Log '=== 完成 ==='
