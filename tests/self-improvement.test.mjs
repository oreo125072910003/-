import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createExtensionManager } from '../packages/extensions/index.mjs';
import { createSelfImprovement } from '../apps/service/self-improvement.mjs';
import { createAssistantService } from '../apps/service/index.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-improvement-'));
  const ownerContext = Object.freeze({ owner: true }), sent = [];
  let data = {}, currentTime = Date.now();
  const store = { getSettings: () => structuredClone(data), saveSettings: value => { data = { ...data, ...structuredClone(value) }; } };
  const wx = { settings: { boundAccountId: '777', allowedPrivate: ['101','102'] }, connection: { state: 'ready', selfId: '777', accountVerified: true } };
  const extensions = await createExtensionManager({ dataDir: path.join(root, 'extensions'), authorize: async context => context === ownerContext });
  const wechat = { getState: () => wx, sendNotification: async value => { value.beforeSubmit(); sent.push(value); return { id: 'delivery_' + sent.length, status: 'delivered' }; } };
  const make = () => createSelfImprovement({ store, dataDir: root, extensions, ownerContext, wechat, now: () => currentTime, intervalMs: 3600000 });
  let service = make();
  t.after(async () => { await service.close(); await extensions.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const message = (text, extra = {}) => ({ id: 'wechat_live_' + Math.random(), source: 'live', outgoing: false, kind: 'private', accountId: '777', conversationId: '101', senderId: '101', messageType: 'text', text, ...extra });
  return { root, store, extensions, wx, sent, message, scope: { source: 'desktop', taskId: 'task_fixture' }, get service() { return service; },
    async enable() { return service.configure({ enabled: true, target: '101', ownerName: '合成审批联系人' }); },
    advance(ms) { currentTime += ms; },
    async reopen() { await service.close(); service = make(); },
  };
}
const memory = { operation: 'memory.set', target: 'reply-style', reason: '主人多次要求简洁回答', payload: { text: '日常闲聊优先简洁自然地接话。' } };
const skill = version => `---\nname: concise-replies\ndescription: 根据主人偏好组织答复\nmetadata:\n  version: '${version}'\n---\n先回答问题，再按需要补充依据。版本 ${version}。\n`;

test('only verified owner approval applies an immutable memory proposal, exactly once', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.propose(memory, f.scope), /绑定审批私聊/);
  await f.enable(); const p = await f.service.propose(memory, f.scope);
  assert.deepEqual(f.service.getState().memories, {}); assert.equal(p.notification, 'delivered');
  assert.match(f.sent[0].text, /日常闲聊优先简洁/); assert.match(f.sent[0].text, new RegExp(`同意 ${p.id}`));
  assert.equal(await f.service.handleMessage(f.message('好')), false);
  for (const extra of [{ senderId: '102' }, { conversationId: '102', senderId: '102' }, { kind: 'group' }, { accountId: '778' }, { outgoing: true }, { source: 'history' }, { messageType: 'image' }]) {
    assert.equal(await f.service.handleMessage(f.message(`同意 ${p.id}`, extra)), false);
    assert.deepEqual(f.service.getState().memories, {});
  }
  assert.equal(await f.service.handleMessage(f.message(`他说同意 ${p.id}`)), false);
  assert.equal(await f.service.handleMessage(f.message(`同意 ${p.id}`)), true);
  assert.equal(f.service.getState().memories['reply-style'].text, memory.payload.text);
  assert.equal(f.service.getState().proposals[0].status, 'applied'); assert.equal(f.service.getState().proposals[0].decision.senderId, '101');
  const sentCount = f.sent.length; await f.service.handleMessage(f.message(`同意 ${p.id}`)); assert.equal(f.sent.length, sentCount);
  assert.match(await f.service.context({ message: f.message('你好') }), /简洁自然/);
  assert.equal(await f.service.context({ message: f.message('你好', { conversationId: '102', senderId: '102' }) }), '');
});

test('rejection, expiry, rebinding and revocation never apply pending changes', async t => {
  const f = await fixture(t); await f.enable();
  const rejected = await f.service.propose(memory, f.scope); await f.service.handleMessage(f.message(`拒绝 ${rejected.id}`));
  assert.equal(f.service.getState().proposals[0].status, 'rejected');
  const expired = await f.service.propose(memory, f.scope); f.advance(86400001); await f.service.handleMessage(f.message(`同意 ${expired.id}`));
  assert.equal(f.service.getState().proposals[1].status, 'expired');
  const cancelled = await f.service.propose(memory, f.scope); await f.service.configure({ enabled: true, target: '102' });
  await f.service.handleMessage(f.message(`同意 ${cancelled.id}`));
  assert.equal(f.service.getState().proposals[2].status, 'cancelled'); assert.deepEqual(f.service.getState().memories, {});
  await f.service.configure({ enabled: false }); await assert.rejects(f.service.propose(memory, f.scope));
});

