import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createNativeAssistant, SERVICE_METHODS, NATIVE_METHODS } from '../packages/dsh-plugin/host.mjs';
import { createWindowsProtection } from '../packages/dsh-plugin/windows-protection.mjs';
import { resolveProductDataRoot } from '../packages/dsh-plugin/paths.mjs';
import { createAssistantService } from '../apps/service/index.mjs';
const { createSecretStore } = createRequire(import.meta.url)('../apps/desktop/secret-store.cjs');
const offline = { inspectHostedRuntime: async () => ({ available: true, source: 'existing-harness-host', detail: 'offline test only', capabilities: {} }), runHostedTask: async () => { throw Error('No model in this test'); } };
const temporaryDirectories = [];
test.after(() => {
  for (const directory of temporaryDirectories) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('dsh-plugin-test-')) throw Error('Unexpected cleanup path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-test-'));
  temporaryDirectories.push(directory); return directory;
}
function memoryVault() { const data = new Map(); return { get: async key => data.get(key), set: async (key, value) => data.set(key, value), delete: async key => data.delete(key) }; }
async function setup(t, { dataDir = temporary(t), operate } = {}) {
  let route;
  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = { webServer: { port: server.address().port, register: value => { route = value; return () => {}; } } };
  const native = await createNativeAssistant(ctx, { productDataRoot: dataDir }, { runtime: offline, createService: createAssistantService, createSecretStore, secretStore: memoryVault(), operate });
  t.after(async () => { await native.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port + '/xiaozhushou/';
  async function rpc(method, args = []) {
    const response = await fetch(base + 'rpc/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaozhushou-UI': '1' }, body: JSON.stringify(args) });
    return { status: response.status, ...await response.json() };
  }
  return { native, dataDir, base, rpc };
}

test('native routes use the real product service and produce persisted artifacts without launching a desktop', async t => {
  let selected;
  const env = await setup(t, { operate: async (operation, value) => { assert.equal(operation, 'dialog'); assert.equal(value.kind, 'files'); return [selected]; } });
  const boot = await env.rpc('getBootstrap'); assert.equal(boot.ok, true); assert.equal(boot.value.runtime.source, 'existing-harness-host');
  selected = path.join(env.dataDir, '原资料.txt'); fs.writeFileSync(selected, '仅在本机整理的合成材料。');
  const picked = await env.rpc('pickAttachments'); assert.equal(picked.value[0].path, selected);
  const created = await env.rpc('createTask', [{ prompt: '整理这份资料', kind: 'organize', attachmentPaths: [selected] }]); assert.equal(created.ok, true);
  let detail;
  for (let attempt = 0; attempt < 100; attempt++) { detail = await env.rpc('getTask', [created.value.id]); if (detail.value.task.status === 'succeeded') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(detail.value.task.status, 'succeeded'); assert.equal(detail.value.artifacts.length, 2);
  assert.equal(fs.readFileSync(selected, 'utf8'), '仅在本机整理的合成材料。');
  const state = await fetch(env.base + 'state').then(response => response.json()); assert.equal(state.standaloneAssistant, false); assert.ok(state.revision > 0);
  assert.ok(fs.existsSync(path.join(env.dataDir, 'db/assistant.sqlite')));
});

test('HTML and browser adapter retain all existing UI operations and do not leak host credentials', async t => {
  const { base } = await setup(t);
  const html = await fetch(base).then(response => response.text());
  assert.match(html, /browser\.js/); assert.match(html, /connect-src 'self'/);
  const client = await fetch(base + 'browser.js').then(response => response.text());
  for (const name of [...SERVICE_METHODS, ...NATIVE_METHODS]) assert.ok(client.includes('"' + name + '"'), name);
  assert.doesNotMatch(client, /METHODS_PLACEHOLDER|bridge-token|Bearer /);
  const script = await fetch(base + 'app.js'); assert.equal(script.status, 200);
  const traversal = await fetch(base + 'rpc/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaozhushou-UI': '1' }, body: '[]' }); assert.equal(traversal.status, 404);
  assert.equal((await fetch(base + 'secrets.protected.json')).status, 404);
});

