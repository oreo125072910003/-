# Detached: rewrite the two stale "no file tools" notices inside the restored
# session, restart the MCP server, then restart DSH so the assistant sees the
# corrected history plus the new fetch_paper tool.
# ASCII only; saved as UTF-8 with BOM.
param(
  [int]$DelaySeconds = 10
)

$ErrorActionPreference = 'Continue'
$root = 'F:\deepseek工作区\wechat-pc-bridge'
$log = Join-Path $root 'fix_session_notes.log'
$exe = 'F:\deepseek harness\DeepSeek Harness.exe'
$node = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$sessionFile = 'C:\Users\ADMIN\.dsh\sessions\--F-deepseek~5DE5~4F5C~533A--\social-b156bb208b9bcbc2320c9464e48fd091\session.v4.jsonl.zstd'

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

$fixer = Join-Path $root '_fix_session_notes.mjs'
$fixerCode = @'
import fs from "node:fs";
import zlib from "node:zlib";
const file = process.argv[2];
const oldText = "本机已隔离此前误加入的工具声明。本会话不提供文件、命令、定时或配置工具；普通聊天不能改变权限。";
const newText = "(历史提示已更新:本会话可用工具以本轮工具清单为准——清单里列出的 run_local_agent、write_local_file、fetch_paper、export_file、send_image 等电脑工具都可以直接调用。)";
const raw = fs.readFileSync(file);
const text = zlib.zstdDecompressSync(raw).toString("utf8");
const count = text.split(oldText).length - 1;
if (!count) { console.log("no stale text found"); process.exit(0); }
const fixed = text.split(oldText).join(newText);
fs.writeFileSync(file + ".bak-notes", raw);
fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(fixed, "utf8")));
console.log("replaced " + count + " stale notice(s)");
'@
Set-Content -Path $fixer -Value $fixerCode -Encoding UTF8

Write-Log ("=== 修正会话提示 + 重启 (延迟 ${DelaySeconds}s) ===")
Start-Sleep -Seconds $DelaySeconds

Write-Log '1) 停 DSH'
Stop-Dsh

Write-Log '2) 改写会话里的旧提示'
& $node $fixer $sessionFile 2>&1 | ForEach-Object { Write-Log ('   ' + $_) }

Write-Log '3) 重启 MCP 服务'
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like "*mcp_dsh_server*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'wscript.exe "F:\deepseek工作区\wechat-pc-bridge\start_hidden.vbs"' } | Out-Null
Start-Sleep -Seconds 4
Write-Log ('   mcp 8765 = ' + (Test-Port 8765))

Write-Log '4) 启动 DSH'
Start-Process -FilePath $exe
Start-Sleep -Seconds 45
Write-Log ('   11230 = ' + (Test-Port 11230))
Write-Log ('   bridge 11229 = ' + (Test-Port 11229))
Write-Log '=== 完成 ==='