test('changed targets invalidate approval and interrupted application is not replayed after restart', async t => {
  const f = await fixture(t); await f.enable(); const p = await f.service.propose(memory, f.scope);
  const state = f.store.getSettings().selfImprovement; state.memories['reply-style'] = { text: '主人手动保存的更新' }; f.store.saveSettings({ selfImprovement: state });
  await f.service.handleMessage(f.message(`同意 ${p.id}`));
  assert.equal(f.service.getState().proposals[0].status, 'failed'); assert.equal(f.service.getState().memories['reply-style'].text, '主人手动保存的更新');
  const pending = await f.service.propose(memory, f.scope), saved = f.store.getSettings().selfImprovement;
  saved.proposals.find(item => item.id === pending.id).status = 'applying'; f.store.saveSettings({ selfImprovement: saved });
  await f.reopen(); assert.equal(f.service.getState().proposals[1].status, 'interrupted');
  await f.service.handleMessage(f.message(`同意 ${pending.id}`)); assert.equal(f.service.getState().memories['reply-style'].text, '主人手动保存的更新');
});

test('skill creation, version upgrade and rollback all require separate WeChat approvals', async t => {
  const f = await fixture(t); await f.enable();
  const propose = version => f.service.propose({ operation: 'skill.save', target: 'concise-replies', reason: '保留经任务验证的答复方法', payload: { content: skill(version) } }, f.scope);
  const first = await propose('1.0.0'); assert.equal(f.extensions.listSkills().length, 0);
  await f.service.handleMessage(f.message(`同意 ${first.id}`)); assert.equal(f.extensions.listSkills()[0].enabled, true);
  assert.match(await f.service.context(f.scope), /版本 1.0.0/);
  const second = await propose('1.1.0'); assert.equal(f.extensions.listSkills()[0].version, '1.0.0');
  await f.service.handleMessage(f.message(`同意 ${second.id}`)); assert.equal(f.extensions.listSkills()[0].version, '1.1.0');
  const rollback = await f.service.propose({ operation: 'skill.rollback', target: 'concise-replies', reason: '新版效果不如旧版' }, f.scope);
  assert.match(f.sent.at(-1).text, /版本 1.0.0/);
  await f.service.handleMessage(f.message(`同意 ${rollback.id}`)); assert.equal(f.extensions.listSkills()[0].version, '1.0.0'); assert.equal(f.extensions.listSkills()[0].enabled, false);
});

test('tampered skill draft and changed plugin entry cannot reuse an earlier approval', async t => {
  const f = await fixture(t); await f.enable();
  const draft = await f.service.propose({ operation: 'skill.save', target: 'concise-replies', reason: '测试草稿完整性', payload: { content: skill('1.0.0') } }, f.scope);
  fs.appendFileSync(path.join(draft.skill.directory, 'SKILL.md'), '\n外部改写');
  await f.service.handleMessage(f.message(`同意 ${draft.id}`)); assert.equal(f.extensions.listSkills().length, 0); assert.equal(f.service.getState().proposals[0].status, 'failed');
  const entry = path.join(f.root, 'plugin.mjs'); fs.writeFileSync(entry, 'process.exit(0)');
  const p = await f.service.propose({ operation: 'plugin.install', target: 'fixture', reason: '接入本机已有固定版本插件', payload: { version: '1.0.0', command: process.execPath, args: [entry], allowedTools: ['echo'] } }, f.scope);
  assert.equal(f.extensions.listMcp().length, 0); fs.appendFileSync(entry, '\n// changed');
  await f.service.handleMessage(f.message(`同意 ${p.id}`)); assert.equal(f.extensions.listMcp().length, 0); assert.equal(f.service.getState().proposals[1].status, 'failed');
});

