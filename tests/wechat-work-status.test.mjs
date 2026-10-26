import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWechatAutoResponder } from '../apps/service/wechat-auto.mjs';
import { splitWechatReply } from '../packages/contracts/wechat-delivery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../packages/storage/index.mjs';

async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error('未等到预期的交付状态');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture(t, options = {}) {
  let clock = 1000000, serial = 0, manual = false;
  const jobs = new Map(), sends = [], reports = [], cancelled = [];
  const api = createWechatAutoResponder({
    settings: () => ({ autoReply: true, ...options.settings }), ready: () => true, permitted: () => true,
    now: () => clock, pollMs: 5, progressAfterMs: 20, progressIntervalMs: 60000,
    async createTask() { const task = { id: 'task_' + randomUUID(), status: options.status ?? 'succeeded' }; jobs.set(task.id, task); return task; },
    getTask: id => ({ task: jobs.get(id) }), readTaskReply: async () => options.reply ?? '三份资料已整理好，下面分别发给你。',
    readTaskDeliveries: options.readTaskDeliveries ?? (async () => options.media ?? []), linkTask: () => {},
    hasManualReply: () => manual,
    cancelTask: async id => { cancelled.push(id); },
    send: async (message, text, context) => { context.beforeSubmit(); sends.push({ type: 'text', text, part: context.part, index: context.index, target: message.conversationId }); return { status: options.textStatus ?? 'delivered' }; },
    sendMedia: async (message, item, context) => { context.beforeSubmit(); sends.push({ type: 'media', name: item.name, index: context.index }); return { status: item.status ?? 'delivered' }; },
    onDeliveryUpdate: async (id, value) => reports.push({ id, ...value }), ...options.auto,
  });
  api.connectionChanged(true); t.after(() => api.close());
  return { api, jobs, sends, reports, cancelled,
    advance: ms => { clock += ms; }, manual: () => { manual = true; },
    emit(patch = {}) { return api.enqueue({ id: 'wechat_' + randomUUID(), inboundKey: 'synthetic-' + (++serial), accountId: '777', kind: 'private', conversationId: '101', source: 'live', time: Math.floor(clock / 1000), text: '请整理文档', ...patch }); },
    complete() { for (const task of jobs.values()) task.status = 'succeeded'; },
    async settled() { await until(() => api.getState().active === 0 && api.getState().queued === 0); },
  };
}

const media = count => Array.from({ length: count }, (_, index) => ({ kind: 'attachment', name: `文档${index + 1}.docx` }));

test('quick replies stay concise; twelve files follow the explanation and each has a receipt', async t => {
  const f = fixture(t, { media: media(12) }); f.emit(); await f.settled();
  assert.equal(f.sends[0].part, 'final');
  assert.deepEqual(f.sends.slice(1, 13).map(item => item.name), media(12).map(item => item.name));
  assert.equal(f.sends.at(-1).part, 'delivery-notice');
  assert.match(f.sends.at(-1).text, /12 份附件已确认送达/);
  assert.equal(f.reports.at(-1).state, 'delivered');
  assert.equal(f.api.getState().completed, 1);
  assert.equal(f.sends.some(item => item.part === 'progress'), false);
});

test('one rejected or unknown file does not swallow text or other files and is named in the delivery notice', async t => {
  for (const status of ['rejected', 'unconfirmed']) await t.test(status, async child => {
    const selected = media(3); selected[1].status = status;
    const f = fixture(child, { media: selected }); f.emit(); await f.settled();
    assert.equal(f.sends[0].part, 'final');
    assert.deepEqual(f.sends.filter(item => item.type === 'media').map(item => item.index), [0, 1, 2]);
    assert.match(f.sends.at(-1).text, /2 份附件已确认送达/);
    assert.match(f.sends.at(-1).text, /文档2.docx/);
    assert.deepEqual(f.reports.at(-1).attachments.map(item => item.status), ['delivered', status, 'delivered']);
    assert.equal(f.api.getState().completed, 0);
  });
});

test('a snapshot failure is isolated and all actual files and the explanation remain deliverable', async t => {
  const selected = media(3); selected[1].error = '快照缺失';
  const f = fixture(t, { media: selected }); f.emit(); await f.settled();
  assert.equal(f.sends[0].part, 'final');
  assert.deepEqual(f.sends.filter(item => item.type === 'media').map(item => item.index), [0, 2]);
  assert.equal(f.reports.at(-1).attachments[1].status, 'rejected');
  assert.match(f.sends.at(-1).text, /文档2.docx/);
});

test('even a failed attachment-plan reader cannot prevent the completed explanation from being sent', async t => {
  const f = fixture(t, { readTaskDeliveries: async () => { throw Error('synthetic staging failure'); } }); f.emit(); await f.settled();
  assert.equal(f.sends[0].part, 'final'); assert.match(f.sends.at(-1).text, /文件整理未完成/);
  assert.equal(f.reports.at(-1).state, 'partial');
});

test('long Chinese and emoji replies are sent completely in byte-bounded ordered parts', async t => {
  const reply = '资料分析😀，请核对。\n'.repeat(1500), f = fixture(t, { reply }); f.emit(); await f.settled();
  assert.equal(f.sends.map(item => item.text).join(''), reply.trim());
  assert(f.sends.every(item => Buffer.byteLength(item.text) <= 16000 && !item.text.includes('\ufffd')));
  assert.equal(f.reports.at(-1).text.delivered, f.sends.length);
  assert.equal(new Set(f.sends.map(item => item.part + ':' + item.index)).size, f.sends.length);
  assert.deepEqual(splitWechatReply('😀中文', 4), ['😀', '中', '文']);
});

