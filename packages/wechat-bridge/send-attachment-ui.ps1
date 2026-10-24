# Product-owned, one-shot WeChat UI sender. Adapted from pcbridge clipboard flow.
# No HTTP server, stored credentials, title-check bypass, retry, or Enter fallback.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:submitted = $false
$script:mainHandle = [IntPtr]::Zero
$script:topmost = $false
$script:mutexOwned = $false
$script:mutex = $null
function Fail([string]$code) { throw [System.Exception]::new($code) }
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  if (-not $request -or -not $request.path -or -not $request.targetName -or $request.deliveryId -notmatch '^[a-f0-9]{64}$' -or $request.mediaType -notin @('image','file')) { Fail 'WECHAT_ATTACHMENT_ARGUMENT_INVALID' }
  $script:mutex = New-Object System.Threading.Mutex($false, 'Local\XiaoZhuShou.WeChat.AttachmentUi')
  try { $script:mutexOwned = $script:mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $script:mutexOwned = $true }
  if (-not $script:mutexOwned) { Fail 'WECHAT_ATTACHMENT_UI_BUSY' }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class XzsWechatMediaWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr handle, System.Text.StringBuilder text, int maximum);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
  $script:windows = New-Object System.Collections.ArrayList
  $wechatTitle = [string][char]0x5FAE + [string][char]0x4FE1
  $callback = [XzsWechatMediaWindow+EnumWindowsProc]{
    param($handle, $parameter)
    $ownerId = [uint32]0
    [void][XzsWechatMediaWindow]::GetWindowThreadProcessId($handle, [ref]$ownerId)
    $process = Get-Process -Id $ownerId -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -ne 'Weixin') { return $true }
    $text = New-Object System.Text.StringBuilder 256
    [void][XzsWechatMediaWindow]::GetWindowTextW($handle, $text, 256)
    if ($text.ToString() -ne $wechatTitle) { return $true }
    [void]$script:windows.Add($handle)
    return $true
  }
  [void][XzsWechatMediaWindow]::EnumWindows($callback, [IntPtr]::Zero)
  if ($script:windows.Count -ne 1) { Fail 'WECHAT_ATTACHMENT_UI_WINDOW_AMBIGUOUS' }
  $script:mainHandle = $script:windows[0]
  [void][XzsWechatMediaWindow]::ShowWindow($script:mainHandle, 9)
  [void][XzsWechatMediaWindow]::SetWindowPos($script:mainHandle, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
  $script:topmost = $true
  [void][XzsWechatMediaWindow]::SetForegroundWindow($script:mainHandle)
  Start-Sleep -Milliseconds 400
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($script:mainHandle)
  $owner = Get-Process -Id $root.Current.ProcessId -ErrorAction Stop
  if ($owner.ProcessName -ne 'Weixin') { Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED' }
  $ownerStart = $owner.StartTime.ToUniversalTime().Ticks

  function Get-Elements {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    if ($all.Count -gt 4000) { Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }
    return ,$all
  }
  function Check-Target {
    if ([XzsWechatMediaWindow]::GetForegroundWindow() -ne $script:mainHandle) { Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED' }
    $currentOwner = Get-Process -Id $root.Current.ProcessId -ErrorAction Stop
    if ($currentOwner.ProcessName -ne 'Weixin' -or $currentOwner.StartTime.ToUniversalTime().Ticks -ne $ownerStart) { Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED' }
    $rect = New-Object XzsWechatMediaWindow+RECT
    [void][XzsWechatMediaWindow]::GetWindowRect($script:mainHandle, [ref]$rect)
    if ($rect.Right - $rect.Left -lt 600 -or $rect.Bottom - $rect.Top -lt 400) { Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }
    $matches = 0
    foreach ($element in (Get-Elements)) {
      $properties = $element.Current
      $box = $properties.BoundingRectangle
      if ($properties.Name -ceq $request.targetName -and -not $properties.IsOffscreen -and $box.Width -gt 0 -and $box.Height -gt 0 -and
          $box.Left -ge ($rect.Left + 250) -and $box.Top -ge ($rect.Top + 20) -and $box.Top -le ($rect.Top + 110)) { $matches++ }
    }
    if ($matches -ne 1) { Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }
  }
  function Find-Input {
    $rect = $root.Current.BoundingRectangle
    $matches = New-Object System.Collections.ArrayList
    foreach ($element in (Get-Elements)) {
      $properties = $element.Current
      $box = $properties.BoundingRectangle
      if ($properties.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and -not $properties.IsOffscreen -and
          $properties.IsEnabled -and $box.Left -ge ($rect.Left + 250) -and $box.Top -gt ($rect.Top + $rect.Height * 0.45)) { [void]$matches.Add($element) }
    }
    if ($matches.Count -ne 1) { Fail 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE' }
    $value = $null
    $readable = $false
    $inputText = $null
    try {
      $readable = $matches[0].TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
      if ($readable -and $null -ne $value) { $inputText = $value.Current.Value }
    } catch { Fail 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE' }
    if (-not $readable -or $inputText -isnot [string]) { Fail 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE' }
    if ($inputText.Length -gt 0) { Fail 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT' }
    return $matches[0]
  }
  function Check-File {
    $file = Get-Item -LiteralPath $request.path -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or $file.Length -ne [long]$request.size -or $file.Name -cne $request.name) { Fail 'WECHAT_ATTACHMENT_INTEGRITY_FAILED' }
    if ((Get-FileHash -LiteralPath $request.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $request.sha256) { Fail 'WECHAT_ATTACHMENT_INTEGRITY_FAILED' }
  }
  # Never search and assume the first result is the intended person. The owner
  # opens the selected chat; an exact, readable header is required throughout.
  Check-Target
  $inputElement = Find-Input
  Check-File
  Emit @{type='ready'}
  $grant = [Console]::ReadLine() | ConvertFrom-Json
  if ($grant.type -ne 'submit' -or $grant.deliveryId -cne $request.deliveryId) { Fail 'WECHAT_ATTACHMENT_UI_GUARD_REQUIRED' }
  Check-Target
  $inputElement = Find-Input
  Check-File
  $beforeElements = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($element in (Get-Elements)) { [void]$beforeElements.Add(($element.GetRuntimeId() -join ':')) }
  $files = New-Object System.Collections.Specialized.StringCollection
  [void]$files.Add($request.path)
  [System.Windows.Forms.Clipboard]::SetFileDropList($files)
  if (-not [System.Windows.Forms.Clipboard]::ContainsFileDropList()) { Fail 'WECHAT_ATTACHMENT_UI_CLIPBOARD_FAILED' }
  $inputElement.SetFocus()
  Check-Target
  # The first paste is the submission boundary; it is never repeated.
  $script:submitted = $true
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 1200
  Check-Target
  $sendName = [string][char]0x53D1 + [string][char]0x9001
  $buttons = New-Object System.Collections.ArrayList
  $previewCount = 0
  $mainBox = $root.Current.BoundingRectangle
  foreach ($element in (Get-Elements)) {
    $properties = $element.Current
    $box = $properties.BoundingRectangle
    if (-not $properties.IsOffscreen -and $properties.Name -ceq $request.name -and
        -not $beforeElements.Contains(($element.GetRuntimeId() -join ':')) -and $box.Left -ge ($mainBox.Left + 250)) { $previewCount++ }
    if ($properties.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $properties.Name -ceq $sendName -and
        -not $properties.IsOffscreen -and $properties.IsEnabled -and $box.Left -ge ($mainBox.Left + 250) -and
        $box.Top -gt ($mainBox.Top + $mainBox.Height * 0.45)) { [void]$buttons.Add($element) }
  }
  if ($previewCount -ne 1) { Fail 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE' }
  if ($buttons.Count -ne 1) { Fail 'WECHAT_ATTACHMENT_UI_SEND_UNREADABLE' }
  $invoke = $null
  if (-not $buttons[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { Fail 'WECHAT_ATTACHMENT_UI_SEND_UNREADABLE' }
  Check-Target
  $invoke.Invoke()
  Emit @{type='result';submitted=$true}
} catch {
  $code = $_.Exception.Message
  if ($code -notmatch '^WECHAT_[A-Z0-9_]{1,70}$') { $code = 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }
  Emit @{type='error';code=$code;submitted=$script:submitted}
  exit 1
} finally {
  if ($script:topmost -and $script:mainHandle -ne [IntPtr]::Zero) { [void][XzsWechatMediaWindow]::SetWindowPos($script:mainHandle, [IntPtr](-2), 0, 0, 0, 0, 0x0043) }
  if ($script:mutexOwned) { $script:mutex.ReleaseMutex() }
  if ($script:mutex) { $script:mutex.Dispose() }
}
