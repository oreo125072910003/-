# Send a local image into the open WeChat chat as a REAL picture message
# (clipboard paste + Enter), instead of a file attachment.
# Usage: powershell.exe -STA -File send_wechat_image_ui.ps1 -Image "C:\path\x.png" [-RatioX 0.66 -RatioY 0.83]
# ASCII only; converted to UTF-8 with BOM afterwards.
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [double]$RatioX = 0.66,
  [double]$RatioY = 0.83,
  [int]$WaitAfterPaste = 1400
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_WECHAT_WINDOW'; exit 1 }
$hwnd = $proc.MainWindowHandle

[W]::ShowWindow($hwnd, 9) | Out-Null
[W]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500

$rect = New-Object W+RECT
[W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output ("WINDOW " + $rect.Left + "," + $rect.Top + " " + $width + "x" + $height)

# Put the image on the clipboard (STA thread required).
$img = [System.Drawing.Image]::FromFile((Resolve-Path $Image))
[System.Windows.Forms.Clipboard]::SetImage($img)
Start-Sleep -Milliseconds 300
Write-Output ("CLIPBOARD " + [System.Windows.Forms.Clipboard]::ContainsImage())
$img.Dispose()

# Focus the message input box, then paste and send.
$absX = [int]($rect.Left + $width * $RatioX)
$absY = [int]($rect.Top + $height * $RatioY)
[W]::SetCursorPos($absX, $absY) | Out-Null
Start-Sleep -Milliseconds 200
[W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
[W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
Start-Sleep -Milliseconds 400

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $WaitAfterPaste
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 800
Write-Output 'SENT'
