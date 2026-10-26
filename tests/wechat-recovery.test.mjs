import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createWechatRuntime } from '../apps/service/wechat-runtime.mjs';
import { createWechatController } from '../apps/service/wechat.mjs';
import { createStore } from '../packages/storage/index.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 3000; while (!await check()) { assert.ok(Date.now() < end, 'recovery did not settle'); await sleep(10); } }
function runtimeFixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-reader-recovery-'));
  fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'state')); fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/reader-api.py'), '# synthetic test only');
  const project = { runtime: { sender: 'wechat-hook', weflowMode: 'nt', python: process.execPath }, ports: { weflow: 5031 } };
  const config = { readerBaseUrl: 'http://127.0.0.1:5031', readerToken: 'synthetic-reader-token', sourceDirectory: root };
  fs.writeFileSync(path.join(root, 'config/wechatagent.json'), JSON.stringify(project));
  fs.writeFileSync(path.join(root, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: config.readerBaseUrl, reader_token: config.readerToken }));
  let ready = false, starts = 0;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, unref() {} });
  const runtime = createWechatRuntime({ dataDir: root, startupMs: 250, pollMs: 5,
    ensureClient: async () => ({ ready: true }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: ready, backend: 'weflow-cli-nt', selfEvents: 'account-conversation-v1' }) }),
    portOpenImpl: async () => false,
    spawnImpl: (exe, args, options) => {
      starts++; assert.equal(exe, process.execPath); assert.deepEqual(args, ['-X', 'utf8', path.join(root, 'scripts/reader-api.py')]);
      assert.equal(options.windowsHide, true); assert.equal(options.cwd, root);
      setImmediate(() => { ready = child.exitCode === null; child.emit('spawn'); }); return child;
    }, ...extra });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runtime, config, child, starts: () => starts, setReady(value) { ready = value; } };
}

test('cold start launches only the existing reader once; concurrent callers and later launches reuse it', async t => {
  const f = runtimeFixture(t);
  const a = f.runtime.ensure(f.config), b = f.runtime.ensure(f.config);
  assert.equal(a, b); assert.equal((await a).started, true); assert.equal(f.starts(), 1);
  assert.equal((await f.runtime.ensure(f.config)).started, false); assert.equal(f.starts(), 1);
});

test('a healthy reader still checks the matching client, and login completion continues without starting another reader', async t => {
  let loginRequired = true, checks = 0;
  const f = runtimeFixture(t, { ensureClient: async () => { checks++; return { ready: true, loginRequired }; } });
  f.setReady(true);
  await assert.rejects(f.runtime.ensure(f.config), { code: 'HOOK_LOGIN_REQUIRED' });
  assert.equal(f.starts(), 0);
  loginRequired = false;
  assert.equal((await f.runtime.ensure(f.config)).ready, true);
  assert.equal(checks, 2); assert.equal(f.starts(), 0);
});

test('an incompatible running client stops before starting the reader or a replacement responder', async t => {
  const f = runtimeFixture(t, { ensureClient: async () => { throw Object.assign(Error('WECHAT_OTHER_CLIENT_RUNNING'), { code: 'WECHAT_OTHER_CLIENT_RUNNING' }); } });
  await assert.rejects(f.runtime.ensure(f.config), { code: 'WECHAT_OTHER_CLIENT_RUNNING' });
  assert.equal(f.starts(), 0);
});

test('an occupied port or changed connection credentials never launches a replacement process', async t => {
  const f = runtimeFixture(t, { portOpenImpl: async () => true });
  await assert.rejects(f.runtime.ensure(f.config), /端口已占用/); assert.equal(f.starts(), 0);
  await assert.rejects(f.runtime.ensure({ ...f.config, readerToken: 'different-token' }), /不一致/); assert.equal(f.starts(), 0);
});

test('startup cancellation stops waiting; failed readers can be started again without legacy responders', async t => {
  const f = runtimeFixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.ensure(f.config, { signal: controller.signal }), /abort/i); assert.equal(f.starts(), 0);
  await f.runtime.ensure(f.config); f.child.exitCode = 1; f.setReady(false);
  // A new child may fail too: the parent still reports failure instead of readiness.
  await assert.rejects(f.runtime.ensure(f.config), /启动失败/); assert.equal(f.starts(), 2);
});

async function controllerFixture(t, start) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-wechat-recovery-')), store = await createStore(path.join(root, 'db'));
  store.saveSettings({ wechatConnection: { connectionId: 'synthetic-connection', autoReply: true, autoConnect: true, allowedPrivate: ['101'] } });
  let count = 0, callbacks;
  const controller = createWechatController({ store, dataDir: root, recoveryMs: 25,
    secretStore: { get: async () => JSON.stringify({ connectionId: 'synthetic-connection', readerToken: 'synthetic-reader-token' }) },
    createTask: async () => { throw Error('no inbound messages in recovery test'); }, getTask: () => null,
    bridgeFactory: value => { callbacks = value; return { start: async () => { count++; await start(count, value); }, stop: async () => {} }; },
  });
  t.after(async () => { await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller, count: () => count, callbacks: () => callbacks };
}

test('initial reader failure retries automatically, then manual disconnect stays disconnected', async t => {
  const f = await controllerFixture(t, async (count, callbacks) => {
    if (count === 1) throw Error('READER_NOT_LISTENING');
    callbacks.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true });
  });
  await assert.rejects(f.controller.connect(), /读取服务/);
  await until(async () => (await f.controller.getState()).connection.state === 'ready'); assert.equal(f.count(), 2);
  await f.controller.disconnect(); await sleep(80); assert.equal(f.count(), 2);
});

test('switching client and scanning login are waiting states, followed by automatic account verification', async t => {
  for (const [code, state] of [['WECHAT_OTHER_CLIENT_RUNNING', 'waiting_client'], ['HOOK_LOGIN_REQUIRED', 'waiting_login']]) {
    const f = await controllerFixture(t, async (count, callbacks) => {
      if (count === 1) throw Object.assign(Error(code), { code });
      callbacks.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true });
    });
    const initial = await f.controller.connect();
    assert.equal(initial.connection.state, state);
    assert.equal(initial.connection.accountVerified, false);
    await until(async () => (await f.controller.getState()).connection.state === 'ready');
    assert.equal(f.count(), 2);
    assert.equal((await f.controller.getState()).outbox.length, 0);
    await f.controller.disconnect();
  }
});

test('account/version mismatch requires owner action; recovery never replays stored inbox messages', async t => {
  const f = await controllerFixture(t, async () => { throw Error('HOOK_ACCOUNT_MISMATCH'); });
  await assert.rejects(f.controller.connect(), /不一致/); await sleep(90); assert.equal(f.count(), 1);
  const state = await f.controller.getState(); assert.equal(state.messages.length, 0); assert.equal(state.outbox.length, 0);
});
