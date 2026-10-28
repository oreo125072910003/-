import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const directory = path.dirname(fileURLToPath(import.meta.url));
export function buildDesktopHelper() {
  if (process.platform !== 'win32') throw Error('客户端控制组件需要在 Windows 构建。');
  const framework = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319');
  const references = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/WPF');
  const output = path.join(directory, 'bin'); fs.mkdirSync(output, { recursive: true });
  const executable = path.join(output, 'xiaozhushou-desktop.exe');
  const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo','/target:exe','/platform:x64','/optimize+','/out:' + executable,
    '/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',
    ...['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(name => '/r:' + path.join(references, name)), path.join(directory, 'DesktopControl.cs')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error('客户端控制组件构建失败：' + (result.stderr || result.stdout).slice(-3000));
  return executable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildDesktopHelper());