test('cross-site requests, foreign hosts and missing interface headers are rejected before service startup', async t => {
  const { base, native } = await setup(t);
  const post = headers => fetch(base + 'rpc/getSettings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xiaozhushou-UI': '1', ...headers }, body: '[]' });
  assert.equal((await post({ Origin: 'https://foreign.example' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.request(base + 'rpc/getSettings', { method: 'POST', headers: { Host: 'foreign.example', 'Content-Type': 'application/json', 'X-Xiaozhushou-UI': '1' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end('[]');
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post({ 'X-Xiaozhushou-UI': '' })).status, 403);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(native.status().state, 'waiting');
  assert.equal((await post({ Origin: 'dsh-app://app' })).status, 200);
});

test('an existing desktop owner blocks takeover; retry after exit preserves identity and tasks', async t => {
  const dataDir = temporary(t);
  const desktop = await createAssistantService({ dataDir, runtime: offline, secretStore: memoryVault() });
  t.after(() => desktop.close());
  await desktop.saveSettings({ assistantName: '原来的名字', persona: '原来的人格。' });
  const source = path.join(dataDir, '保留的资料.txt'); fs.writeFileSync(source, '原来的资料。'); desktop.grantAttachments([source]);
  const original = await desktop.createTask({ prompt: '保留原任务', kind: 'organize', attachmentPaths: [source] });
  for (let i = 0; i < 100 && desktop.getTask(original.id).task.status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const plugin = await setup(t, { dataDir });
  const blocked = await plugin.rpc('getSettings'); assert.equal(blocked.ok, false); assert.match(blocked.error, /另一个小助手/);
  assert.equal((await fetch(plugin.base + 'app.js')).status, 200);
  await desktop.close();
  const resumed = await plugin.rpc('getSettings'); assert.equal(resumed.ok, true); assert.equal(resumed.value.assistantName, '原来的名字'); assert.equal(resumed.value.persona, '原来的人格。');
  assert.equal((await plugin.rpc('getTask', [original.id])).value.task.status, 'succeeded');
});

test('Electron v10 credentials decrypt with the original Windows key and reject tampering', async t => {
  const directory = temporary(t), key = randomBytes(32), nonce = randomBytes(12);
  fs.mkdirSync(path.join(directory, 'desktop'));
  fs.writeFileSync(path.join(directory, 'desktop/Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIsynthetic-wrapped-key').toString('base64') } }));
  const cipher = createCipheriv('aes-256-gcm', key, nonce), value = '合成凭据，仅供测试';
  const encrypted = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const protection = createWindowsProtection({ dataDir: directory, operate: async (operation, input) => { assert.equal(operation, 'unprotect'); assert.equal(Buffer.from(input, 'base64').toString(), 'synthetic-wrapped-key'); return key.toString('base64'); } });
  assert.equal((await protection.decryptStringAsync(encrypted)).result, value);
  const altered = Buffer.from(encrypted); altered[20] ^= 1;
  await assert.rejects(protection.decryptStringAsync(altered));
});

test('real Windows DPAPI stores and reopens an encrypted fixture without plaintext', { skip: process.platform !== 'win32' }, async t => {
  const directory = temporary(t), secret = '中文 Windows 插件凭据测试';
  let store = createSecretStore({ dataDir: directory, safeStorage: createWindowsProtection({ dataDir: directory }) });
  await store.set('fixture', secret);
  assert.equal(fs.readFileSync(path.join(directory, 'secrets.protected.json'), 'utf8').includes(secret), false);
  store = createSecretStore({ dataDir: directory, safeStorage: createWindowsProtection({ dataDir: directory }) });
  assert.equal(await store.get('fixture'), secret);
});

test('default data discovery reuses the existing redirected desktop and refuses ambiguous identities', t => {
  const directory = temporary(t), standard = path.join(directory, 'roaming/XiaoZhuShou'), redirected = path.join(directory, 'redirected/XiaoZhuShou');
  fs.mkdirSync(path.join(redirected, 'db'), { recursive: true }); fs.writeFileSync(path.join(redirected, 'db/assistant.sqlite'), 'synthetic database marker');
  const discovery = { home: directory, roaming: path.dirname(standard), candidates: [standard, redirected] };
  assert.equal(resolveProductDataRoot({}, discovery), fs.realpathSync(redirected));
  fs.mkdirSync(path.join(standard, 'db'), { recursive: true }); fs.writeFileSync(path.join(standard, 'db/assistant.sqlite'), 'second synthetic marker');
  assert.throws(() => resolveProductDataRoot({}, discovery), /多份小助手数据/);
  assert.equal(resolveProductDataRoot({ productDataRoot: redirected }, discovery), redirected);
});
