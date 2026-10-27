import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bundleWechatComponents } from './bundle-wechat-components.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'packages/dsh-plugin');
const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const full = process.argv.includes('--full');
const output = path.join(root, 'dist/dsh-plugin', metadata.version + (full ? '-full' : ''));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhushou-dsh-'));
const stage = path.join(temporary, 'package'); fs.mkdirSync(stage);
const payload = [
  'apps/service','apps/desktop/renderer','apps/desktop/secret-store.cjs',
  'packages/contracts','packages/storage','packages/runtime-harness','packages/wechat-bridge',
  'packages/extensions','packages/workers','packages/documents','packages/mail-plugin','packages/harness-host-plugin',
  '代码/项目/package.json','代码/项目/scripts/hook-onebot.mjs','代码/项目/scripts/text-delivery-store.mjs',
  '代码/项目/scripts/wechat-account-check.mjs','代码/项目/scripts/reader-account-state.mjs','代码/项目/scripts/reader-setup.mjs',
  '代码/项目/components/qq-bridge/src/core/wechat-events.js','代码/项目/components/qq-bridge/src/core/sticker-policy.js',
  '代码/项目/components/qq-bridge/src/core/proactive-policy.js','代码/项目/components/qq-bridge/src/onebot/normalize.js',
  '代码/项目/public/console/conversation-settings.mjs','代码/项目/packages/dsh-social-bridge-plugin/conversation-policy.mjs',
  '代码/项目/packages/extension-runtime/catalog.mjs'
];
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: filename => {
    const stat = fs.lstatSync(filename);
    if (stat.isSymbolicLink()) throw Error('打包来源不能包含链接：' + filename);
    if (['state','node_modules','config','dist','.git'].includes(path.basename(filename)) && stat.isDirectory()) throw Error('禁止打包个人或运行目录：' + filename);
    return true;
  } });
}
try {
  for (const item of fs.readdirSync(source)) copy(path.join(source, item), path.join(stage, item));
  copy(path.join(root, 'packages/harness-host-plugin/icon.svg'), path.join(stage, 'icon.svg'));
  for (const relative of payload) copy(path.join(root, relative), path.join(stage, 'payload', relative));
  fs.writeFileSync(path.join(stage, 'payload/package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  const contract = path.join(root, '代码/合同助手/desktop/out/desktop-release');
  for (const name of ['合同填写小助手.exe','合同助手MCP.exe']) {
    if (!fs.existsSync(path.join(contract, name))) throw Error('请先构建合同工具，完整插件包需要它：' + name);
    copy(path.join(contract, name), path.join(stage, 'contract-resource', name));
  }
  copy(path.join(root, '代码/合同助手/desktop/source-origin.json'), path.join(stage, 'contract-resource/source-origin.json'));
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ ...metadata, dependencies: rootPackage.dependencies, engines: rootPackage.engines }, null, 2) + '\n');
  if (full) console.log(JSON.stringify({ stage: 'bundled-wechat-components', ...bundleWechatComponents({ root, stage }) }));
  fs.mkdirSync(output, { recursive: true });
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: stage, encoding: 'utf8', windowsHide: true });
  if (packed.status !== 0) throw Error('插件打包失败：' + (packed.stderr || packed.stdout).slice(-2000));
  const [result] = JSON.parse(packed.stdout), filename = path.join(output, result.filename);
  const unexpected = result.files.filter(file => /(?:^|\/)(?:state|config|logs|node_modules|\.git)(?:\/|$)|\.sqlite|bridge-token|secrets\.protected|Local State|wechatagent\.json/.test(file.path));
  if (unexpected.length) throw Error('插件包中出现不应分发的文件：' + unexpected.map(file => file.path).join(', '));
  const manifest = { version: metadata.version, packageName: metadata.name, filename, sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
    fileCount: result.files.length, bytes: result.size, standaloneAssistantIncluded: false, personalDataIncluded: false, wechatClientBundled: full, readerRuntimeBundled: full, contractIncluded: true };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), manifest.sha256 + '  ' + path.basename(filename) + '\n');
  // Keep a reviewable install candidate beside the archive. It contains only
  // allowlisted distributable files, and no generated token or personal config.
  const candidate = path.join(output, 'package');
  if (fs.existsSync(candidate)) {
    if (path.dirname(path.resolve(candidate)) !== path.resolve(output) || path.basename(candidate) !== 'package') throw Error('Unexpected output cleanup path');
    fs.rmSync(candidate, { recursive: true, force: true });
  }
  fs.cpSync(stage, candidate, { recursive: true });
  console.log(JSON.stringify(manifest));
} finally {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('xiaozhushou-dsh-')) throw Error('Unexpected staging cleanup path');
  fs.rmSync(temporary, { recursive: true, force: true });
}
