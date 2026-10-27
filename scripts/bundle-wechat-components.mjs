import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function bundleWechatComponents({ root, stage }) {
  const location = JSON.parse(fs.readFileSync(path.join(root, 'config/wechat-locations.json'), 'utf8')).workspace;
  const project = JSON.parse(fs.readFileSync(path.join(location, 'config/wechatagent.json'), 'utf8'));
  const client = path.dirname(path.resolve(location, project.hook.wechatExecutable));
  const python = path.dirname(project.runtime.python), destination = path.join(stage, 'companions');
  const files = [];
  function copyFile(source, relative) {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('组件来源必须是普通文件：' + source);
    const target = path.join(destination, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
    files.push({ path: relative.replaceAll('\\', '/'), bytes: stat.size, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') });
  }
  function tree(source, relative) {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === '__pycache__' || /\.py[co]$/.test(entry.name)) continue;
      if (entry.isSymbolicLink()) throw Error('组件不能包含链接：' + entry.name);
      if (entry.isDirectory()) tree(path.join(source, entry.name), path.join(relative, entry.name));
      else copyFile(path.join(source, entry.name), path.join(relative, entry.name));
    }
  }
  // Only the immutable executable, its exact version directory, and our reviewed
  // connection DLL. The adjacent token, media-root and runtime state are excluded.
  copyFile(path.join(client, 'Weixin.exe'), 'wechat-client/Weixin.exe');
  copyFile(path.join(client, 'version.dll'), 'wechat-client/version.dll');
  tree(path.join(client, '4.1.10.27'), 'wechat-client/4.1.10.27');
  const built = JSON.parse(fs.readFileSync(path.join(location, 'state/hook/native/build.json'), 'utf8'));
  const hookHash = files.find(item => item.path === 'wechat-client/version.dll').sha256;
  if (built.targetVersion !== '4.1.10.27' || built.sha256 !== hookHash) throw Error('专用微信连接组件摘要不匹配。');
  const approvedPython = new Set(['Lib','DEPENDENCIES.json','LICENSE.txt','python.cat','python.exe','pythonw.exe','python313._pth','python313.zip']);
  for (const entry of fs.readdirSync(python, { withFileTypes: true })) {
    if (!approvedPython.has(entry.name) && !/\.(?:dll|pyd)$/.test(entry.name)) throw Error('Python 来源出现未审查文件：' + entry.name);
    if (entry.isDirectory()) tree(path.join(python, entry.name), path.join('python', entry.name));
    else copyFile(path.join(python, entry.name), path.join('python', entry.name));
  }
  const scripts = path.join(root, '代码/项目/scripts');
  for (const entry of fs.readdirSync(scripts)) if (/^(?:wechat_[\w]+|reader_setup|reader-api|resolve-wechat-image|check-runtime)\.py$/.test(entry)) copyFile(path.join(scripts, entry), path.join('reader/scripts', entry));
  for (const name of ['nt_decrypt.py','nt_common.py']) copyFile(path.join(root, '代码/项目/components/weflow-cli/scripts', name), path.join('reader/components/weflow-cli/scripts', name));
  copyFile(path.join(root, '代码/项目/components/weflow-cli/resources/key/win32/x64/wx_key.dll'), 'reader/components/weflow-cli/resources/key/win32/x64/wx_key.dll');
  copyFile(path.join(root, '代码/项目/components/weflow-cli/LICENSE'), 'reader/components/weflow-cli/LICENSE');
  const manifest = { schemaVersion: 1, clientVersion: '4.1.10.27', platform: 'win32', arch: 'x64', hookSha256: hookHash, files,
    accountDataIncluded: false, existingTokensIncluded: false, credentialsIncluded: false };
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0), clientVersion: manifest.clientVersion };
}
