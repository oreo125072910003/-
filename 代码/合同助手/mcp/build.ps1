param([string]$OutputFolder = '成品_合同助手2.3')
$ErrorActionPreference = 'Stop'
$desktopRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop'
$outputDir = Join-Path $desktopRoot $OutputFolder
& (Join-Path $desktopRoot 'build.ps1') -OutputFolder $OutputFolder
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$sources = @('ContractEngine.cs','TemplateRules.cs','AiService.cs','BatchImport.cs','ContractLibrary.cs','MaterialCatalog.cs','MaterialImport.cs','Preferences.cs','EmbeddedContent.cs') | ForEach-Object { Join-Path $desktopRoot $_ }
$sources += Join-Path $PSScriptRoot 'McpServer.cs'
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Xml.dll','System.Xml.Linq.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Web.Extensions.dll','System.Net.Http.dll','System.Security.dll')
$compilerArgs = @('/nologo','/target:exe','/platform:anycpu','/optimize+','/utf8output',('/out:' + (Join-Path $outputDir '合同助手MCP.exe')))
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
& $compiler @compilerArgs @sources
if ($LASTEXITCODE -ne 0) { throw 'MCP编译失败。' }
Write-Output (Join-Path $outputDir '合同助手MCP.exe')
