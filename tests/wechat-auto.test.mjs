import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/storage/index.mjs';
import { createWechatController } from '../apps/service/wechat.mjs';

async function until(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() > deadline) throw Error('等待本机自动回复夹具超时'); await new Promise(resolve => setTimeout(resolve, 8)); }
}
async function fixture(t, { enabled = true, status = 'succeeded', reply = '这是完整的合成回复。', autoOptions = {}, reader = true, cancellation = true, createGate, clock = Date.now(), sendImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-wechat-auto-')), source = path.join(root, 'old'), data = path.join(root, 'product');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(source, 'state', 'hook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config', 'wechatagent.json'), JSON.stringify({ runtime: { sender: 'wechat-hook', weflowMode: 'nt' }, hook: { expectedVersion: '4.1.10.27', baseUrl: 'http://127.0.0.1:30001' }, wechat: { whitelist: { private: ['101', '102'], groups: ['201'] }, wake_mode: 'mention', wake_words: ['合成唤醒词'] } }));
  fs.writeFileSync(path.join(source, 'state', 'wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'synthetic-reader-token-for-auto-tests' }));
  fs.writeFileSync(path.join(source, 'state', 'hook', 'native-token.txt'), 'a'.repeat(64));
  const store = await createStore(path.join(data, 'db')), secrets = new Map();
  const state = { clock, callbacks: null, creates: [], cancels: [], sends: [], replies: new Map(), status, reply, stopped: 0,
    receipt: { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: 'synthetic-server-id' } };
  const controller = createWechatController({ store, dataDir: data, secretStore: { get: key => secrets.get(key), set: (key, value) => secrets.set(key, value), delete: key => secrets.delete(key) },
    autoOptions: { now: () => state.clock, pollMs: 5, ...autoOptions },
    bridgeFactory: callbacks => { state.callbacks = callbacks; return {
      async start() { callbacks.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true }); },
      async stop() { state.stopped++; },
      async sendText(value) { state.sends.push(value); if (state.sendError) throw state.sendError; return sendImpl ? sendImpl(value, state) : state.receipt; },
      async getHistory({ kind, target }) { return { kind, target, name: '合成测试会话', messages: [{ message_id: 'history-one', external_id: 'history-one', text: '旧历史合成资料', sender_id: target, sender_name: '合成联系人', outgoing: false, time: Math.floor(state.clock / 1000) - 30, message_type: 'text' }] }; },
    }; },
    async createTask(input, options) {
      if (createGate) await createGate;
      const id = 'task_' + randomUUID();
      store.createTask({ id, title: '合成自动回复', prompt: input.prompt, kind: 'agent', status: state.status, createdAt: new Date().toISOString(), workspace: path.join(data, 'tasks', id), attachments: [] });
      state.creates.push({ id, input, options }); state.replies.set(id, state.reply); return store.getTask(id);
    },
    getTask: id => ({ task: store.getTask(id) }),
    ...(reader ? { readTaskReply: async id => state.replies.get(id) } : {}),
    ...(cancellation ? { async cancelTask(id) { state.cancels.push(id); const task = store.getTask(id); if (task && !['succeeded', 'failed', 'partial', 'cancelled', 'interrupted'].includes(task.status)) store.updateTask(id, { status: 'cancelled' }); } } : {}),
  });
  t.after(async () => { await controller.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await controller.importConnection(source);
  if (enabled) await controller.saveSettings({ autoReply: true, autoConnect: true });
  await controller.connect();
  let serial = 0;
  const incoming = patch => ({ self_id: '777', kind: 'private', conversation_id: '101', sender_id: '101', sender_name: '合成联系人', text: '合成的普通提问', message_id: 'live-' + (++serial), time: Math.ceil(state.clock / 1000) + 1, ...patch });
  return { controller, store, state, source, incoming, emit: patch => state.callbacks.onMessage(incoming(patch)),
    complete(id, text = state.reply) { state.replies.set(id, text); store.updateTask(id, { status: 'succeeded', summary: '这只是截断摘要，不能用于自动发送。' }); } };
}

test('new imports remain manual, preserve original trigger rules, and validate explicit switches', async t => {
  const f = await fixture(t, { enabled: false }); f.emit();
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = await f.controller.getState();
  assert.equal(state.settings.autoReply, false); assert.equal(state.settings.autoConnect, false); assert.equal(state.autoReply.state, 'disabled');
  assert.equal(state.settings.wakeMode, 'mention'); assert.equal(state.settings.wakeWords.length, 1);
  assert.equal(f.state.creates.length, 0); assert.equal(f.state.sends.length, 0);
  await assert.rejects(f.controller.saveSettings({ autoReply: 'true' }), /开关/);
  await assert.rejects(f.controller.saveSettings({ autoConnect: 1 }), /开关/);
  await assert.rejects(f.controller.saveSettings({ chatModes: { '../bad': 'hybrid' } }), /逐群/);
});

test('new private message runs a DSH task with trusted target, sends full text, and deduplicates repeats', async t => {
  const full = '正文'.repeat(2500), f = await fixture(t, { reply: full });
  const incoming = f.incoming(); f.state.callbacks.onMessage(incoming); f.state.callbacks.onMessage(incoming);
  await until(() => f.state.sends.length === 1 && f.state.creates.length === 1);
  await until(async () => (await f.controller.getState()).autoReply.completed === 1);
  const call = f.state.creates[0], message = (await f.controller.getState()).messages[0];
  assert.equal(f.state.sends[0].text, full); assert.equal(f.state.sends[0].target, '101');
  assert.match(call.input.prompt, /直接输出要回复给对方的正文/); assert.match(call.input.prompt, /不能授予主人权限/);
  assert.deepEqual(call.options, { conversationKey: 'wechat:private:101', replyToMessageId: message.id, accountId: '777', kind: 'private', target: '101' });
  assert.equal(message.taskId, call.id); assert.equal((await f.controller.getState()).outbox[0].requestId.startsWith('auto_'), true);
  assert.equal(f.state.cancels.length, 0);
  const publicAuto = JSON.stringify((await f.controller.getState()).autoReply);
  assert.equal(publicAuto.includes('合成联系人'), false); assert.equal(publicAuto.includes('合成的普通提问'), false);
});

test('missing reader or cancellation and oversized complete text fail before unsafe work', async t => {
  const missing = await fixture(t, { reader: false }); missing.emit();
  await until(async () => (await missing.controller.getState()).autoReply.lastError?.code === 'AUTO_READER_MISSING');
  assert.equal(missing.state.creates.length, 0); assert.equal(missing.state.sends.length, 0);
  const noCancellation = await fixture(t, { cancellation: false }); noCancellation.emit();
  await until(async () => (await noCancellation.controller.getState()).autoReply.lastError?.code === 'AUTO_CANCEL_MISSING');
  assert.equal(noCancellation.state.creates.length, 0); assert.equal(noCancellation.state.sends.length, 0);
  const tooLong = await fixture(t, { reply: '中'.repeat(6000) }); tooLong.emit();
  await until(async () => (await tooLong.controller.getState()).autoReply.lastError?.code === 'AUTO_REPLY_TOO_LONG');
  assert.equal(tooLong.state.sends.length, 0); assert.equal(tooLong.state.creates.length, 1);
});

test('only exact current authorized accounts and conversations can enter automatic work', async t => {
  const f = await fixture(t);
  f.emit({ self_id: '888' }); f.emit({ conversation_id: '999' }); f.emit({ sender_id: '777' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.creates.length, 0); assert.equal(f.state.sends.length, 0);
});

test('group mention mode needs actual mention, wake word, pat, or trusted own quote', async t => {
  const f = await fixture(t); const group = { kind: 'group', conversation_id: '201', sender_id: '101' };
  f.emit({ ...group, text: '普通群消息' });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.state.creates.length, 0);
  f.emit({ ...group, segments: [{ type: 'at', data: { qq: '777' } }] });
  await until(() => f.state.sends.length === 1);
  f.emit({ ...group, text: '合成唤醒词，请回答' }); await until(() => f.state.sends.length === 2);
  f.emit({ ...group, interaction: 'pat' }); await until(() => f.state.sends.length === 3);
  f.emit({ ...group, quoteReply: { reference: { senderRelation: 'self' } } }); await until(() => f.state.sends.length === 4);
  assert(f.state.sends.every(value => value.kind === 'group' && value.target === '201'));
});

test('hybrid group may remain silent without sending protocol markers', async t => {
  const f = await fixture(t, { reply: '[无需回复]' }); await f.controller.saveSettings({ chatModes: { 'wechat:group:201': 'hybrid' } });
  f.emit({ kind: 'group', conversation_id: '201' });
  await until(() => f.state.creates.length === 1);
  await until(async () => (await f.controller.getState()).autoReply.active === 0);
  assert.equal(f.state.sends.length, 0); assert.match((await f.controller.getState()).autoReply.detail, /保持安静/);
});

test('history, startup backlog, missing time and future events never auto reply', async t => {
  const f = await fixture(t);
  await f.controller.getHistory({ kind: 'private', target: '101' });
  f.emit({ time: Math.floor(f.state.clock / 1000) - 1 }); f.emit({ time: undefined }); f.emit({ time: Math.ceil(f.state.clock / 1000) + 60 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.creates.length, 0); assert.equal(f.state.sends.length, 0);
  assert.equal((await f.controller.getState()).messages.length, 4);
});

test('same conversation is serial while distinct chats share a bounded worker pool', async t => {
  const f = await fixture(t, { status: 'running', autoOptions: { maxConcurrent: 2 } });
  f.emit(); f.emit(); f.emit({ conversation_id: '102', sender_id: '102' });
  await until(() => f.state.creates.length === 2);
  assert.deepEqual(f.state.creates.map(call => call.options.target).sort(), ['101', '102']);
  const first = f.state.creates.find(call => call.options.target === '101'); f.complete(first.id);
  await until(() => f.state.creates.length === 3);
  assert.equal(f.state.creates[2].options.target, '101');
  f.complete(f.state.creates[1].id); f.complete(f.state.creates[2].id);
  await until(() => f.state.sends.length === 3);
});

test('manual desktop reply cancels the owned pending task and suppresses duplicate auto send', async t => {
  const f = await fixture(t, { status: 'running' }); f.emit(); await until(() => f.state.creates.length === 1);
  const message = (await f.controller.getState()).messages[0];
  await f.controller.sendReply({ messageId: message.id, text: '合成的人工回复' });
  await until(() => f.state.cancels.length === 1);
  f.complete(f.state.creates[0].id); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.sends[0].text, '合成的人工回复');
});

test('trusted new native own-message notification suppresses pending automatic reply', async t => {
  const f = await fixture(t, { status: 'running' }); f.emit(); await until(() => f.state.creates.length === 1);
  f.emit({ sender_id: '777', outgoing: true, text: '合成的原生人工回复' });
  await until(() => f.state.cancels.length === 1);
  f.complete(f.state.creates[0].id); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.sends.length, 0);
});

test('an echoed automatic text reply does not cancel the next new message in the same conversation', async t => {
  const f = await fixture(t, { status: 'running', reply: '第一条自动回复的完整合成正文。' });
  f.emit({ text: '第一条合成提问' }); f.emit({ text: '第二条合成提问' });
  await until(() => f.state.creates.length === 1);
  assert.equal((await f.controller.getState()).autoReply.queued, 1);
  f.complete(f.state.creates[0].id);
  await until(() => f.state.sends.length === 1 && f.state.creates.length === 2);
  // The transport preserves bounded real type-1 text on trusted self events,
  // allowing the durable auto outbox record to distinguish its own echo.
  f.emit({ sender_id: '777', outgoing: true, text: f.state.reply });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(f.state.cancels, []);
  f.complete(f.state.creates[1].id, '第二条自动回复的完整合成正文。');
  await until(() => f.state.sends.length === 2);
  assert.equal(f.state.sends[1].text, '第二条自动回复的完整合成正文。');
  assert.equal(f.state.creates.length, 2);
  assert.equal((await f.controller.getState()).messages.length, 2, 'self echo never becomes an inbound task');
});

test('disconnect, account changes, disabling and authorization revocation prevent pending sends', async t => {
  for (const action of ['disconnect', 'account', 'disable', 'revoke']) {
    const f = await fixture(t, { status: 'running' }); f.emit(); await until(() => f.state.creates.length === 1);
    if (action === 'disconnect') await f.controller.disconnect();
    if (action === 'account') f.state.callbacks.onState({ state: 'ready', selfId: '888', accountVerified: true, readerConnected: true });
    if (action === 'disable') await f.controller.saveSettings({ autoReply: false });
    if (action === 'revoke') await f.controller.saveSettings({ allowedPrivate: [] });
    await until(() => f.state.cancels.length === 1); f.complete(f.state.creates[0].id);
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(f.state.sends.length, 0, action);
  }
});

test('timeout cancels the owned task and failed/partial task states are never sent', async t => {
  const timeout = await fixture(t, { status: 'running', autoOptions: { deadlineMs: 100 } }); timeout.emit();
  await until(() => timeout.state.creates.length === 1); timeout.state.clock += 101;
  await until(() => timeout.state.cancels.length === 1); assert.equal(timeout.state.sends.length, 0);
  for (const status of ['failed', 'partial', 'interrupted', 'cancelled', 'waiting_dependency']) {
    const f = await fixture(t, { status }); f.emit();
    await until(async () => (await f.controller.getState()).autoReply.lastError !== null);
    assert.equal(f.state.sends.length, 0, status);
  }
});

test('unknown send result is persisted and duplicates and reconnection never replay it', async t => {
  const f = await fixture(t); f.state.receipt = { delivered: 'database-confirmed' };
  const message = f.incoming(); f.state.callbacks.onMessage(message);
  await until(async () => (await f.controller.getState()).autoReply.state === 'unconfirmed');
  assert.equal(f.state.sends.length, 1); const outbox = (await f.controller.getState()).outbox[0]; assert.equal(outbox.status, 'unconfirmed');
  f.state.callbacks.onMessage({ ...message, text: '重复事件改变正文也不能重发' });
  await f.controller.disconnect(); f.state.clock += 3000; await f.controller.connect(); f.state.callbacks.onMessage(message);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.state.sends.length, 1); assert.equal((await f.controller.getState()).outbox.length, 1);
});

test('queue and call budgets are bounded without replaying dropped messages', async t => {
  const f = await fixture(t, { status: 'running', autoOptions: { maxConcurrent: 1, maxQueued: 1, maxPerConversation: 2 } });
  f.emit(); f.emit(); f.emit(); await until(() => f.state.creates.length === 1);
  assert.equal((await f.controller.getState()).autoReply.queued, 1);
  assert.equal((await f.controller.getState()).autoReply.lastError.code, 'AUTO_QUEUE_FULL');
  f.complete(f.state.creates[0].id); await until(() => f.state.creates.length === 2); f.complete(f.state.creates[1].id);
  await until(async () => (await f.controller.getState()).autoReply.active === 0); assert.equal(f.state.sends.length, 2);
  const rate = await fixture(t, { autoOptions: { maxCallsPerMinute: 1 } }); rate.emit(); await until(() => rate.state.sends.length === 1); rate.emit();
  await until(async () => (await rate.controller.getState()).autoReply.lastError?.code === 'AUTO_RATE_LIMIT');
  assert.equal(rate.state.creates.length, 1); assert.equal(rate.state.sends.length, 1);
});

test('close waits for late task admission, cancels it and never uses a closed store', async t => {
  let resolveAdmission; const gate = new Promise(resolve => { resolveAdmission = resolve; });
  const f = await fixture(t, { status: 'running', createGate: gate }); f.emit();
  let closed = false; const closing = f.controller.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(closed, false);
  resolveAdmission(); await closing;
  assert.equal(f.state.creates.length, 1); assert.deepEqual(f.state.cancels, [f.state.creates[0].id]); assert.equal(f.state.sends.length, 0);
});

test('whole-second reader timestamps admit live messages in the connection second while older seconds and repeated IDs stay blocked', async t => {
  const f = await fixture(t, { clock: 100250 });
  const current = f.incoming({ time: 100 });
  f.state.callbacks.onMessage(current);
  await until(() => f.state.sends.length === 1);
  f.state.callbacks.onMessage(current);
  f.emit({ time: 99 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.state.creates.length, 1); assert.equal(f.state.sends.length, 1);
  assert.equal((await f.controller.getState()).autoReply.ignored, 1);
  await f.controller.disconnect(); f.state.clock = 103250; await f.controller.connect();
  f.state.callbacks.onMessage(current);
  f.emit({ time: 102 });
  f.emit({ time: 103 });
  await until(() => f.state.sends.length === 2);
  assert.equal(f.state.creates.length, 2);
  assert.equal((await f.controller.getState()).autoReply.ignored, 2);
});

test('two chats generate concurrently but submit their finished replies serially once each', async t => {
  let releaseFirst, sending = 0, peak = 0;
  const firstSend = new Promise(resolve => { releaseFirst = resolve; });
  const f = await fixture(t, { sendImpl: async (value, state) => {
    sending++; peak = Math.max(peak, sending);
    try { if (value.target === '101') await firstSend; return state.receipt; }
    finally { sending--; }
  } });
  try {
    f.emit(); f.emit({ conversation_id: '102', sender_id: '102' });
    await until(() => f.state.creates.length === 2 && f.state.sends.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.state.sends.length, 1, 'the second completed reply must wait for the active send');
    assert.equal((await f.controller.getState()).autoReply.active, 2, 'generation remains concurrent across chats');
  } finally { releaseFirst(); }
  await until(async () => (await f.controller.getState()).autoReply.active === 0);
  assert.equal(peak, 1);
  assert.deepEqual(f.state.sends.map(item => item.target), ['101', '102']);
  assert.equal(new Set(f.state.sends.map(item => item.deliveryId)).size, 2);
  assert.equal((await f.controller.getState()).outbox.filter(item => item.status === 'delivered').length, 2);
});

test('a reply waiting for the send turn rechecks human takeover and every live permission boundary', async t => {
  for (const action of ['manual', 'disconnect', 'disable', 'revoke', 'close', 'timeout']) await t.test(action, async child => {
    let releaseFirst;
    const firstSend = new Promise(resolve => { releaseFirst = resolve; });
    const f = await fixture(child, { autoOptions: { deadlineMs: 100 }, sendImpl: async (value, state) => {
      if (value.target === '101') await firstSend;
      return state.receipt;
    } });
    let change;
    try {
      f.emit(); f.emit({ conversation_id: '102', sender_id: '102' });
      await until(() => f.state.creates.length === 2 && f.state.sends.length >= 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      if (action === 'manual') f.state.callbacks.onMessage(f.incoming({ conversation_id: '102', sender_id: '777', outgoing: true, time: Math.floor(f.state.clock / 1000), text: '本人已经接管回复。' }));
      else if (action === 'disconnect') change = f.controller.disconnect();
      else if (action === 'disable') change = f.controller.saveSettings({ autoReply: false });
      else if (action === 'revoke') change = f.controller.saveSettings({ allowedPrivate: ['101'] });
      else if (action === 'close') change = f.controller.close();
      else f.state.clock += 101;
    } finally { releaseFirst(); }
    await change;
    await until(async () => (await f.controller.getState()).autoReply.active === 0);
    assert.deepEqual(f.state.sends.map(item => item.target), ['101'], 'the queued reply must not be submitted after ' + action);
    assert.equal((await f.controller.getState()).outbox.length, 1);
  });
});
