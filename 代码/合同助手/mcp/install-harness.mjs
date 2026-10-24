// 由DeepSeek Harness的Electron以Node模式运行，只增改本服务的配置行。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const appRoot = path.dirname(process.execPath);
const moduleRoot = path.join(appRoot, 'resources/app.asar/dsh');
const { parseDocument } = await import(pathToFileURL(path.join(moduleRoot, 'node_modules/yaml/dist/index.js')).href);
const require = createRequire(pathToFileURL(path.join(moduleRoot, 'package.json')).href);
const { Config } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href);
const executable = path.resolve(process.argv[2]);
const outputFolder = path.resolve(process.argv[3]);
const releaseFolder = path.dirname(executable);
if (!fs.existsSync(executable) || !fs.existsSync(path.join(releaseFolder, '合同填写小助手.exe'))) throw new Error('Missing contract application executables.');
const config = { serverName: 'contract_helper', transport: 'stdio', command: executable, args: [], cwd: releaseFolder, toolCallTimeoutMs: 210000, failOnStartupError: false };
Config(config);
const profile = path.join(os.homedir(), '.dsh/profiles/desktop/cordis.patch.yml');
const source = fs.readFileSync(profile, 'utf8');
const doc = parseDocument(source);
if (doc.errors.length || !Array.isArray(doc.contents?.items)) throw new Error('Harness desktop profile is invalid; nothing changed.');
const before = doc.toJSON();
const matches = [];
function visit(items) {
  for (const item of items ?? []) {
    if (item.get?.('id') === 'mcp-contract-helper') matches.push(item);
    visit(item.get?.('insert')?.items); visit(item.get?.('children')?.items);
  }
}
visit(doc.contents.items);
if (matches.length > 1) throw new Error('Duplicate contract MCP rows; nothing changed.');
const entry = { id: 'mcp-contract-helper', name: '@deepseek-ai/dsh-mcp-client', config };
let changed = true;
if (matches.length) {
  if (matches[0].get('name') !== entry.name) throw new Error('Profile row belongs to a different plugin; nothing changed.');
  changed = !isDeepStrictEqual(matches[0].get('config')?.toJSON(), config);
  if (changed) matches[0].set('config', config);
} else {
  doc.contents.add({ insert: [entry] });
  if (!isDeepStrictEqual(doc.toJSON().slice(0, before.length), before)) throw new Error('Unrelated configuration changed; nothing written.');
}
let backup = null;
if (!changed) {
  try { backup = JSON.parse(fs.readFileSync(path.join(releaseFolder, 'Harness接入结果.json'), 'utf8')).backup ?? null; } catch { }
}
if (changed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup = profile + '.before-contract-mcp-' + stamp;
  fs.copyFileSync(profile, backup);
  const serialized = String(doc);
  if (parseDocument(serialized).errors.length) throw new Error('Invalid generated YAML; original file preserved.');
  const temporary = profile + '.contract-helper.tmp';
  fs.writeFileSync(temporary, serialized, 'utf8'); fs.renameSync(temporary, profile);
}
fs.mkdirSync(outputFolder, { recursive: true });
const fragment = '- insert:\n    - id: mcp-contract-helper\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: ' + JSON.stringify(config) + '\n';
fs.writeFileSync(path.join(releaseFolder, 'DeepSeekHarness配置片段.yml'), fragment);
fs.writeFileSync(path.join(releaseFolder, 'MCP通用配置.json'), JSON.stringify({ mcpServers: { contract_helper: { command: executable, args: config.args } } }, null, 2));
const report = { configured: true, changed, configurationValidated: true, profile, backup, serverName: config.serverName, executable, outputFolder };
fs.writeFileSync(path.join(releaseFolder, 'Harness接入结果.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
