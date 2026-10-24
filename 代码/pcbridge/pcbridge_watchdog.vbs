Dim sh, cmd
Set sh = CreateObject("WScript.Shell")
cmd = "C:\Users\ADMIN\.dsh\local-fixes\powershell-7.6.5\pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""F:\deepseek工作区\wechat-pc-bridge\pcbridge_watchdog_loop.ps1"""
sh.Run cmd, 0, False
