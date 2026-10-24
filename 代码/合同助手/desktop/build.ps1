param([string]$OutputFolder = 'out\development')
$ErrorActionPreference = 'Stop'
$desktopRoot = $PSScriptRoot
$outputDir = Join-Path $desktopRoot $OutputFolder
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$nativeExe = Join-Path $outputDir '合同填写小助手.exe'
$sourceFiles = @('ContractEngine.cs', 'TemplateRules.cs', 'AiService.cs', 'BatchImport.cs', 'ContractLibrary.cs', 'MaterialCatalog.cs', 'MaterialImport.cs', 'Preferences.cs', 'LibraryDialogs.cs', 'EmbeddedContent.cs', 'HelpDialog.cs', 'XpStyle.cs', 'MainForm.cs', 'DesktopTests.cs') | ForEach-Object { Join-Path $desktopRoot $_ }
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Xml.dll', 'System.Xml.Linq.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll', 'System.Web.Extensions.dll', 'System.Net.Http.dll', 'System.Security.dll')
$compilerArgs = @('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/utf8output', ('/out:' + $nativeExe))
$compilerArgs += $references | ForEach-Object { '/reference:' + $_ }
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\template.docx') + ',template.docx'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\sample.json') + ',sample.json'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\defaults.json') + ',defaults.json'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\reference.docx') + ',reference.docx'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\reference.pdf') + ',reference.pdf'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\user-help.txt') + ',user-help.txt'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\mcp-help.txt') + ',mcp-help.txt'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\agent-prompt.txt') + ',agent-prompt.txt'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\ocr-prompt.txt') + ',ocr-prompt.txt'
$compilerArgs += '/resource:' + (Join-Path $desktopRoot 'assets\draft-prompt.txt') + ',draft-prompt.txt'
foreach ($resourceName in @('materials-seed.json','purchase.xlsx','example-129300.docx','example-161000.docx')) { $compilerArgs += '/resource:' + (Join-Path $desktopRoot ('assets\' + $resourceName)) + ',' + $resourceName }
& $compiler @compilerArgs @sourceFiles
if ($LASTEXITCODE -ne 0) { throw '编译失败。' }
Write-Output $nativeExe
