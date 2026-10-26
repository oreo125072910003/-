import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssistantService } from '../apps/service/index.mjs';
import { PRODUCT_TOOLS } from '../packages/contracts/product-tools.mjs';

test('DSH task tools batch real files, persist actual activity and deliver explanation plus all files through the product service', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-batch-service-'));
  const source = path.join(dataDir, 'legacy');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(source, 'state', 'hook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config', 'wechatagent.json'), JSON.stringify({ runtime: { sender: 'wechat-hook', weflowMode: 'nt' }, hook: { expectedVersion: '4.1.10.27', baseUrl: 'http://127.0.0.1:30001' }, wechat: { whitelist: { private: ['101'], groups: [] } } }));
  fs.writeFileSync(path.join(source, 'state', 'wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'synthetic-reader-batch-token' }));
  fs.writeFileSync(path.join(source, 'state', 'hook', 'native-token.txt'), 'a'.repeat(64));
  const secrets = new Map(), sent = [];
  let callbacks, service, runtimeCompleted = false;
  const secretStore = { get: async key => secrets.get(key), set: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) };
  const runtime = {
    inspectHostedRuntime: async () => ({ available: true, ready: true, modelVerified: true }),
    readHostedCatalog: async () => ({ ok: true, metadataOnly: true, skills: [], tools: PRODUCT_TOOLS.map(tool => ({ ...tool, grantable: !tool.computer })) }),
    runHostedTask: async options => {
      assert.match(options.prompt, /最终文字说明/);
      const connection = options.settings.hostedProductConnection;
      const invoke = async (name, args) => {
        const response = await fetch(connection.endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + connection.token, 'content-type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), name, args }) });
        const result = await response.json(); assert.equal(result.isError, false, result.content); return JSON.parse(result.content);
      };
      const ids = [];
      for (let index = 0; index < 5; index++) ids.push((await invoke('xiaozhushou_save_text', { name: `资料${index + 1}.md`, text: '真正写入文件的合成资料' })).artifact.id);
      await invoke('xiaozhushou_attachment', { artifactIds: ids, mediaType: 'file' });
      options.onEvent({ type: 'heartbeat', message: 'test heartbeat' });
      runtimeCompleted = true;
      return { ok: true, sessionId: 'xzs-' + 'c'.repeat(32), finalText: '五份资料已整理好，下面逐份发给你。' };
    },
  };
  service = await createAssistantService({ dataDir, runtime, secretStore, wechatBridgeFactory: value => {
    callbacks = value;
    return { start: async () => value.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true }), stop: async () => {},
      sendText: async value => { sent.push({ type: 'text', text: value.text }); return { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: String(sent.length) }; },
      sendAttachment: async value => { sent.push({ type: 'file', name: value.name }); return { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: String(sent.length), local_message_id: String(1000 + sent.length), media_type: 'wechat-file' }; },
    };
  } });
  t.after(async () => { await service.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await service.importWechatConnection(source, { automatic: true });
  await service.saveWechatDshGrants({ kind: 'private', target: '101', grants: { tools: ['xiaozhushou_save_text', 'xiaozhushou_attachment'], skills: [] } });
  callbacks.onMessage({ self_id: '777', kind: 'private', conversation_id: '101', sender_id: '101', sender_name: '合成联系人', conversation_name: '合成会话', text: '请生成五份资料并发送', message_id: 'batch-1', time: Math.ceil(Date.now() / 1000) });
  const deadline = Date.now() + 6000;
  while ((await service.getWechatState()).autoReply.active || !runtimeCompleted) {
    if (Date.now() >= deadline) throw Error('多文件交付未完成');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(sent[0].text, '五份资料已整理好，下面逐份发给你。');
  assert.equal(sent.filter(item => item.type === 'file').length, 5);
  const state = await service.getWechatState(), detail = service.getTask(state.messages[0].taskId);
  assert.equal(detail.task.wechatDeliveries.length, 5);
  assert.equal(detail.task.wechatDelivery.state, 'delivered');
  assert.equal(detail.task.wechatDelivery.attachments.length, 5);
  assert.equal(detail.task.wechatDelivery.text.status, 'delivered');
  assert(detail.events.some(event => event.type === 'activity' && /正在保存文字成果/.test(event.message)));
  assert(detail.task.lastHeartbeatAt);
});