test('slow tasks acknowledge, report actual activity, and keep the final reply separate', async t => {
  const f = fixture(t, { status: 'running' }); f.emit(); await until(() => f.jobs.size === 1);
  f.advance(25); await until(() => f.sends.length === 1);
  assert.equal(f.sends[0].part, 'progress'); assert.match(f.sends[0].text, /还在处理/);
  const task = [...f.jobs.values()][0]; task.activity = { label: '正在排版和生成文档' };
  f.advance(60001); await until(() => f.sends.length === 2);
  assert.match(f.sends[1].text, /1 分钟.*正在排版/);
  assert.notEqual(f.sends[0].index, f.sends[1].index);
  f.complete(); await f.settled();
  assert.equal(f.sends.at(-1).part, 'final'); assert.equal(f.api.getState().completed, 1);
});

test('ordinary hybrid group messages remain quiet throughout long work', async t => {
  const f = fixture(t, { status: 'running', reply: '[无需回复]', settings: { wakeMode: 'hybrid' } });
  f.emit({ kind: 'group' }); await until(() => f.jobs.size === 1); f.advance(65000);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(f.sends.length, 0);
  f.complete(); await f.settled(); assert.equal(f.sends.length, 0);
});

test('unknown progress receipts do not repeat notices or block the completed result', async t => {
  let attempts = 0;
  const f = fixture(t, { status: 'running', auto: { send: async (_message, _text, context) => { context.beforeSubmit(); attempts++; return { status: context.part === 'progress' ? 'unconfirmed' : 'delivered' }; } } });
  f.emit(); await until(() => f.jobs.size === 1); f.advance(25); await until(() => attempts === 1);
  f.advance(61000); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(attempts, 1);
  f.complete(); await f.settled(); assert.equal(attempts, 2); assert.equal(f.api.getState().completed, 1);
});

test('human takeover after an acknowledgment cancels generation and all subsequent output', async t => {
  const f = fixture(t, { status: 'running' }); f.emit(); await until(() => f.jobs.size === 1);
  f.advance(25); await until(() => f.sends.length === 1); f.manual(); f.complete(); await f.settled();
  assert.equal(f.sends.length, 1); assert.equal(f.api.getState().lastError.code, 'AUTO_MANUAL_REPLY');
  assert.equal(f.cancelled.length, 1);
});

test('generation and attachment delivery have separate deadlines', async t => {
  let clock = 1000000;
  const f = fixture(t, { status: 'running', auto: { now: () => clock, deadlineMs: 100, deliveryMs: 100,
    sendMedia: async (_message, _item, context) => { clock += 40; context.beforeSubmit(); return { status: 'delivered' }; } }, media: media(2) });
  f.emit(); await until(() => f.jobs.size === 1); clock += 90; f.complete(); await f.settled();
  assert.equal(f.reports.at(-1).state, 'delivered');
});

test('tasks that have acknowledged also explain a later timeout and request cancellation once', async t => {
  const f = fixture(t, { status: 'running', auto: { deadlineMs: 100 } }); f.emit(); await until(() => f.jobs.size === 1);
  f.advance(25); await until(() => f.sends.length === 1); f.advance(101); await f.settled();
  assert.equal(f.sends.at(-1).part, 'failure'); assert.match(f.sends.at(-1).text, /没有完整做完/);
  assert.equal(f.cancelled.length, 1);
});

test('a second request gets a queue acknowledgment and keeps its full budget when its turn starts', async t => {
  const f = fixture(t, { status: 'running', auto: { deadlineMs: 100 } });
  f.emit(); f.emit(); await until(() => f.jobs.size === 1); f.advance(25);
  await until(() => f.sends.filter(item => item.part === 'progress').length === 2);
  assert(f.sends.some(item => /这条也记下了/.test(item.text)));
  f.complete(); await until(() => f.jobs.size === 2);
  f.advance(80); [...f.jobs.values()][1].status = 'succeeded'; await f.settled();
  assert.equal(f.sends.filter(item => item.part === 'final').length, 2);
  assert.equal(f.cancelled.length, 0);
});

test('delivery recovery retains per-file results across reopen without replaying pending files', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-work-recovery-'));
  let store = await createStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const id = 'task_' + randomUUID();
  store.createTask({ id, title: '合成交付恢复', prompt: '合成请求', kind: 'agent', status: 'succeeded', createdAt: new Date().toISOString(), workspace: directory, attachments: [] });
  const startedAt = new Date().toISOString();
  store.updateTask(id, { startedAt, activity: { label: '正在生成文档' }, wechatDelivery: { state: 'sending', text: { status: 'delivered', parts: 1, delivered: 1 }, attachments: [
    { name: '第一份.docx', status: 'delivered' }, { name: '第二份.docx', status: 'sending' }, { name: '第三份.docx', status: 'pending' },
  ] } });
  store.updateTask(id, { lastHeartbeatAt: startedAt }); store.close(); store = await createStore(directory); store.recover();
  const task = store.getTask(id);
  assert.equal(task.startedAt, startedAt); assert.equal(task.activity.label, '正在生成文档'); assert.equal(task.lastHeartbeatAt, startedAt);
  assert.equal(task.wechatDelivery.state, 'partial'); assert.equal(task.wechatDelivery.text.status, 'delivered');
  assert.deepEqual(task.wechatDelivery.attachments.map(item => item.status), ['delivered', 'unconfirmed', 'not_sent']);
  assert.equal(store.listWechatOutbox().length, 0);
});