test('plugin installation is pinned, stays disabled and needs another approval to enable', async t => {
  const f = await fixture(t); await f.enable();
  const p = await f.service.propose({ operation: 'plugin.install', target: 'fixture', reason: '导入已安装插件', payload: { version: '1.0.0', command: process.execPath, args: [], allowedTools: ['echo'] } }, f.scope);
  await f.service.handleMessage(f.message(`同意 ${p.id}`)); assert.equal(f.extensions.listMcp()[0].enabled, false);
  const enable = await f.service.propose({ operation: 'plugin.enable', target: 'fixture', reason: '启用已经核对的插件' }, f.scope);
  assert.equal(f.extensions.listMcp()[0].enabled, false); await f.service.handleMessage(f.message(`同意 ${enable.id}`)); assert.equal(f.extensions.listMcp()[0].enabled, true);
});

test('offline requests wait for the original private chat and uncertain sends are not repeated', async t => {
  const f = await fixture(t); await f.enable(); f.wx.connection.state = 'offline';
  const p = await f.service.propose(memory, f.scope); assert.equal(p.notification, 'waiting'); assert.equal(f.sent.length, 0);
  f.wx.connection.state = 'ready'; await f.service.tick(); assert.equal(f.sent.length, 1);
  await f.service.tick(); await f.reopen(); await f.service.tick(); assert.equal(f.sent.length, 1);
  await assert.rejects(f.service.propose(memory, f.scope), /相同提案/);
});

test('DSH proposal tool and the actual WeChat inbox complete approval without another model turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-improvement-integration-')), source = path.join(root, 'source'), dataDir = path.join(root, 'product');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(source, 'state/hook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config/wechatagent.json'), JSON.stringify({ runtime: { sender: 'wechat-hook', weflowMode: 'nt' }, hook: { baseUrl: 'http://127.0.0.1:30001', expectedVersion: '4.1.10.27' }, wechat: { whitelist: { private: ['101'], groups: ['202'] } } }));
  fs.writeFileSync(path.join(source, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'synthetic-reader-not-a-real-token' }));
  fs.writeFileSync(path.join(source, 'state/hook/native-token.txt'), 'a'.repeat(64));
  const secrets = new Map(), sent = [], calls = []; let callbacks, proposal;
  const runtime = { inspectHostedRuntime: async () => ({ available: true, detail: 'Synthetic DSH host', capabilities: {selfImprovement:true} }),
    runHostedTask: async options => {
      calls.push(options); assert(options.settings.hostedOwnerGrants.tools.includes('xiaozhushou_improve'));
      const connection = options.settings.hostedProductConnection;
      const result = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), name: 'xiaozhushou_improve', args: { action: 'propose', ...memory } }) });
      const body = await result.json(); assert.equal(body.isError, false, body.content); proposal = JSON.parse(body.content);
      return { ok: true, finalText: '已通过微信提出申请，等你批准。' };
    } };
  const service = await createAssistantService({ dataDir, runtime, secretStore: { get: async k => secrets.get(k), set: async (k, v) => secrets.set(k, v), delete: async k => secrets.delete(k) }, wechatBridgeFactory: handlers => {
    callbacks = handlers; return { start: async () => handlers.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true }), stop: async () => {},
      sendText: async value => { value.beforeSubmit(); sent.push(value); return { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: sent.length + 100 }; } };
  } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  await service.importWechatConnection(source); await service.connectWechat(); await service.configureSelfImprovement({ enabled: true, target: '101', ownerName: '合成审批联系人' });
  const task = await service.createTask({ prompt: '请记住我的回复偏好', kind: 'agent' });
  const until = async check => { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('integration deadline'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  await until(() => ['succeeded','failed','waiting_dependency'].includes(service.getTask(task.id).task.status));
  assert.equal(service.getTask(task.id).task.status, 'succeeded', JSON.stringify(service.getTask(task.id)));
  assert.deepEqual(service.getExtensionsState().selfImprovement.memories, {}); assert.equal(sent[0].target, '101');
  const incoming = { self_id: '777', kind: 'private', conversation_id: '101', sender_id: '101', message_id: '9001', text: `同意 ${proposal.id}`, time: Math.floor(Date.now() / 1000) };
  callbacks.onMessage(incoming); callbacks.onMessage(incoming);
  await until(() => service.getExtensionsState().selfImprovement.proposals[0].status === 'applied');
  await until(() => sent.length === 2);
  assert.equal(service.getExtensionsState().selfImprovement.memories['reply-style'].text, memory.payload.text);
  assert.equal(calls.length, 1); assert.equal(service.listTasks().length, 1); assert.equal(sent.length, 2);
});
