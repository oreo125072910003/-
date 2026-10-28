import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPortableWechat } from '../packages/dsh-plugin/portable-wechat.mjs';
import { createPortableWechat as createSharedPortableWechat } from '../packages/wechat-bridge/portable.mjs';
import { runReaderSetup } from '../代码/项目/scripts/reader-setup.mjs';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, dependencies = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-wechat-test-')), packageRoot = path.join(base, 'plugin'), dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir);
  const content = { 'wechat-client/Weixin.exe': 'fixture-client', 'wechat-client/version.dll': 'fixture-hook', 'wechat-client/4.1.10.27/Weixin.dll': 'fixture-core', 'python/python.exe': 'fixture-python', 'reader/scripts/reader-api.py': '# fixture' };
  const files = Object.entries(content).map(([name, body]) => { const filename = path.join(packageRoot, 'companions', name); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, body); return { path: name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }; });
  fs.writeFileSync(path.join(packageRoot, 'companions/manifest.json'), JSON.stringify({ schemaVersion: 1, clientVersion: '4.1.10.27', files, hookSha256: files[1].sha256 }));
  const portable = createPortableWechat({ packageRoot, dataDir, payloadRoot: projectRoot, dependencies });
  t.after(async () => { await portable.close(); if (path.dirname(path.resolve(base)) !== path.resolve(os.tmpdir()) || !path.basename(base).startsWith('portable-wechat-test-')) throw Error('Unexpected cleanup path'); fs.rmSync(base, { recursive: true, force: true }); });
  return { portable, dataDir, root: path.join(dataDir, 'wechat-environment'), packageRoot, base };
}
async function done(portable) { for (let i = 0; i < 300; i++) { const state = portable.status(); if (state.job?.state !== 'running') return state; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Setup job timeout'); }

test('DSH and desktop use the identical portable WeChat implementation', () => {
  assert.equal(createPortableWechat, createSharedPortableWechat);
});

test('fresh preparation copies immutable components, creates new secrets and keeps replies unconfigured', async t => {
  const first = fixture(t), second = fixture(t); first.portable.prepare(); second.portable.prepare();
  assert.equal((await done(first.portable)).job.state, 'succeeded'); assert.equal((await done(second.portable)).job.state, 'succeeded');
  assert.equal(fs.readFileSync(path.join(first.root, 'state/hook/wechat-4.1.10.27/Weixin.exe'), 'utf8'), 'fixture-client');
  assert.equal(fs.existsSync(path.join(first.root, 'scripts/reader-api.py')), true);
  const token = fs.readFileSync(path.join(first.root, 'state/hook/native-token.txt'), 'utf8'); assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, fs.readFileSync(path.join(second.root, 'state/hook/native-token.txt'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(first.root, 'config/wechatagent.json')));
  assert.equal(config.runtime.python, path.join(first.root, 'python/python.exe')); assert.equal(config.runtime.replyOwner, 'desktop');
  assert.deepEqual(config.wechat.whitelist, { private: [], groups: [] }); assert.equal(first.portable.status().accountConfigured, false);
  first.portable.prepare(); await done(first.portable); assert.equal(fs.readFileSync(path.join(first.root, 'state/hook/native-token.txt'), 'utf8'), token);
});

test('a modified bundled file fails before installing a usable environment', async t => {
  const env = fixture(t); fs.writeFileSync(path.join(env.packageRoot, 'companions/wechat-client/version.dll'), 'modified'); env.portable.prepare();
  const result = await done(env.portable); assert.equal(result.job.state, 'failed'); assert.match(result.job.message, /校验失败/); assert.equal(fs.existsSync(env.root), false);
});

test('binding verifies the live account before capture and leaves a mismatched account untouched', async t => {
  let captured = false;
  const env = fixture(t, { runReaderSetup: async ({ request }) => { if (request.operation !== 'discover') captured = true; return { ok: true, accounts: [{ dbPath: 'synthetic-account', myWxid: 'fixture', ready: true }] }; }, verifyWeChatAccount: async () => { throw Error('HOOK_ACCOUNT_MISMATCH'); } });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  env.portable.bind({ accountId: env.portable.status().accounts[0].id }, { getWechatState: async () => ({ settings: {}, connection: { state: 'offline' } }) });
  const result = await done(env.portable); assert.equal(result.job.state, 'failed'); assert.equal(result.job.code, 'HOOK_ACCOUNT_MISMATCH'); assert.match(result.job.message, /账号不一致/); assert.equal(captured, false); assert.equal(result.accountConfigured, false);
});

test('first binding persists protected credentials and imports a manual-only product connection', async t => {
  let account; const calls = [];
  const env = fixture(t, { runReaderSetup: async ({ request }) => request.operation === 'discover' ? { ok: true, accounts: [account] } : { ok: true, ...account, protectedKey: 'userdpapi:c3ludGhldGlj' }, verifyWeChatAccount: async () => ({ ready: true }) });
  account = { dbPath: path.join(env.base, 'account'), myWxid: 'fixture-account', ready: true }; fs.mkdirSync(path.join(account.dbPath, 'db_storage'), { recursive: true });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  const service = { getWechatState: async () => ({ settings: {}, connection: { state: 'offline' } }), importWechatConnection: async root => calls.push(['import', root]), saveWechatSettings: async value => calls.push(['settings', value]), connectWechat: async () => ({ connection: { accountVerified: true } }) };
  env.portable.bind({ accountId: env.portable.status().accounts[0].id }, service);
  const result = await done(env.portable); assert.equal(result.job.state, 'succeeded'); assert.equal(result.accountConfigured, true);
  const stored = JSON.parse(fs.readFileSync(path.join(env.root, 'state/weflow/WeFlow-config.json'))); assert.equal(stored.decryptKey, 'userdpapi:c3ludGhldGlj');
  assert.deepEqual(calls, [['import', env.root], ['settings', { autoConnect: true, autoReply: false }]]);
});

test('an aborted first-run setup never starts a reader process', async () => {
  const controller = new AbortController(); controller.abort(Error('fixture cancellation'));
  await assert.rejects(runReaderSetup({ root: 'unused', python: 'unused', request: {}, signal: controller.signal }), /fixture cancellation/);
});

test('preparation preserves an existing unowned environment and all files in it', async t => {
  const env = fixture(t); fs.mkdirSync(env.root); const sentinel = path.join(env.root, 'original-account.txt');
  fs.writeFileSync(sentinel, 'existing-data'); env.portable.prepare();
  const state = await done(env.portable);
  assert.equal(state.job.state, 'failed'); assert.match(state.job.message, /原目录保留/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing-data'); assert.equal(state.prepared, false);
});

test('manifest traversal cannot write outside the component staging directory', async t => {
  const env = fixture(t), manifestFile = path.join(env.packageRoot, 'companions/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.files[0].path = 'reader/../../outside.txt';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest)); env.portable.prepare();
  const state = await done(env.portable); assert.equal(state.job.state, 'failed'); assert.equal(fs.existsSync(env.root), false);
  assert.equal(fs.existsSync(path.join(env.dataDir, 'outside.txt')), false); assert.equal(fs.existsSync(path.join(env.packageRoot, 'outside.txt')), false);
});

test('existing imported or active connections block binding before capture, settings or credential writes', async t => {
  let capture = 0, writes = 0;
  const account = { dbPath: 'synthetic-account', myWxid: 'fixture', ready: true };
  const env = fixture(t, { runReaderSetup: async ({ request }) => { if (request.operation !== 'discover') capture++; return { ok: true, accounts: [account] }; },
    verifyWeChatAccount: async () => { throw Error('must not verify a replacement'); }, applyReaderAccount: () => writes++ });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  const accountId = env.portable.status().accounts[0].id;
  for (const existing of [{ settings: { connectionImported: true }, connection: { state: 'offline' } }, { settings: {}, connection: { state: 'ready' } }, { settings: {}, connection: { state: 'connecting' } }]) {
    env.portable.bind({ accountId }, { getWechatState: async () => existing, importWechatConnection: async () => writes++ });
    const state = await done(env.portable); assert.equal(state.job.state, 'failed'); assert.match(state.job.message, /已有微信连接/);
  }
  assert.equal(capture, 0); assert.equal(writes, 0); assert.equal(env.portable.status().accountConfigured, false);
});

test('a connection imported while first-run capture waits is preserved at the final binding check', async t => {
  let releaseCapture, captureStarted;
  const started = new Promise(resolve => captureStarted = resolve), account = { dbPath: 'synthetic-account', myWxid: 'fixture', ready: true }, writes = [];
  let existing = { settings: {}, connection: { state: 'offline' } };
  const env = fixture(t, { runReaderSetup: async ({ request }) => request.operation === 'discover' ? { ok: true, accounts: [account] } : (captureStarted(), await new Promise(resolve => releaseCapture = () => resolve({ ok: true, ...account, protectedKey: 'userdpapi:c3ludGhldGlj' }))),
    verifyWeChatAccount: async () => ({ ready: true }), applyReaderAccount: () => writes.push('credentials') });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  env.portable.bind({ accountId: env.portable.status().accounts[0].id }, { getWechatState: async () => existing, importWechatConnection: async () => writes.push('import'), saveWechatSettings: async () => writes.push('settings'), connectWechat: async () => writes.push('connect') });
  await started; existing = { settings: { connectionImported: true }, connection: { state: 'ready' } }; releaseCapture();
  const result = await done(env.portable); assert.equal(result.job.state, 'failed'); assert.match(result.job.message, /已有微信连接/);
  assert.deepEqual(writes, []); assert.equal(result.accountConfigured, false);
});

test('closing first-run setup discards a late successful capture without persisting or importing it', async t => {
  let releaseCapture, captureStarted;
  const started = new Promise(resolve => captureStarted = resolve), account = { dbPath: 'synthetic-account', myWxid: 'fixture', ready: true }, writes = [];
  const env = fixture(t, { runReaderSetup: async ({ request }) => request.operation === 'discover' ? { ok: true, accounts: [account] } : (captureStarted(), await new Promise(resolve => releaseCapture = () => resolve({ ok: true, ...account, protectedKey: 'userdpapi:c3ludGhldGlj' }))),
    verifyWeChatAccount: async () => ({ ready: true }), applyReaderAccount: () => writes.push('credentials') });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  env.portable.bind({ accountId: env.portable.status().accounts[0].id }, { getWechatState: async () => ({ settings: {}, connection: { state: 'offline' } }), importWechatConnection: async () => writes.push('import'), saveWechatSettings: async () => writes.push('settings'), connectWechat: async () => writes.push('connect') });
  await started; const closed = env.portable.close(); releaseCapture(); await closed;
  assert.equal(env.portable.status().job.state, 'failed'); assert.deepEqual(writes, []); assert.equal(env.portable.status().accountConfigured, false);
  assert.throws(() => env.portable.prepare(), /退出/);
});

test('unselected and not-ready account IDs never become credential capture requests', async t => {
  let captures = 0;
  const env = fixture(t, { runReaderSetup: async ({ request }) => { if (request.operation !== 'discover') captures++; return { ok: true, accounts: [{ dbPath: 'synthetic-account', myWxid: 'fixture', ready: false }] }; } });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await done(env.portable);
  for (const accountId of ['forged-account', env.portable.status().accounts[0].id]) {
    env.portable.bind({ accountId, dbPath: 'untrusted-path' }, { getWechatState: async () => { throw Error('must not inspect or change original connection'); } });
    const state = await done(env.portable); assert.equal(state.job.state, 'failed'); assert.match(state.job.message, /请选择已完成同步的账号/);
  }
  assert.equal(captures, 0);
});

test('closing during discovery does not expose account results returned after cancellation', async t => {
  let release, markStarted;
  const started = new Promise(resolve => markStarted = resolve);
  const env = fixture(t, { runReaderSetup: async () => { markStarted(); return new Promise(resolve => release = () => resolve({ ok: true, accounts: [{ dbPath: 'synthetic-account', myWxid: 'late-account', ready: true }] })); } });
  env.portable.prepare(); await done(env.portable); env.portable.discover(); await started;
  const closed = env.portable.close(); release(); await closed;
  assert.equal(env.portable.status().job.state, 'failed'); assert.deepEqual(env.portable.status().accounts, []);
});
