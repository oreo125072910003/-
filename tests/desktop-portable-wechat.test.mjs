import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDesktopWechatSetup } from '../apps/desktop/wechat-setup.mjs';
import { PORTABLE_WECHAT_METHODS } from '../packages/contracts/ui-service-methods.mjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));

test('the five desktop WeChat setup channels enforce the real trusted frame guard before dispatch', async () => {
  const main = fs.readFileSync(new URL('../apps/desktop/main.cjs', import.meta.url), 'utf8');
  const registration = main.slice(main.indexOf('async function registerIPC(){'), main.indexOf('async function smokeTest(){'));
  const guard = main.slice(main.indexOf('function trusted(event)'), main.indexOf('function bringForward()'));
  const handlers = new Map(), calls = [], entry = 'file:///synthetic/renderer/index.html', mainFrame = { url: entry };
  let destroyed = false;
  const contents = { mainFrame }, window = { webContents: contents, isDestroyed: () => destroyed };
  const desktopWechat = { invoke: async (method, args) => { calls.push([method, plain(args)]); return { method }; } };
  const context = vm.createContext({ ipcMain: { handle(name, handler) { assert.equal(handlers.has(name), false); handlers.set(name, handler); } }, window, entry, desktopWechat, service: {}, path, pathToFileURL, projectRoot });
  vm.runInContext(guard + registration, context, { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  await vm.runInContext('registerIPC()', context);
  for (const method of PORTABLE_WECHAT_METHODS) {
    const handler = handlers.get('assistant:' + method); assert.equal(typeof handler, 'function', method);
    for (const event of [{}, { sender: {}, senderFrame: mainFrame }, { sender: contents, senderFrame: { url: entry } }]) await assert.rejects(handler(event, 'untrusted'), /无权/);
    mainFrame.url = 'https://foreign.invalid/'; await assert.rejects(handler({ sender: contents, senderFrame: mainFrame }), /无权/); mainFrame.url = entry;
    destroyed = true; await assert.rejects(handler({ sender: contents, senderFrame: mainFrame }), /无权/); destroyed = false;
    assert.deepEqual(plain(await handler({ sender: contents, senderFrame: mainFrame }, { accountId: 'fixture' })), { method });
  }
  assert.deepEqual(calls, PORTABLE_WECHAT_METHODS.map(name => [name, [{ accountId: 'fixture' }]]));
});

test('desktop setup keeps package roots and discovery requests fixed while binding only a discovered account', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-wechat-setup-')), packageRoot = path.join(base, 'package'), dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir); const files = Object.entries({ 'wechat-client/Weixin.exe': 'fixture-client', 'wechat-client/version.dll': 'fixture-hook', 'python/python.exe': 'fixture-python', 'reader/scripts/reader-api.py': '# fixture' }).map(([name, body]) => {
    const filename = path.join(packageRoot, 'companions', name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, body);
    return { path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  });
  fs.writeFileSync(path.join(packageRoot, 'companions/manifest.json'), JSON.stringify({ schemaVersion: 1, clientVersion: '4.1.10.27', hookSha256: files[1].sha256, files }));
  const root = path.join(dataDir, 'wechat-environment'), account = { dbPath: path.join(base, 'synthetic-account'), myWxid: 'fixture', ready: true };
  const requests = [], launches = [], writes = []; let connectionImported = false;
  const service = { getWechatState: async () => ({ settings: { connectionImported }, connection: { state: 'offline' } }), importWechatConnection: async value => writes.push(['import', value]), saveWechatSettings: async value => writes.push(['settings', value]), connectWechat: async () => ({ connection: { accountVerified: true } }) };
  const setup = createDesktopWechatSetup({ packageRoot, payloadRoot: projectRoot, dataDir, getService: () => service, dependencies: {
    ensureWechatClient: async (...args) => launches.push(args),
    runReaderSetup: async ({ request }) => { requests.push(request); return request.operation === 'discover' ? { ok: true, accounts: [account] } : { ok: true, ...account, protectedKey: 'userdpapi:c3ludGhldGlj' }; },
    verifyWeChatAccount: async () => ({ ready: true }), applyReaderAccount: (root, _previous, settings) => writes.push(['credentials', root, settings]),
  } });
  t.after(async () => { await setup.close(); fs.rmSync(base, { recursive: true, force: true }); });
  async function finished() { for (let i = 0; i < 300; i++) { const state = await setup.invoke('getPortableWechatState'); if (state.job?.state !== 'running') return state; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('desktop setup did not finish'); }
  const injection = { packageRoot: 'foreign-package', dataDir: 'foreign-data', operation: 'connect', dbPath: 'foreign-account', python: 'foreign-program' };
  await setup.invoke('preparePortableWechat', [injection]); assert.equal((await finished()).job.state, 'succeeded');
  assert.equal(fs.readFileSync(path.join(root, 'state/hook/wechat-4.1.10.27/Weixin.exe'), 'utf8'), 'fixture-client');
  await setup.invoke('openPortableWechat', [injection]); assert.equal((await finished()).job.state, 'succeeded');
  assert.equal(launches[0][0].sourceDirectory, root); assert.equal(launches[0][1].dataDir, dataDir);
  await setup.invoke('discoverPortableWechat', [injection]); const discovered = await finished(); assert.equal(discovered.job.state, 'succeeded');
  assert.deepEqual(requests, [{ operation: 'discover' }]); assert.equal(JSON.stringify(discovered).includes(account.dbPath), false);
  await setup.invoke('bindPortableWechat', [{ ...injection, accountId: discovered.accounts[0].id }, { service: 'foreign-service' }]); assert.equal((await finished()).job.state, 'succeeded');
  assert.deepEqual(requests[1], { operation: 'connect', dbPath: account.dbPath, myWxid: account.myWxid, autoKey: true, wechatExecutable: path.join(root, 'state/hook/wechat-4.1.10.27/Weixin.exe') });
  assert.deepEqual(writes, [['credentials', root, { dbPath: account.dbPath, myWxid: account.myWxid, decryptKey: 'userdpapi:c3ludGhldGlj' }], ['import', root], ['settings', { autoConnect: true, autoReply: false }]]);
  connectionImported = true; assert.equal((await setup.invoke('getPortableWechatState')).connectionImported, true);
  await assert.rejects(setup.invoke('run_local_shell', [injection]), /没有这个微信准备操作/);
});

test('a lightweight desktop package reports unavailable setup without changing an existing connection', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-wechat-light-')); let calls = 0;
  const setup = createDesktopWechatSetup({ packageRoot: base, payloadRoot: projectRoot, dataDir: base, getService: () => ({ getWechatState: async () => ({ settings: { connectionImported: true }, connection: { state: 'ready' } }) }), dependencies: { ensureWechatClient: async () => calls++ } });
  t.after(async () => { await setup.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const state = await setup.invoke('getPortableWechatState'); assert.equal(state.available, false); assert.equal(state.connectionImported, true);
  for (const method of PORTABLE_WECHAT_METHODS.filter(name => name !== 'getPortableWechatState')) await assert.rejects(setup.invoke(method, [{ accountId: 'synthetic' }]), /轻量包没有专用微信组件/);
  assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(base, 'wechat-environment')), false);
});
