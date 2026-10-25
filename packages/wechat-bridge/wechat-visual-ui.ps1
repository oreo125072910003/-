# Local compatibility adapter for WeChat 4.1.10.27's inaccessible Qt surface.
# Loaded by the fixed sender, never an endpoint or a model supplied script.
function Initialize-VisualRecognition {
  Add-Type -AssemblyName System.Drawing, System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $language = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $script:ocr) { Fail 'WECHAT_ATTACHMENT_UI_OCR_UNAVAILABLE' }
  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public static class XzsWechatVisual {
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct POINT { public int X,Y; public POINT(int x,int y){X=x;Y=y;} }
  // A separator must span almost the entire message pane. A blank rectangle
  // below an arbitrary text bubble cannot masquerade as the composer.
  public static int ComposerTop(Bitmap b,int left,double scale) {
    int x0=left+(int)(25*scale),x1=b.Width-(int)(32*scale);
    if(x1-x0<200*scale)return -1;
    for(int y=b.Height-(int)(100*scale);y>b.Height*0.32;y--){
      int line=0,n=0;
      for(int x=x0;x<x1;x+=3){var c=b.GetPixel(x,y);n++;if(Math.Abs(c.R-c.G)<5&&Math.Abs(c.G-c.B)<5&&c.R>=218&&c.R<=243)line++;}
      if(n>0&&line>n*0.75)return y;
    }
    return -1;
  }
  public static bool EmptyComposer(Bitmap b,int left,int top,double scale) {
    int x0=left+(int)(18*scale),x1=b.Width-(int)(24*scale),y0=top+(int)(10*scale),y1=b.Height-(int)(58*scale);
    if(y1-y0<35*scale)return false;
    int dark=0,other=0;
    for(int y=y0;y<y1;y++)for(int x=x0;x<x1;x++){
      var c=b.GetPixel(x,y);
      if(c.R<225||c.G<225||c.B<225)dark++;
      if(Math.Max(c.R,Math.Max(c.G,c.B))-Math.Min(c.R,Math.Min(c.G,c.B))>20)other++;
    }
    // Only a thin caret is allowed. Text, thumbnails and attachment cards fail.
    return dark<=40*scale*scale&&other<=8*scale*scale;
  }
  public static bool GreenButton(Bitmap b,int x,int y,int w,int h,double scale) {
    int green=0,n=0;
    for(int yy=Math.Max(0,y-(int)(7*scale));yy<Math.Min(b.Height,y+h+(int)(7*scale));yy++)
    for(int xx=Math.Max(0,x-(int)(12*scale));xx<Math.Min(b.Width,x+w+(int)(12*scale));xx++){
      var c=b.GetPixel(xx,yy);n++;if(c.G>90&&c.G>c.R*1.25&&c.G>c.B*1.12)green++;
    }
    return n>0&&green>n*0.3;
  }
  public static int OriginalCheckbox(Bitmap b,int textX,int textY,int textH,double scale) {
    int green=0,border=0;
    for(int y=Math.Max(0,textY-(int)(2*scale));y<Math.Min(b.Height,textY+textH+(int)(2*scale));y++)
    for(int x=Math.Max(0,textX-(int)(24*scale));x<Math.Min(b.Width,textX-(int)(2*scale));x++){
      var c=b.GetPixel(x,y);
      if(c.G>80&&c.G>c.R*1.25&&c.G>c.B*1.12)green++;
      if(Math.Abs(c.R-c.G)<8&&Math.Abs(c.G-c.B)<8&&c.R>100&&c.R<220)border++;
    }
    if(green>6*scale*scale)return 1;
    return border>12*scale*scale?0:-1;
  }
}
'@
}
function Initialize-VisualWechat {
  Initialize-VisualRecognition
  $script:visualScale = [XzsWechatVisual]::GetDpiForWindow($script:mainHandle) / 96.0
  if ($script:visualScale -lt 0.9 -or $script:visualScale -gt 2.5) { Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }
}
function Await-VisualOperation($operation, [type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null,@($operation))
  if (-not $task.Wait(7000)) { Fail 'WECHAT_ATTACHMENT_UI_OCR_UNAVAILABLE' }
  return $task.Result
}
function Read-VisualText([System.Drawing.Bitmap]$bitmap) {
  $memory = New-Object System.IO.MemoryStream
  $random = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $software = $null
  $factor=[Math]::Max(1,[Math]::Min(3,[Math]::Floor(2400.0/[Math]::Max($bitmap.Width,$bitmap.Height))))
  $scaled=New-Object System.Drawing.Bitmap(($bitmap.Width*$factor),($bitmap.Height*$factor))
  try {
    $graphics=[System.Drawing.Graphics]::FromImage($scaled)
    try {$graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$graphics.DrawImage($bitmap,0,0,$scaled.Width,$scaled.Height)}finally{$graphics.Dispose()}
    $scaled.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
    $writer = New-Object Windows.Storage.Streams.DataWriter($random)
    try { $writer.WriteBytes($memory.ToArray()); $null = Await-VisualOperation ($writer.StoreAsync()) ([uint32]); $null=$writer.DetachStream() } finally { $writer.Dispose() }
    $random.Seek(0)
    $decoder = Await-VisualOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $software = Await-VisualOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await-VisualOperation ($script:ocr.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
    return @($result.Lines | ForEach-Object {
      $words = @($_.Words)
      if ($words.Count -gt 0) {
        $xs=@($words | ForEach-Object {$_.BoundingRect.X}); $ys=@($words | ForEach-Object {$_.BoundingRect.Y})
        $rights=@($words | ForEach-Object {$_.BoundingRect.X+$_.BoundingRect.Width}); $bottoms=@($words | ForEach-Object {$_.BoundingRect.Y+$_.BoundingRect.Height})
        $x=($xs|Measure-Object -Minimum).Minimum; $y=($ys|Measure-Object -Minimum).Minimum
        [pscustomobject]@{Text=($words.Text -join ''); X=($x/$factor);Y=($y/$factor);Width=((($rights|Measure-Object -Maximum).Maximum - $x)/$factor);Height=((($bottoms|Measure-Object -Maximum).Maximum - $y)/$factor)}
      }
    })
  } finally { if ($software) {$software.Dispose()}; $random.Dispose();$memory.Dispose();$scaled.Dispose() }
}
function Get-VisualFrame {
  Check-Window
  $rect = New-Object XzsWechatMediaWindow+RECT
  [void][XzsWechatMediaWindow]::GetWindowRect($script:mainHandle,[ref]$rect)
  $bitmap = New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size) } finally {$graphics.Dispose()}
  Check-Window
  $check = New-Object XzsWechatMediaWindow+RECT
  [void][XzsWechatMediaWindow]::GetWindowRect($script:mainHandle,[ref]$check)
  if ($check.Left -ne $rect.Left -or $check.Top -ne $rect.Top -or $check.Right -ne $rect.Right -or $check.Bottom -ne $rect.Bottom) {$bitmap.Dispose();Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED'}
  return @{Bitmap=$bitmap;Rect=$rect}
}
function Match-VisualTitle([string]$text) {
  $expected=$request.targetName -replace '\s',''
  $actual=$text -replace '\s',''
  if ($actual -ceq $expected) {return $true}
  return $request.kind -eq 'group' -and $actual -cmatch ('^'+[regex]::Escape($expected)+'[\uFF08(][1-9][0-9]{0,5}[\uFF09)]$')
}
function Get-VisualHeader($frame) {
  $s=$script:visualScale
  $crop=$frame.Bitmap.Clone([System.Drawing.Rectangle]::new([int](245*$s),[int](30*$s),[int]($frame.Bitmap.Width-245*$s-85*$s),[int](68*$s)),$frame.Bitmap.PixelFormat)
  try {$lines=@(Read-VisualText $crop)}finally{$crop.Dispose()}
  $matches=@($lines|Where-Object { (Match-VisualTitle $_.Text) -and $_.Y -lt 45*$s })
  if ($matches.Count -ne 1) {Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE'}
  return [int]($matches[0].X+245*$s-18*$s)
}
function Assert-VisualTarget {
  $frame=Get-VisualFrame
  try {$null=Get-VisualHeader $frame}finally{$frame.Bitmap.Dispose()}
}
function Click-VisualPoint($frame,[int]$x,[int]$y) {
  Check-Window
  $now=New-Object XzsWechatMediaWindow+RECT
  [void][XzsWechatMediaWindow]::GetWindowRect($script:mainHandle,[ref]$now)
  if ($now.Left -ne $frame.Rect.Left -or $now.Top -ne $frame.Rect.Top -or $now.Right -ne $frame.Rect.Right -or $now.Bottom -ne $frame.Rect.Bottom) {Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED'}
  $point=New-Object XzsWechatVisual+POINT(($now.Left+$x),($now.Top+$y))
  $hit=[XzsWechatVisual]::WindowFromPoint($point)
  $hitRoot=[XzsWechatVisual]::GetAncestor($hit,2)
  $hitOwner=$hitRoot
  if($script:submitted){for($i=0;$i -lt 8 -and $hitOwner -ne [IntPtr]::Zero -and $hitOwner -ne $script:mainHandle;$i++){$hitOwner=[XzsWechatMediaWindow]::GetWindow($hitOwner,4)}}
  if ($hitRoot -ne $script:mainHandle -and $hitOwner -ne $script:mainHandle) {Fail 'WECHAT_ATTACHMENT_UI_WINDOW_CHANGED'}
  [void][XzsWechatVisual]::SetCursorPos($point.X,$point.Y)
  [XzsWechatVisual]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  [XzsWechatVisual]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
function Find-VisualInput {
  $frame=Get-VisualFrame
  try {
    $left=Get-VisualHeader $frame
    $top=[XzsWechatVisual]::ComposerTop($frame.Bitmap,$left,$script:visualScale)
    if($top -lt 0){Fail 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE'}
    if(-not [XzsWechatVisual]::EmptyComposer($frame.Bitmap,$left,$top,$script:visualScale)){Fail 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT'}
    Click-VisualPoint $frame ([int](($left+$frame.Bitmap.Width)/2)) ([int]($top+25*$script:visualScale))
  } finally {$frame.Bitmap.Dispose()}
  # Read selected draft without deleting it. This also detects invisible spaces.
  $sentinel='XZS-DRAFT-PROBE-'+[guid]::NewGuid().ToString('N')
  [System.Windows.Forms.Clipboard]::SetText($sentinel)
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^c')
  Start-Sleep -Milliseconds 120
  Check-Window
  if(-not [System.Windows.Forms.Clipboard]::ContainsText() -or [System.Windows.Forms.Clipboard]::GetText() -cne $sentinel){Fail 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT'}
}
function Select-VisualChat {
  $frame=Get-VisualFrame
  try {try {$null=Get-VisualHeader $frame;return}catch {if($_.Exception.Message -ne 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE'){throw}}}finally{$frame.Bitmap.Dispose()}
  # Search changes only the navigation field. Never paste into a guessed editor.
  [System.Windows.Forms.SendKeys]::SendWait('^f')
  Start-Sleep -Milliseconds 350
  $frame=Get-VisualFrame
  try {
    $lines=@(Read-VisualText $frame.Bitmap)
    $search=@($lines|Where-Object {$_.X -gt 65*$script:visualScale -and $_.X -lt 240*$script:visualScale -and $_.Y -gt 30*$script:visualScale -and $_.Y -lt 78*$script:visualScale})
    if($search.Count -lt 1){Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE'}
    Click-VisualPoint $frame ([int](160*$script:visualScale)) ([int](56*$script:visualScale))
  } finally {$frame.Bitmap.Dispose()}
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.Clipboard]::SetText($request.targetName)
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 1100
  $frame=Get-VisualFrame
  try {
    $lines=@(Read-VisualText $frame.Bitmap)
    $matches=@($lines|Where-Object {($_.Text -replace '\s','') -ceq ($request.targetName -replace '\s','') -and $_.X -gt 65*$script:visualScale -and $_.X -lt 260*$script:visualScale -and $_.Y -gt 95*$script:visualScale -and $_.Y -lt $frame.Bitmap.Height-70*$script:visualScale})
    if($matches.Count -ne 1){Fail 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE'}
    Click-VisualPoint $frame ([int]($matches[0].X+$matches[0].Width/2)) ([int]($matches[0].Y+$matches[0].Height/2))
  } finally {$frame.Bitmap.Dispose()}
  Start-Sleep -Milliseconds 500
  Assert-VisualTarget
}
function Submit-VisualPreview {
  # Original mode keeps the content digest meaningful even for large photos.
  if($request.mediaType -eq 'image') {
    $frame=Get-VisualFrame
    try {
      $null=Get-VisualHeader $frame
      $lines=@(Read-VisualText $frame.Bitmap)
      $originalText=[string][char]0x539f+[string][char]0x56fe
      $original=@($lines|Where-Object {$_.Text -cmatch ('^'+$originalText+'(?:[\uFF08(].*[\uFF09)])?$') -and $_.Y -gt $frame.Bitmap.Height*0.4})
      if($original.Count -gt 1){Fail 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE'}
      if($original.Count -eq 1){
        $o=$original[0]
        $checked=[XzsWechatVisual]::OriginalCheckbox($frame.Bitmap,[int]$o.X,[int]$o.Y,[int]$o.Height,$script:visualScale)
        if($checked -lt 0){Fail 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE'}
        if($checked -eq 0){
          Click-VisualPoint $frame ([int]($o.X+$o.Width/2)) ([int]($o.Y+$o.Height/2))
          Start-Sleep -Milliseconds 200
          $after=Get-VisualFrame
          try {if([XzsWechatVisual]::OriginalCheckbox($after.Bitmap,[int]$o.X,[int]$o.Y,[int]$o.Height,$script:visualScale) -ne 1){Fail 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE'}}finally{$after.Bitmap.Dispose()}
        }
      }
    } finally {$frame.Bitmap.Dispose()}
  }
  $frame=Get-VisualFrame
  try {
    $left=Get-VisualHeader $frame
    $lines=@(Read-VisualText $frame.Bitmap)
    $sendText=[string][char]0x53d1+[string][char]0x9001
    $send=@($lines|Where-Object {$_.Text -ceq $sendText -and $_.X -gt $left -and $_.Y -gt $frame.Bitmap.Height*0.45 -and [XzsWechatVisual]::GreenButton($frame.Bitmap,[int]$_.X,[int]$_.Y,[int]$_.Width,[int]$_.Height,$script:visualScale)})
    if($send.Count -ne 1){Fail 'WECHAT_ATTACHMENT_UI_SEND_UNREADABLE'}
    # The empty editor, verified FileDropList and a newly enabled green button
    # establish the new preview; the database still must prove exact content.
    $prefix=($request.name -replace '\s','');$prefix=$prefix.Substring(0,[Math]::Min(10,$prefix.Length))
    $preview=@($lines|Where-Object {$_.X -gt $left -and $_.Y -gt 100*$script:visualScale -and ($_.Text -replace '\s','') -like ('*'+[System.Management.Automation.WildcardPattern]::Escape($prefix)+'*')})
    if($request.mediaType -eq 'file' -and $preview.Count -lt 1){Fail 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE'}
    Click-VisualPoint $frame ([int]($send[0].X+$send[0].Width/2)) ([int]($send[0].Y+$send[0].Height/2))
  } finally {$frame.Bitmap.Dispose()}
}
