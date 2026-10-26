import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBrowserService, installedBrowserChannel } from '../apps/service/browser.mjs';
import { executionGuidance } from '../apps/service/execution-guidance.mjs';
import { saveBrowserConnection, readBrowserConnection } from '../apps/service/browser-connection.mjs';

test('an extension installed in Edge is found without requiring a Chrome installation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-browser-selection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: root };
  fs.mkdirSync(path.join(root, 'Microsoft/Edge/User Data/Profile 2/Extensions/mmlmfjhmonkocbjadbfplnigmagldckm'), { recursive: true });
  assert.equal(installedBrowserChannel({ env, platform: 'win32' }), 'msedge');
  assert.equal(installedBrowserChannel({ env: { ...env, PLAYWRIGHT_MCP_BROWSER: 'chrome' }, platform: 'win32' }), 'chrome');
});

function fixture(t, handler, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-browser-'));
  const connections = [], calls = [];
  const browser = createBrowserService({ dataDir: root, env: {}, ...options, async connect(directory, connectionOptions) {
    const entry = { directory, connectionOptions, closed: false }; connections.push(entry);
    return { tools: ['tabs','snapshot','navigate','click','take_screenshot'].map(action => ({ name: 'browser_' + action, description: action, inputSchema: { type: 'object' } })),
      async call(name, args, signal) { calls.push({ name, args, directory }); return handler ? handler({ name, args, directory, signal }) : { content: [{ type: 'text', text: 'actual page' }] }; },
      async close() { entry.closed = true; } };
  } });
  t.after(async () => { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { browser, root, connections, calls, run: (scope, action = 'snapshot', args = {}, extra = {}) => browser.run({ scope, action, args, authorize: async () => true, ...extra }) };
}

test('browser groups reuse only the same verified principal, and never gain authority from arguments', async t => {
  const f = fixture(t);
  await f.run('desktop-owner'); await f.run('desktop-owner'); await f.run('wechat:1:private:2');
  assert.equal(f.connections.length, 2); assert.equal(f.calls[0].directory, f.calls[1].directory); assert.notEqual(f.calls[0].directory, f.calls[2].directory);
  await assert.rejects(f.run('forged', 'snapshot', {}, { authorize: async () => false }), /权限已撤销/);
  assert.equal(f.connections.length, 2);
});

const pairingToken = 'synthetic_pairing_secret_for_browser_tests_only_123';
function secrets() {
  const values = new Map();
  return { get: async key => values.get(key), set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
}

test('owner pairing stores the token separately and pins the exact existing browser profile', async t => {
  const secretStore = secrets(), f = fixture(t, null, { secretStore });
  const result = await saveBrowserConnection({ dataDir: f.root, secretStore, browser: 'msedge', profileDirName: 'Default', extensionToken: pairingToken });
  assert.equal(result.automaticConnection, true);
  const saved = fs.readFileSync(path.join(f.root, 'browser-connection.json'), 'utf8');
  assert.ok(!saved.includes(pairingToken));
  const tools = await f.run('owner', 'tools');
  assert.equal(tools.automaticConnection, true);
  assert.match(tools.notice, /自动连接/);
  assert.deepEqual(f.connections[0].connectionOptions, { browser: 'msedge', profileDirName: 'Default', extensionToken: pairingToken });
});

test('a missing pairing secret or invalid configuration fails before launching a browser', async t => {
  const secretStore = secrets(), f = fixture(t, null, { secretStore });
  for (const profileDirName of ['../Default', '..', 'C:\\Default']) {
    await assert.rejects(saveBrowserConnection({ dataDir: f.root, secretStore, browser: 'msedge', profileDirName, extensionToken: pairingToken }), /配对信息无效/);
  }
  fs.writeFileSync(path.join(f.root, 'browser-connection.json'), JSON.stringify({ version: 1, browser: 'msedge', profileDirName: 'Default' }));
  await assert.rejects(f.run('owner', 'snapshot'), /配对暂不可用/);
  assert.equal(f.connections.length, 0);
  fs.writeFileSync(path.join(f.root, 'browser-connection.json'), 'null');
  await assert.rejects(readBrowserConnection({ dataDir: f.root, secretStore, env: {} }), /配对信息无效/);
});

test('extension tokens returned by upstream tab listings are removed before reaching DSH', async t => {
  const f = fixture(t, () => ({ content: [{ type: 'text', text: `Welcome?token=${pairingToken}\n${pairingToken}\nActual page title` }] }),
    { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: pairingToken } });
  const result = await f.run('owner', 'tabs', { action: 'list' });
  assert.ok(!JSON.stringify(result).includes(pairingToken));
  assert.match(result.text, /Actual page title/);
  assert.match(result.text, /连接信息已隐藏/);
});

test('an upstream disconnect releases the stale session and reconnects on a new observation without repeating a click', async t => {
  let count = 0;
  const f = fixture(t, () => ++count === 1 ? { isError: true, content: [{ type: 'text', text: 'Extension not connected' }] } : { content: [{ type: 'text', text: 'new snapshot' }] });
  const failed = await f.run('owner', 'click', { ref: 'e1' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /没有自动重试/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.connections[0].closed, true);
  const observation = await f.run('owner', 'snapshot');
  assert.equal(f.connections.length, 2);
  assert.equal(observation.text, 'new snapshot');
  assert.deepEqual(f.calls.map(call => call.name), ['browser_click', 'browser_snapshot']);
});

test('only the narrow browser action set and local output names are accepted', async t => {
  const f = fixture(t);
  for (const action of ['evaluate','run_code','upload_file','install']) await assert.rejects(f.run('owner', action), /操作无效/);
  for (const filename of ['../escape.png','C:\\secret.png','bad.']) await assert.rejects(f.run('owner', 'take_screenshot', { filename }), /文件名/);
  for (const url of ['file:///C:/secret','javascript:alert(1)','https://name:secret@example.test']) await assert.rejects(f.run('owner', 'navigate', { url }), /仅接受/);
  assert.equal(f.connections.length, 0);
  assert.equal((await f.run('owner', 'tools')).tools.length, 5);
});

test('download collection includes only new files from this call', async t => {
  let sequence = 0;
  const f = fixture(t, ({ directory }) => {
    fs.writeFileSync(path.join(directory, `image-${++sequence}.png`), Buffer.from([137,80,78,71,13,10,26,10]));
    return { content: [{ type: 'text', text: 'downloaded' }] };
  });
  const first = await f.run('owner'), second = await f.run('owner');
  assert.equal(first.files.length, 1); assert.equal(second.files.length, 1); assert.notEqual(first.files[0], second.files[0]);
});

test('failed connection or cancellation detaches without replaying page actions', async t => {
  const f = fixture(t, () => { throw Error('connect timeout with private endpoint'); });
  await assert.rejects(f.run('owner', 'click', { ref: 'e1' }), /扩展/);
  assert.equal(f.calls.length, 1); assert.equal(f.connections[0].closed, true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.run('owner', 'click', { ref: 'e1' }, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
});

test('revocation during a queued browser action prevents execution and artifacts', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let allowed = true;
  const f = fixture(t, async () => { await gate; return { content: [{ type: 'text', text: 'done' }] }; });
  const first = f.run('owner');
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = f.run('owner', 'click', { ref: 'e2' }, { authorize: async () => allowed });
  allowed = false; release();
  await first; await assert.rejects(second, /权限已撤销/); assert.equal(f.calls.length, 1);
});

test('browser guidance follows actual tool authority rather than old chat claims', () => {
  assert.match(executionGuidance({ tools: ['xiaozhushou_browser'], executionPolicy: 'trusted-computer-task-v1' }), /先读取 action=tools/);
  assert.equal(executionGuidance({ tools: ['xiaozhushou_browser'] }), '');
});
