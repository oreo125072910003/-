import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Qt compatibility recognizes real rendered Chinese titles and rejects drafts, disabled buttons and changed targets', { skip: process.platform !== 'win32' }, () => {
  const helper=path.resolve('packages/wechat-bridge/wechat-visual-ui.ps1').replaceAll("'","''");
  const sender=path.resolve('packages/wechat-bridge/send-attachment-ui.ps1').replaceAll("'","''");
  const probe=`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
foreach($filename in @('${helper}','${sender}')){
  $tokens=$null;$errors=$null
  $null=[System.Management.Automation.Language.Parser]::ParseFile($filename,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw ($errors|Out-String)}
}
. '${helper}'
function Fail([string]$code){throw $code}
Initialize-VisualRecognition
$script:visualScale=1
$request=@{targetName='测试收件人甲';kind='private'}
$titleChecks=@((Match-VisualTitle '测试收件人甲'),(Match-VisualTitle '测试收件人乙'),(Match-VisualTitle '测试收件人甲(2)'))
$request.kind='group'
$titleChecks+=@((Match-VisualTitle '测试收件人甲(12)'),(Match-VisualTitle '测试收件人甲（12）'),(Match-VisualTitle '测试收件人甲乙(12)'),(Match-VisualTitle '测试收件人甲(0)'))
$cases=@()
foreach($scale in @(1.0,1.5,2.0)){
  $bitmap=New-Object System.Drawing.Bitmap([int](983*$scale),[int](720*$scale))
  $g=[System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $g.Clear([System.Drawing.Color]::FromArgb(250,250,250))
    $pen=New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(236,236,236),[single](2*$scale))
    $g.DrawLine($pen,[single](310*$scale),[single](436*$scale),[single](965*$scale),[single](436*$scale));$pen.Dispose()
    $top=[XzsWechatVisual]::ComposerTop($bitmap,[int](300*$scale),$scale)
    $empty=[XzsWechatVisual]::EmptyComposer($bitmap,[int](300*$scale),$top,$scale)
    $g.FillRectangle([System.Drawing.Brushes]::Black,[int](330*$scale),[int](450*$scale),[int]$scale,[int](20*$scale))
    $caret=[XzsWechatVisual]::EmptyComposer($bitmap,[int](300*$scale),$top,$scale)
    $font=New-Object System.Drawing.Font('Microsoft YaHei',[single](12*$scale))
    $g.DrawString('existing draft',$font,[System.Drawing.Brushes]::Black,[single](350*$scale),[single](450*$scale))
    $draft=[XzsWechatVisual]::EmptyComposer($bitmap,[int](300*$scale),$top,$scale)
    $font.Dispose()
    $g.FillRectangle([System.Drawing.Brushes]::LightGray,[int](910*$scale),[int](674*$scale),[int](60*$scale),[int](30*$scale))
    $disabled=[XzsWechatVisual]::GreenButton($bitmap,[int](925*$scale),[int](682*$scale),[int](28*$scale),[int](14*$scale),$scale)
    $brush=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(7,193,96))
    $g.FillRectangle($brush,[int](910*$scale),[int](674*$scale),[int](60*$scale),[int](30*$scale));$brush.Dispose()
    $enabled=[XzsWechatVisual]::GreenButton($bitmap,[int](925*$scale),[int](682*$scale),[int](28*$scale),[int](14*$scale),$scale)
    $cases+=@{scale=$scale;top=$top;empty=$empty;caret=$caret;draft=$draft;disabled=$disabled;enabled=$enabled}
  } finally {$g.Dispose();$bitmap.Dispose()}
}
$bitmap=New-Object System.Drawing.Bitmap(983,720)
$g=[System.Drawing.Graphics]::FromImage($bitmap)
try {
  $g.Clear([System.Drawing.Color]::FromArgb(250,250,250))
  $g.TextRenderingHint=[System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $font=New-Object System.Drawing.Font('Microsoft YaHei',10)
  $g.DrawString('测试收件人甲',$font,[System.Drawing.Brushes]::Black,318,45);$font.Dispose()
  $left=Get-VisualHeader @{Bitmap=$bitmap}
  $request.targetName='另一个收件人'
  $changed=''
  try{$null=Get-VisualHeader @{Bitmap=$bitmap}}catch{$changed=$_.Exception.Message}
}finally{$g.Dispose();$bitmap.Dispose()}
@{cases=$cases;titleChecks=$titleChecks;left=$left;changed=$changed}|ConvertTo-Json -Depth 6 -Compress
`;
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  let output;
  try { output=execFileSync(powershell,['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(probe,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:25000,stdio:['ignore','pipe','pipe']}); }
  catch(error){throw Error(String(error.stderr??error.message).slice(-2000));}
  const result=JSON.parse(output);
  assert.deepEqual(result.titleChecks,[true,false,false,true,true,false,false]);
  for(const item of result.cases){
    assert.ok(Math.abs(item.top-436*item.scale)<=2,item.scale);
    assert.equal(item.empty,true);assert.equal(item.caret,true);assert.equal(item.draft,false);
    assert.equal(item.disabled,false);assert.equal(item.enabled,true);
  }
  assert.ok(result.left>=290&&result.left<=310);
  assert.equal(result.changed,'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE');
});
