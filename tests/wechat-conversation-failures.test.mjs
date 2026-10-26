import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantService } from '../apps/service/index.mjs';
import { knownModelFailure } from '../packages/contracts/model-failure.mjs';

const sessionA = 'xzs-' + 'a'.repeat(32);
const sessionB = 'xzs-' + 'b'.repeat(32);
const waitFor = async predicate => {
  const deadline = Date.now() + 6000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error('合成微信会话没有完成预期状态转换');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

// All model replies, account state and outbound receipts are local fixtures.
// This exercises the production service/database without contacting WeChat.
async function fixture(t, outcomes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-conversation-failures-'));
  const source = path.join(root, 'legacy'), dataDir = path.join(root, 'product');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.mkdirSync(path.join(source, 'state', 'hook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config', 'wechatagent.json'), JSON.stringify({
    runtime: { sender: 'wechat-hook', weflowMode: 'nt' },
    hook: { expectedVersion: '4.1.10.27', baseUrl: 'http://127.0.0.1:30001' },
    wechat: { whitelist: { private: ['101'], groups: [] }, wake_mode: 'mention', wake_words: ['小助手'] },
  }));
  fs.writeFileSync(path.join(source, 'state', 'wechat-io-config.json'), JSON.stringify({
    reader_base_url: 'http://127.0.0.1:5031', reader_token: 'synthetic-conversation-failure-reader-token',
  }));
  fs.writeFileSync(path.join(source, 'state', 'hook', 'native-token.txt'), 'a'.repeat(64));
  const secrets = new Map(), requests = [], sends = [];
  let callbacks, service, serial = 0;
  const secretStore = {
    get: async key => secrets.get(key), set: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key),
  };
  const runtime = {
    inspectHostedRuntime: async () => ({ available: true, ready: true, modelVerified: true }),
    readHostedCatalog: async () => ({ ok: true, metadataOnly: true, skills: [], tools: [] }),
    runHostedTask: async options => {
      requests.push(options);
      assert.ok(requests.length <= outcomes.length, 'failed rounds must not create hidden retries');
      return structuredClone(outcomes[requests.length - 1]);
    },
  };
  const create = () => createAssistantService({
    dataDir, runtime, secretStore, legacySources: [{ id: 'legacy', kind: 'wechatagent', path: source }],
    wechatBridgeFactory: options => {
      callbacks = options;
      return {
        start: async () => options.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true }),
        stop: async () => {},
        sendText: async value => {
          sends.push(value);
          return { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: String(sends.length) };
        },
      };
    },
  });
  t.after(async () => { await service?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  service = await create();
  await service.importWechatConnection(source, { automatic: true });
  return {
    requests, sends,
    get service() { return service; },
    emit() {
      callbacks.onMessage({
        self_id: '777', kind: 'private', conversation_id: '101', sender_id: '101', sender_name: '合成联系人',
        conversation_name: '合成持续会话', text: '合成测试消息 ' + (++serial), message_id: 'failure-review-' + serial,
        time: Math.ceil(Date.now() / 1000),
      });
    },
    async settled(count) {
      await waitFor(async () => requests.length === count && service.listTasks().length === count &&
        service.listTasks().every(task => ['succeeded', 'failed'].includes(task.status)) &&
        (await service.getWechatState()).autoReply.active === 0);
    },
    async restart() {
      await service.close(); service = await create(); await service.resumeWechatOnStartup();
    },
  };
}

test('a failed initial Harness setup cannot poison the next WeChat conversation with an unowned session', async t => {
  const f = await fixture(t, [
    { ok: false, finalText: '', sessionId: sessionA, error: { code: 'SESSION_GROUP_UNAVAILABLE', message: '合成分类服务尚未就绪' } },
    { ok: true, finalText: '连接恢复后的完整回复。', sessionId: sessionB },
  ]);
  f.emit(); await f.settled(1);
  assert.equal(f.requests[0].sessionId, undefined);
  assert.equal(f.service.listTasks()[0].status, 'failed');
  assert.equal(f.sends.length, 0, 'a failed round must never be sent');
  await f.restart();
  assert.equal(f.requests.length, 1, 'restart must not replay the failed inbound message');
  f.emit(); await f.settled(2);
  assert.equal(f.requests[1].sessionId, undefined, 'retry must create a real session rather than resume the orphan ID');
  assert.equal(f.requests[1].workspace, f.requests[0].workspace);
  assert.deepEqual(f.requests[1].conversation, f.requests[0].conversation);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].text, '连接恢复后的完整回复。');
});

test('a failed later Harness turn preserves the established WeChat session across restart', async t => {
  const f = await fixture(t, [
    { ok: true, finalText: '第一轮已经建立记忆。', sessionId: sessionA },
    { ok: false, finalText: '', sessionId: sessionA, error: { code: 'MODEL_TURN_FAILED', message: '合成模型暂时不可用' } },
    { ok: true, finalText: '恢复后继续原来的会话。', sessionId: sessionA },
  ]);
  f.emit(); await f.settled(1);
  f.emit(); await f.settled(2);
  assert.equal(f.requests[1].sessionId, sessionA);
  assert.equal(f.sends.length, 1, 'only the successful first round may be sent');
  assert.equal(f.service.listTasks().filter(task => task.status === 'failed').length, 1);
  await f.restart();
  assert.equal(f.requests.length, 2, 'restart must not retry a failed model turn');
  f.emit(); await f.settled(3);
  assert.equal(f.requests[2].sessionId, sessionA, 'the established conversation memory must survive the failed turn');
  assert.equal(f.requests[2].workspace, f.requests[0].workspace);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1].text, '恢复后继续原来的会话。');
});

test('quota failure reports the actionable reason once and preserves the conversation for recovery', async t => {
  const quota = knownModelFailure({ code: 'ACCOUNT_QUOTA' });
  const f = await fixture(t, [
    { ok: true, finalText: '已建立持续会话。', sessionId: sessionA },
    { ok: false, finalText: '', sessionId: sessionA, error: quota },
    { ok: true, finalText: '账户恢复后继续回答。', sessionId: sessionA },
  ]);
  assert.equal((await f.service.restoreProductFeatures()).wechat.restored, true);
  f.emit(); await f.settled(1);
  f.emit(); await f.settled(2);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1].text, quota.message);
  assert.doesNotMatch(f.sends[1].text, /我会接着处理|secret-account-material/);
  assert.equal((await f.service.getWechatState()).autoReply.lastError.code, 'ACCOUNT_QUOTA');
  await f.restart();
  assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 2, 'restart must not replay a quota failure or its notice');
  f.emit(); await f.settled(3);
  assert.equal(f.requests[2].sessionId, sessionA);
  assert.equal(f.sends[2].text, '账户恢复后继续回答。');
});
