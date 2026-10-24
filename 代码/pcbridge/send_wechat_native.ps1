# Send content into WeChat as a REAL message (image = picture, file = file message, text = text)
# via clipboard paste + Enter. Can switch to a target chat by name (Ctrl+F search) and verifies
# the open chat with a pixel fingerprint of its title, so it never pastes into the wrong place.
#
# Usage:
#   ... -CaptureTitle                                   # save reference fingerprint of the current chat
#   ... -CaptureTitle -TargetTitle "NAME" -SwitchChat   # switch to NAME first, then save its fingerprint
#   ... -Path x.png -Mode image [-TargetTitle "NAME" -SwitchChat]
#   ... -Path x.docx -Mode file [-TargetTitle "NAME" -SwitchChat]
#   ... -TextFile t.txt -Mode text [-TargetTitle "NAME" -SwitchChat]
#   ... -SkipTitleCheck                                  # bypass the guard
#
# ASCII only; converted to UTF-8 with BOM afterwards.
param(
  [string]$Path,
  [string]$TextFile,
  [string]$TargetTitle,
  [ValidateSet('image', 'file', 'text')][string]$Mode = 'image',
  [switch]$CaptureTitle,
  [switch]$SwitchChat,
  [switch]$SkipTitleCheck,
  [switch]$DryRun,
  [switch]$NormalizeWindow,
  [string]$SwitchTo = '',
  [int]$SelectRow = -1,
  [switch]$ScanRows,
  [string]$ScanOtherTitle = '',
  [switch]$NoSwitch,
  [int]$WaitAfterPaste = 1600
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-RefPath([string]$title) {
  if (-not $title) { return (Join-Path $here '_wx_title_ref.png') }
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($title)
  $hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
  return (Join-Path $here ('_wx_title_' + $hash.Substring(0, 10) + '.png'))
}

$script:WxWasTopmost = $false
function Set-Topmost([IntPtr]$hwnd, [bool]$on) {
  # 只调整 Z 序,绝不改窗口尺寸/位置:反复改变 Qt 窗口几何会触发渲染白屏
  $flags = 0x0043  # SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
  if ($on) {
    [void][W]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags)
    $script:WxWasTopmost = $true
  } else {
    [void][W]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, $flags)
    $script:WxWasTopmost = $false
  }
}

function Select-ChatRow([IntPtr]$hwnd, [int]$Index) {
  $r = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $x = [int]($r.Left + $w * 0.13)
  $y = [int]($r.Top + $h * 0.145 + $h * 0.089 * $Index)
  [void][W]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 250
  [W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 900
  Write-Output ("ROW_SELECTED " + $Index + " at " + $x + "," + $y)
}

function Force-Foreground([IntPtr]$hwnd) {
  [void][W]::ShowWindow($hwnd, 9)
  [void][W]::BringWindowToTop($hwnd)
  $fg = [W]::GetForegroundWindow()
  $fgPid = 0
  $fgThread = [W]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $myThread = [W]::GetCurrentThreadId()
  if ($fgThread -ne $myThread -and $fgThread -ne 0) {
    [void][W]::AttachThreadInput($myThread, $fgThread, $true)
    [void][W]::SetForegroundWindow($hwnd)
    [void][W]::AttachThreadInput($myThread, $fgThread, $false)
  } else {
    [void][W]::SetForegroundWindow($hwnd)
  }
  Start-Sleep -Milliseconds 500
}

function Switch-Chat([IntPtr]$hwnd, [string]$Name, [int]$W, [int]$H) {
  Force-Foreground $hwnd
  $rect = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $sx = [int]($rect.Left + $W * 0.18)
  $sy = [int]($rect.Top + $H * 0.075)
  [void][W]::SetCursorPos($sx, $sy)
  Start-Sleep -Milliseconds 250
  [W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait($Name)
  Start-Sleep -Milliseconds 1400
  # 点第一条搜索结果
  $rx = [int]($rect.Left + $W * 0.26)
  $ry = [int]($rect.Top + $H * 0.155)
  [void][W]::SetCursorPos($rx, $ry)
  Start-Sleep -Milliseconds 200
  [W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 1200
  Write-Output ('SWITCHED_TO ' + $Name)
}


function Set-FixedWindow([IntPtr]$hwnd, [int]$Width = 1000, [int]$Height = 760) {
  $r = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ([Math]::Abs($w - $Width) -le 4 -and [Math]::Abs($h - $Height) -le 4) { return }
  [W]::ShowWindow($hwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 300
  [void][W]::MoveWindow($hwnd, $r.Left, $r.Top, $Width, $Height, 1)
  Start-Sleep -Milliseconds 600
}


function Get-WeChatWindow {
  # 找真正的主聊天窗口(标题「微信」、尺寸 600x400 以上)。
  # 注意:微信 4.x 里 Get-Process 的 MainWindowHandle 指向一个 176x199 的隐藏辅助窗口
  # (标题 "Weixin"),绝不能用它做发送/截图 —— 之前大量「白屏 / 标题校验不过」就是拿到这个窗口。
  # 恢复窗口一律用 ShowWindow(SW_RESTORE/SW_SHOW),绝不 SetWindowPos 改几何:改几何会触发 Qt 渲染白屏。
  $wxPids = @(Get-Process Weixin -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
  if ($wxPids.Count -eq 0) { return $null }
  $script:Candidates = New-Object System.Collections.ArrayList
  $callback = [W+EnumWindowsProc]{
    param($hWnd, $lParam)
    $winPid = 0
    [void][W]::GetWindowThreadProcessId($hWnd, [ref]$winPid)
    if ($wxPids -contains [int]$winPid) {
      $sb = New-Object System.Text.StringBuilder 256
      [void][W]::GetWindowTextW($hWnd, $sb, 256)
      $title = $sb.ToString()
      $rect = New-Object W+RECT
      [void][W]::GetWindowRect($hWnd, [ref]$rect)
      $area = ([int]$rect.Right - [int]$rect.Left) * ([int]$rect.Bottom - [int]$rect.Top)
      [void]$script:Candidates.Add([pscustomobject]@{ Handle = $hWnd; Area = $area; Title = $title })
    }
    return $true
  }
  [void][W]::EnumWindows($callback, [IntPtr]::Zero)
  # 1) 只认标题为「微信」的窗口;先试已经正常显示的大窗口
  $qt = @($script:Candidates | Where-Object { $_.Title -eq '微信' } | Sort-Object Area -Descending)
  foreach ($cand in $qt) {
    if ($cand.Area -lt 100000) { continue }
    [void][W]::ShowWindow($cand.Handle, 9)
    [void][W]::ShowWindow($cand.Handle, 5)
    [void][W]::SetForegroundWindow($cand.Handle)
    Start-Sleep -Milliseconds 700
    $r2 = New-Object W+RECT
    [void][W]::GetWindowRect($cand.Handle, [ref]$r2)
    $w2 = [int]$r2.Right - [int]$r2.Left; $h2 = [int]$r2.Bottom - [int]$r2.Top
    if ([W]::IsWindowVisible($cand.Handle) -and $w2 -ge 600 -and $h2 -ge 400) { return $cand.Handle }
  }
  # 2) 主窗口被最小化到托盘(rect 在 -32000)时恢复它,恢复后再验证尺寸
  foreach ($cand in $qt) {
    [void][W]::ShowWindow($cand.Handle, 9)
    [void][W]::ShowWindow($cand.Handle, 5)
    [void][W]::SetForegroundWindow($cand.Handle)
    Start-Sleep -Milliseconds 900
    $r3 = New-Object W+RECT
    [void][W]::GetWindowRect($cand.Handle, [ref]$r3)
    $w3 = [int]$r3.Right - [int]$r3.Left; $h3 = [int]$r3.Bottom - [int]$r3.Top
    if ([W]::IsWindowVisible($cand.Handle) -and $w3 -ge 600 -and $h3 -ge 400) { return $cand.Handle }
  }
  return $null
}

function Test-WindowBlank([IntPtr]$hwnd) {
  # 白屏判定:在左侧会话列表区域取 3 个采样块。正常时那里有头像/文字,近白比例很低;
  # 整窗白屏时几乎全白。不能看聊天区,聊天区本来就是白底。
  try {
    $rect = New-Object W+RECT
    [W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    if ($w -lt 300 -or $h -lt 300) { return $false }
    $white = 0; $total = 0
    foreach ($fy in @(0.25, 0.5, 0.75)) {
      $sx = $rect.Left + [int]($w * 0.05)
      $sy = $rect.Top + [int]($h * $fy)
      $bmp = New-Object System.Drawing.Bitmap(60, 30)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($sx, $sy, 0, 0, $bmp.Size)
      $g.Dispose()
      for ($y = 0; $y -lt 30; $y += 3) {
        for ($x = 0; $x -lt 60; $x += 3) {
          $c = $bmp.GetPixel($x, $y)
          if ($c.R -ge 245 -and $c.G -ge 245 -and $c.B -ge 245) { $white++ }
          $total++
        }
      }
      $bmp.Dispose()
    }
    return ($total -gt 0 -and ($white / $total) -ge 0.90)
  } catch { return $false }
}

function Repair-BlankWindow([IntPtr]$hwnd) {
  # 白屏时尝试不动进程的恢复:最小化→还原、隐藏→显示(绝不改窗口几何,改几何会加重 Qt 白屏)
  [void][W]::ShowWindow($hwnd, 6)
  Start-Sleep -Milliseconds 500
  [void][W]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 700
  [void][W]::ShowWindow($hwnd, 0)
  Start-Sleep -Milliseconds 400
  [void][W]::ShowWindow($hwnd, 5)
  Start-Sleep -Milliseconds 900
  Set-Topmost $hwnd $true
  Force-Foreground $hwnd
  Start-Sleep -Milliseconds 500
  return (-not (Test-WindowBlank $hwnd))
}

function Get-TitleBitmap([IntPtr]$hwnd) {
  $rect = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  # 用固定像素区域,不要按窗口尺寸比例算:窗口高度差 1px 会让裁剪高度在 41/42 之间跳,
  # 和基准图尺寸不一致就永远匹配不上。标题栏高度、会话列表宽度在微信里是固定的。
  $x = [int]($rect.Left + 300)
  $y = [int]($rect.Top + 38)
  $tw = 260
  $th = 42
  if ($x + $tw -gt $rect.Right) { $tw = [Math]::Max(120, $rect.Right - $x - 2) }
  if ($y + $th -gt $rect.Bottom) { $th = [Math]::Max(20, $rect.Bottom - $y - 2) }
  $bmp = New-Object System.Drawing.Bitmap($tw, $th)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $g.Dispose()
  return @{ Bitmap = $bmp; Rect = $rect; Width = $w; Height = $h }
}

function Get-Thumb([System.Drawing.Bitmap]$bmp) {
  $small = New-Object System.Drawing.Bitmap(192, 48)
  $g = [System.Drawing.Graphics]::FromImage($small)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
  $g.DrawImage($bmp, 0, 0, 192, 48)
  $g.Dispose()
  $values = New-Object 'int[]' (192 * 48)
  $index = 0
  for ($y = 0; $y -lt 48; $y++) {
    for ($x = 0; $x -lt 192; $x++) {
      $c = $small.GetPixel($x, $y)
      $values[$index] = [int](($c.R * 30 + $c.G * 59 + $c.B * 11) / 100)
      $index++
    }
  }
  $small.Dispose()
  return $values
}

function Measure-TitleDiff([IntPtr]$hwnd, [string]$refPath) {
  if (-not (Test-Path -LiteralPath $refPath)) { return -1 }
  $shot = Get-TitleBitmap $hwnd
  $ref = [System.Drawing.Bitmap]::FromFile($refPath)
  $sw = $shot.Bitmap.Width; $sh = $shot.Bitmap.Height
  # 参考图尺寸不同时按最近邻缩放到当前尺寸
  if ($ref.Width -ne $sw -or $ref.Height -ne $sh) {
    $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
    $g2 = [System.Drawing.Graphics]::FromImage($scaled)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g2.DrawImage($ref, 0, 0, $sw, $sh)
    $g2.Dispose()
    $ref.Dispose()
    $ref = $scaled
  }
  # 原分辨率逐像素(隔点采样)比较,不做降采样
  $sum = 0; $count = 0
  for ($y = 0; $y -lt $sh; $y += 2) {
    for ($x = 0; $x -lt $sw; $x += 2) {
      $ca = $shot.Bitmap.GetPixel($x, $y)
      $cb = $ref.GetPixel($x, $y)
      $ga = [int](($ca.R * 30 + $ca.G * 59 + $ca.B * 11) / 100)
      $gb = [int](($cb.R * 30 + $cb.G * 59 + $cb.B * 11) / 100)
      $sum += [Math]::Abs($ga - $gb)
      $count++
    }
  }
  $diff = if ($count) { [Math]::Round($sum / $count, 1) } else { -1 }
  $ref.Dispose()
  $shot.Bitmap.Dispose()
  return $diff
}

# Switch the open conversation to the one whose search name is $title.
function Switch-ToChat([IntPtr]$hwnd, [string]$title) {
  [W]::ShowWindow($hwnd, 9) | Out-Null
  [W]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 500
  # 先关掉可能还开着的搜索面板,否则 ^f 可能只是收起面板、粘贴落空
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Start-Sleep -Milliseconds 350
  [System.Windows.Forms.SendKeys]::SendWait('^f')
  Start-Sleep -Milliseconds 900
  # 清空搜索框里上一次的残留内容,否则会跳回上一个会话
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE}')
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.Clipboard]::SetText($title)
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 2600
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 2200
}

$hwnd = Get-WeChatWindow
if (-not $hwnd) { Write-Output 'NO_WECHAT_WINDOW'; exit 1 }
# 先置前再采样:窗口被别的程序遮住时,CopyFromScreen 会把别人的窗口当成微信画面,误判白屏
Set-Topmost $hwnd $true
Force-Foreground $hwnd
Start-Sleep -Milliseconds 600
$wr0 = New-Object W+RECT
[void][W]::GetWindowRect($hwnd, [ref]$wr0)
Write-Output ('WINDOW_FOUND ' + ([int]$wr0.Right - [int]$wr0.Left) + 'x' + ([int]$wr0.Bottom - [int]$wr0.Top))
# 白屏检测:如果整个窗口是白的(Qt/GPU 渲染失效),先尝试无损恢复;恢复不了就快速失败,不要傻等重试
if (Test-WindowBlank $hwnd) {
  Write-Output 'WINDOW_BLANK_DETECTED'
  $repaired = Repair-BlankWindow $hwnd
  Write-Output ('WINDOW_BLANK_REPAIR ' + $repaired)
  if (-not $repaired) { Write-Output 'WINDOW_BLANK'; exit 9 }
}
if ($NormalizeWindow) {
  # 只置前,不改窗口尺寸/位置(改几何会触发白屏)
  Set-Topmost $hwnd $true
  Force-Foreground $hwnd
  Start-Sleep -Milliseconds 800
  Write-Output 'WINDOW_FOREGROUNDED'
}
if ($SelectRow -ge 0) {
  Select-ChatRow $hwnd $SelectRow
}
if ($SwitchTo) {
  $wr = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$wr) | Out-Null
  Switch-Chat $hwnd $SwitchTo ($wr.Right - $wr.Left) ($wr.Bottom - $wr.Top)
}

$refPath = Get-RefPath $TargetTitle

# -ScanRows: 逐行点选会话,用标题像素校验命中目标聊天后,再粘贴发送。
# 全部在一个进程内完成,避免列表顺序变化导致发错。
if ($ScanRows) {
  # 先把会话列表滚到顶部,保证第 0 行就是最新的置顶会话
  $r0 = New-Object W+RECT
  [W]::GetWindowRect($hwnd, [ref]$r0) | Out-Null
  $w0 = $r0.Right - $r0.Left; $h0 = $r0.Bottom - $r0.Top
  [void][W]::SetCursorPos([int]($r0.Left + $w0 * 0.13), [int]($r0.Top + $h0 * 0.45))
  Start-Sleep -Milliseconds 200
  for ($k = 0; $k -lt 5; $k++) {
    [W]::mouse_event(0x0800, 0, 0, 120, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
  }
  Start-Sleep -Milliseconds 500
  $found = -1
  $otherRef = ''
  if ($ScanOtherTitle) { $otherRef = Get-RefPath $ScanOtherTitle }
  for ($i = 0; $i -lt 8; $i++) {
    # 先测量当前窗口:如果目标会话已经是打开状态,不要再点它
    # (微信里对已选中的会话行再点一次会把聊天面板点成空白页)
    $d = Measure-TitleDiff $hwnd $refPath
    $do = -1
    if ($otherRef -and (Test-Path -LiteralPath $otherRef)) { $do = Measure-TitleDiff $hwnd $otherRef }
    $accept = ($d -ge 0 -and $d -le 3)
    if ($accept -and $do -ge 0) { $accept = (($do - $d) -ge 5) }
    if ($accept) {
      Write-Output ('SCAN current diff ' + $d + ' other ' + $do + ' (already open)')
      $found = $i
      break
    }
    Select-ChatRow $hwnd $i
    $d = Measure-TitleDiff $hwnd $refPath
    $do = -1
    if ($otherRef -and (Test-Path -LiteralPath $otherRef)) { $do = Measure-TitleDiff $hwnd $otherRef }
    Write-Output ('SCAN row ' + $i + ' diff ' + $d + ' other ' + $do)
    $accept = ($d -ge 0 -and $d -le 3)
    if ($accept -and $do -ge 0) { $accept = (($do - $d) -ge 5) }
    if ($accept) {
      # 二次确认,避免点完的瞬间还没渲染完
      Start-Sleep -Milliseconds 350
      $d2 = Measure-TitleDiff $hwnd $refPath
      if ($d2 -ge 0 -and $d2 -le 5) { $found = $i; break }
    }
  }
  if ($found -lt 0) {
    Set-Topmost $hwnd $false
    Write-Output 'SCAN_NO_MATCH'
    exit 4
  }
  $SkipTitleCheck = $true
  Write-Output ('SCAN_MATCH row ' + $found)
}


if ($CaptureTitle) {
  if ($TargetTitle -and $SwitchChat) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      Switch-ToChat $hwnd $TargetTitle
      Write-Output ('SWITCHED ' + $TargetTitle + ' attempt ' + $attempt)
      # 校验:切换后画面若和别的已知聊天指纹一致,说明搜索没切换成功,不要保存错误指纹
      $dups = @()
      Get-ChildItem -LiteralPath $here -Filter '_wx_title_*.png' | ForEach-Object {
        if ($_.FullName -ne $refPath) {
          $dd = Measure-TitleDiff $hwnd $_.FullName
          if ($dd -ge 0 -and $dd -le 3) { $dups += ($_.Name + '=' + $dd) }
        }
      }
      if ($dups.Count -eq 0) { break }
      Write-Output ('TITLE_REF_DUPLICATE_ATTEMPT ' + $attempt + ' ' + ($dups -join ','))
      if ($attempt -eq 2) {
        Set-Topmost $hwnd $false
        exit 5
      }
    }
  }
  $shot = Get-TitleBitmap $hwnd
  $shot.Bitmap.Save($refPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ('TITLE_REF_SAVED ' + $refPath + ' ' + $shot.Bitmap.Width + 'x' + $shot.Bitmap.Height)
  $shot.Bitmap.Dispose()
  exit 0
}

$Threshold = 26

# 只测量不动作:给校准用(不需要 Path)
if ($NoSwitch) {
  $mdiff = Measure-TitleDiff $hwnd $refPath
  $probe = Get-TitleBitmap $hwnd
  Write-Output ('TITLE_DIFF ' + $mdiff)
  Write-Output ('CROP ' + $probe.Bitmap.Width + 'x' + $probe.Bitmap.Height)
  $probe.Bitmap.Dispose()
  exit 0
}

if (-not $DryRun) {
  if ($Mode -eq 'text') {
    if (-not $TextFile) { Write-Output 'NO_TEXT_FILE'; exit 1 }
    if (-not (Test-Path -LiteralPath $TextFile)) { Write-Output 'TEXT_FILE_NOT_FOUND'; exit 1 }
    $full = (Resolve-Path -LiteralPath $TextFile).Path
  } else {
    if (-not $Path) { Write-Output 'NO_PATH'; exit 1 }
    if (-not (Test-Path -LiteralPath $Path)) { Write-Output 'PATH_NOT_FOUND'; exit 1 }
    $full = (Resolve-Path -LiteralPath $Path).Path
  }
}

# --- make sure the right chat is open (switch if needed, then re-verify) ---
$diff = -1
if (-not $SkipTitleCheck) {
  $diff = Measure-TitleDiff $hwnd $refPath
  if ($diff -lt 0 -or $diff -gt $Threshold) {
    if ($TargetTitle -and $SwitchChat) {
      Switch-ToChat $hwnd $TargetTitle
      Write-Output ('SWITCHED ' + $TargetTitle)
      $diff = Measure-TitleDiff $hwnd $refPath
      if ($diff -lt 0 -or $diff -gt $Threshold) {
        # 第一次没切准,再试一次
        Switch-ToChat $hwnd $TargetTitle
        Write-Output ('SWITCHED_RETRY ' + $TargetTitle)
        $diff = Measure-TitleDiff $hwnd $refPath
      }
    }
  }
  Write-Output ('TITLE_DIFF ' + $diff)
  $probe = Get-TitleBitmap $hwnd
  Write-Output ('CROP ' + $probe.Bitmap.Width + 'x' + $probe.Bitmap.Height)
  $probe.Bitmap.Dispose()
  if ($diff -lt 0 -or $diff -gt $Threshold) { Write-Output 'TITLE_MISMATCH'; exit 3 }
} else {
  Write-Output 'TITLE_DIFF skipped'
}

if ($DryRun) { Write-Output 'DRYRUN_OK'; exit 0 }

$shot = Get-TitleBitmap $hwnd

# --- clipboard ---
if ($Mode -eq 'text') {
  $text = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
  if (-not $text.Trim()) { Write-Output 'EMPTY_TEXT'; exit 4 }
  [System.Windows.Forms.Clipboard]::SetText($text)
  Start-Sleep -Milliseconds 300
} elseif ($Mode -eq 'image') {
  $img = [System.Drawing.Image]::FromFile($full)
  [System.Windows.Forms.Clipboard]::SetImage($img)
  $img.Dispose()
  if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { Write-Output 'CLIPBOARD_FAILED'; exit 4 }
} else {
  $list = New-Object System.Collections.Specialized.StringCollection
  [void]$list.Add($full)
  [System.Windows.Forms.Clipboard]::SetFileDropList($list)
  if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { Write-Output 'CLIPBOARD_FAILED'; exit 4 }
}
Start-Sleep -Milliseconds 300

# --- focus input, paste, send ---
Force-Foreground $hwnd
Start-Sleep -Milliseconds 200
$absX = [int]($shot.Rect.Left + $shot.Width * 0.55)
$absY = [int]($shot.Rect.Top + $shot.Height * 0.62)
[W]::SetCursorPos($absX, $absY) | Out-Null
Start-Sleep -Milliseconds 200
[W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
# 先清空输入框里可能残留的文字
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{DELETE}')
Start-Sleep -Milliseconds 250

[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $WaitAfterPaste
$rr = New-Object W+RECT
[W]::GetWindowRect($hwnd, [ref]$rr) | Out-Null
$ww = $rr.Right - $rr.Left; $hh = $rr.Bottom - $rr.Top
$sendX = [int]($rr.Left + $ww * 0.937)
$sendY = [int]($rr.Top + $hh * 0.945)
[void][W]::SetCursorPos($sendX, $sendY)
Start-Sleep -Milliseconds 250
[W]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[W]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 1600
Set-Topmost $hwnd $false
Write-Output ('SENT ' + $Mode + ' ' + $full + ' at click ' + $absX + ',' + $absY + ' sendBtn ' + $sendX + ',' + $sendY)
$shot.Bitmap.Dispose()
