import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWechatBridge } from '../packages/wechat-bridge/index.mjs';
import { readConversationSettings, updateConversationSettings } from '../packages/wechat-bridge/conversation-settings.mjs';

const readerToken = 'reader-test-token-never-real', nativeToken = 'a'.repeat(64);
const until = async predicate => {
  const end = Date.now() + 3_000;
  while (!predicate()) { if (Date.now() > end) throw Error('CONDITION_TIMEOUT'); await delay(10); }
};

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-wechat-'));
  const clients = new Set();
  const backend = { account: 'wxid_self_0001', own: 'wxid_self_0001', version: '4.1.10.27',
    hookAccount: null, sends: 0, rows: [], streams: 0, confirm: true, reject: false, ...options };
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const native = url.pathname === '/WeChatAgent/health' || url.pathname === '/SendTextMsg' || url.pathname === '/GetSelfProfile' || url.pathname === '/SendStickerMsg';
    if (request.headers.authorization !== 'Bearer ' + (native ? nativeToken : readerToken)) return json(response, {}, 401);
    if (url.pathname === '/api/v1/reader/status' && backend.holdStatus) {
      backend.statusPending = true; request.on('close', () => { backend.statusClosed = true; }); return;
    }
    if (url.pathname === '/api/v1/reader/status') return json(response, {
      backend: 'weflow-cli-nt', ownWxid: backend.own, accountDirectory: backend.account,
    });
    if (url.pathname === '/WeChatAgent/health') return json(response, {
      integration: 'WeChatAgent-1', backend: 'wechat-hook', version: backend.version, startupState: 'ready',
      databaseAccounts: [backend.hookAccount ?? backend.account],
      nativeStickerSend: true,
    });
    if (url.pathname === '/GetSelfProfile' && backend.noNativeProfile) return json(response, {}, 404);
    if (url.pathname === '/GetSelfProfile') return json(response, {
      wxid: backend.profileWxid ?? backend.own, nickname: '实际微信昵称', alias: '测试微信号',
      phone: 'private-phone', email: 'private-email', area: 'private-area',
    });
    if (url.pathname === '/api/v1/contacts') return json(response, { contacts: backend.contacts ?? [
      { username: 'wxid_test_friend', displayName: '测试朋友', conversationId: 101 },
      { username: 'wxid_other_friend', displayName: '另一个朋友', conversationId: 102 },
      { username: 'test@chatroom', displayName: '测试群', conversationId: 202 },
      { username: backend.own, displayName: '本人', conversationId: 303 },
    ] });
    if (url.pathname === '/api/v1/sessions') return json(response, { sessions: [
      { username: 'wxid_test_friend', displayName: '测试朋友', conversationId: 101 },
      { username: 'test@chatroom', displayName: '测试群', conversationId: 202 },
    ] });
    if (url.pathname === '/api/v1/messages') return json(response, { messages: backend.rows });
    if (url.pathname === '/api/v1/stickers') return json(response, { stickers: [{ id: 'd'.repeat(64), receivedAt: 100, description: '测试表情', tags: ['测试'] }] });
    if (url.pathname === '/api/v1/stickers/' + 'd'.repeat(64)) return json(response, { id: 'd'.repeat(64),
      conversationKey: url.searchParams.get('conversationKey'), fields: { md5: 'e'.repeat(32), len: 10 }, path: 'Z:/synthetic-only.gif' });
    if (url.pathname.startsWith('/api/v1/images/')) return json(response, backend.image ?? {});
    if (url.pathname === '/api/v1/push/messages') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': connected\n\n'); clients.add(response); backend.streams++;
      request.on('close', () => clients.delete(response)); return;
    }
    if (url.pathname === '/SendTextMsg') {
      assert.equal(request.headers['x-wechatagent-account'], backend.account.toLowerCase());
      let body = ''; for await (const chunk of request) body += chunk;
      const sent = JSON.parse(body); backend.sends++;
      if (backend.reject) return json(response, { ret: -1 });
      backend.rows.push({ localId: backend.sends, serverId: backend.confirm ? '9001' : '0',
        localType: 1, isSend: true, createTime: Math.floor(Date.now() / 1000), fullText: sent.msg });
      return json(response, { ret: 0 });
    }
    if (url.pathname === '/SendStickerMsg') {
      assert.equal(request.headers['x-wechatagent-account'], backend.account.toLowerCase());
      let body = ''; for await (const chunk of request) body += chunk;
      const sent = JSON.parse(body); backend.sends++;
      backend.rows.push({ localId: backend.sends, serverId: backend.confirm ? '9001' : '0',
        localType: 47, isSend: true, createTime: Math.floor(Date.now() / 1000), stickerMd5: sent.sticker.md5 });
      return json(response, { ret: 0 });
    }
    json(response, {}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const messages = [], states = [], errors = [];
  const bridge = createWechatBridge({
    onMessage: message => { if (backend.callbackFails) throw Error('SIMULATED_DATABASE_FAILURE'); messages.push(message); }, onState: state => states.push(state), onError: error => errors.push(error),
    reconnectDelayMs: 20, healthIntervalMs: 25, requestTimeoutMs: 300, receiptTimeoutMs: 80, pollMs: 10,
  });
  const config = { dataDir: directory, readerBaseUrl: base, hookBaseUrl: base, readerToken, nativeToken,
    allowedPrivate: ['101'], allowedGroups: ['202'] };
  const emit = payload => { for (const client of clients) client.write('data: ' + JSON.stringify(payload) + '\n\n'); };
  const message = (extra = {}) => ({ event: 'message.new', type: 1, content: '你好，小助手', sessionId: 'wxid_test_friend',
    talkerId: 'wxid_test_friend', conversationId: 101, rawid: '7001', sourceName: '测试朋友', timestamp: 1_793_000_000, ...extra });
  t.after(async () => {
    await bridge.stop(); for (const client of clients) client.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, config, backend, messages, states, errors, emit, message, clients, directory };
}

test('WeChat bridge normalizes allowlisted SSE messages and deduplicates reconnections', async t => {
  const f = await fixture(t);
  const started = await f.bridge.start(f.config);
  assert.equal(started.accountVerified, true);
  await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); f.emit(f.message());
  f.emit(f.message({ conversationId: 999, rawid: '7002' }));
  f.emit(f.message({ isSend: true, rawid: '7003' }));
  f.emit(f.message({ sessionId: 'test@chatroom', talkerId: 'wxid_group_friend', conversationId: 202, groupName: '测试群', rawid: '7004' }));
  await until(() => f.messages.length === 2);
  assert.deepEqual(Object.keys(f.messages[0]).sort(), ['conversation_id', 'conversation_name', 'kind', 'message_id', 'self_id', 'sender_id', 'sender_name', 'text', 'time']);
  assert.equal(f.messages[0].conversation_id, '101');
  assert.equal(f.messages[0].text, '你好，小助手');
  assert.equal(f.messages[0].conversation_name, '测试朋友');
  assert.equal(f.messages[1].kind, 'group');
  assert.equal(f.messages[1].conversation_name, '测试群');
  assert.equal(JSON.stringify(f.messages).includes('wxid_'), false);
  for (const client of f.clients) client.end();
  await until(() => f.backend.streams >= 2 && f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); await delay(40);
  assert.equal(f.messages.length, 2);
  assert(f.states.some(s => s.state === 'error' && !s.readerConnected));
});

test('WeChat sends require server receipts and a delivery ID is not resubmitted', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const send = { kind: 'private', target: '101', text: '离线替身测试', deliveryId: 'b'.repeat(64) };
  const result = await f.bridge.sendText(send);
  assert.equal(result.delivered, 'database-confirmed');
  assert.equal(result.receipt, 'wechat-server-id');
  assert.equal(f.backend.sends, 1);
  assert.equal((await f.bridge.sendText(send)).reused, true);
  assert.equal(f.backend.sends, 1);
  const entries = await fs.readdir(path.join(f.directory, 'state', 'text-deliveries'));
  const saved = await fs.readFile(path.join(f.directory, 'state', 'text-deliveries', entries[0]), 'utf8');
  assert.equal(saved.includes(readerToken), false); assert.equal(saved.includes(nativeToken), false);
});

test('WeChat accepted but unconfirmed deliveries are never automatically resubmitted', async t => {
  const f = await fixture(t, { confirm: false });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const send = { kind: 'private', target: '101', text: '尚无服务器回执', deliveryId: 'c'.repeat(64) };
  await assert.rejects(f.bridge.sendText(send), { code: 'TEXT_DELIVERY_UNCONFIRMED', attempted: true });
  await assert.rejects(f.bridge.sendText(send), { code: 'TEXT_DELIVERY_UNCONFIRMED', attempted: true });
  assert.equal(f.backend.sends, 1);
});

test('WeChat stop cancels streams and prevents subsequent receive or send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  await f.bridge.stop();
  assert.equal(f.bridge.getStatus().state, 'offline');
  f.emit(f.message()); await delay(30); assert.equal(f.messages.length, 0);
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'd'.repeat(64) }), { code: 'WECHAT_NOT_READY' });
});

test('WeChat account change latches a blocked state and cannot receive or send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.backend.account = 'wxid_another_0002'; f.backend.own = 'wxid_another_0002';
  await until(() => f.bridge.getStatus().detail === 'WECHAT_ACCOUNT_CHANGED');
  f.emit(f.message()); await delay(60); assert.equal(f.messages.length, 0);
  assert.equal(f.bridge.getStatus().accountVerified, false);
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'e'.repeat(64) }), { code: 'WECHAT_ACCOUNT_CHANGED' });
  assert.equal(f.backend.sends, 0);
  assert.equal(JSON.stringify(f.errors).includes('wxid_'), false);
});

test('WeChat rechecks matching account before every send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.backend.hookAccount = 'wxid_wrong_database';
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'f'.repeat(64) }), { code: 'HOOK_ACCOUNT_MISMATCH' });
  assert.equal(f.backend.sends, 0);
});

test('WeChat rejects unreviewed versions, remote endpoints and wrong credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.start({ ...f.config, readerBaseUrl: 'https://example.com' }), { code: 'WECHAT_LOOPBACK_REQUIRED' });
  await assert.rejects(f.bridge.start({ ...f.config, hookBaseUrl: 'http://127.0.0.1:30001/redirect' }), { code: 'WECHAT_LOOPBACK_REQUIRED' });
  await assert.rejects(f.bridge.start({ ...f.config, allowedPrivate: ['wxid_raw'] }), { code: 'WECHAT_ALLOWLIST_INVALID' });
  f.backend.version = '4.1.99.0';
  await assert.rejects(f.bridge.start(f.config), { code: 'HOOK_VERSION_MISMATCH' });
  assert.equal(f.bridge.getStatus().accountVerified, false);
  f.backend.version = '4.1.10.27';
  await assert.rejects(f.bridge.start({ ...f.config, readerToken: 'wrong-but-long-enough-token' }), { code: 'API_HTTP_401' });
});

test('WeChat oversized SSE events are bounded and are not delivered', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  for (const client of f.clients) client.write('data: ' + 'x'.repeat(260_000));
  await until(() => f.errors.some(error => error.code === 'READER_EVENT_TOO_LARGE'));
  assert.equal(f.messages.length, 0);
});

test('WeChat stop cancels pending startup health and never connects afterwards', async t => {
  const f = await fixture(t, { holdStatus: true });
  const starting = f.bridge.start(f.config);
  const rejected = assert.rejects(starting, { code: 'WECHAT_START_CANCELLED' });
  await until(() => f.backend.statusPending);
  await f.bridge.stop(); await rejected;
  await until(() => f.backend.statusClosed);
  await delay(80);
  assert.equal(f.bridge.getStatus().state, 'offline');
  assert.equal(f.backend.streams, 0);
  assert.equal(f.states.some(state => state.state === 'ready'), false);
});

test('WeChat failed persistence visibly stops receiving without permanently deduplicating the message', async t => {
  const f = await fixture(t, { callbackFails: true });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message());
  await until(() => f.bridge.getStatus().detail === 'WECHAT_MESSAGE_HANDLER_FAILED');
  const count = f.backend.streams;
  await delay(80);
  assert.equal(f.backend.streams, count);
  assert.equal(f.bridge.getStatus().readerConnected, false);
  assert.equal(f.messages.length, 0);
  f.backend.callbackFails = false;
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); await until(() => f.messages.length === 1);
});

test('WeChat exposes verified actual account identity and safe named directory metadata', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const profile = await f.bridge.getProfile();
  assert.equal(profile.name, '实际微信昵称'); assert.equal(profile.wxid, f.backend.own);
  assert.deepEqual(Object.keys(profile).sort(), ['alias', 'id', 'name', 'source', 'wxid']);
  assert.equal(f.bridge.getStatus().account.name, '实际微信昵称');
  const friends = await f.bridge.getDirectory({ kind: 'private' });
  assert.deepEqual(friends.contacts.map(item => [item.id, item.name, item.allowed]), [['101', '测试朋友', true], ['102', '另一个朋友', false]]);
  assert.equal(JSON.stringify(friends).includes('wxid_'), false);
  const groups = await f.bridge.getDirectory({ kind: 'group' });
  assert.equal(groups.contacts[0].name, '测试群');
  f.backend.contacts = [
    { username: 'one@chatroom', displayName: '重名一', conversationId: 202 },
    { username: 'two@chatroom', displayName: '重名二', conversationId: 202 },
  ];
  assert((await f.bridge.getDirectory({ kind: 'group' })).contacts.every(item => item.ambiguous));
  await assert.rejects(f.bridge.getDirectory({ kind: 'group', limit: 1000 }), { code: 'WECHAT_DIRECTORY_ARGUMENT_INVALID' });
});

test('WeChat native profile cannot identify a different account from the verified reader', async t => {
  const f = await fixture(t, { profileWxid: 'wxid_another_account' });
  await assert.rejects(f.bridge.start(f.config), { code: 'WECHAT_PROFILE_ACCOUNT_MISMATCH' });
  assert.equal(f.bridge.getStatus().accountVerified, false);
  assert.equal(f.backend.streams, 0);
});

test('WeChat native-hook without GetSelfProfile falls back to the exact verified self contact', async t => {
  const f = await fixture(t, { noNativeProfile: true });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const profile = await f.bridge.getProfile();
  assert.equal(profile.name, '本人'); assert.equal(profile.source, 'reader-contact');
  assert.equal(profile.wxid, f.backend.own);
  f.backend.contacts = [{ username: 'wxid_not_self', displayName: '不能冒充本人' }];
  await assert.rejects(f.bridge.getProfile(), { code: 'WECHAT_PROFILE_UNAVAILABLE' });
});

test('WeChat receives the original reader SHA256 rawid and retains normalized media references', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message({ rawid: 'b'.repeat(64) }));
  f.emit(f.message({ rawid: 'c'.repeat(64), type: 3, content: '[图片]', image: { id: 'a'.repeat(64) } }));
  await until(() => f.messages.length === 2);
  assert.equal(f.messages[0].message_id, 'b'.repeat(64));
  assert.deepEqual(f.messages[1].images, [{ id: 'a'.repeat(64) }]);
});

test('WeChat sessions and latest history reuse native mappings and enforce the current allowlist', async t => {
  const f = await fixture(t);
  f.backend.rows = [
    { localId: 3, serverId: '10003', localType: 1, createTime: 103, isSend: 1, fullText: '最新发送', senderDisplay: '本人' },
    { localId: 2, serverId: '10002', localType: 1, createTime: 102, isSend: 0, senderUsername: 'wxid_test_friend', senderDisplay: '测试朋友', fullText: '中间消息' },
    { localId: 1, serverId: '10001', localType: 49, createTime: 101, isSend: 0, senderUsername: 'wxid_test_friend', parsedContent: '[文件]', fullText: '<private-xml/>' },
  ];
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  assert.deepEqual((await f.bridge.getSessions()).sessions.map(item => [item.id, item.name]), [['101', '测试朋友'], ['202', '测试群']]);
  const history = await f.bridge.getHistory({ kind: 'private', target: '101', limit: 2 });
  assert.equal(history.pagination, 'latest-only'); assert.equal(history.name, '测试朋友');
  assert.deepEqual(history.messages.map(item => item.text), ['中间消息', '最新发送']);
  assert.equal(history.messages[1].outgoing, true);
  assert.equal(JSON.stringify(history).includes('wxid_'), false);
  await assert.rejects(f.bridge.getHistory({ kind: 'private', target: '999' }), { code: 'CONVERSATION_NOT_ALLOWED' });
  await assert.rejects(f.bridge.getHistory({ kind: 'private', target: '101', limit: 101 }), { code: 'WECHAT_HISTORY_ARGUMENT_INVALID' });
});

test('WeChat image previews require matching conversation binding and verified content digest', async t => {
  const f = await fixture(t), imageId = 'a'.repeat(64), bytes = Buffer.from('synthetic-image-data');
  f.backend.image = { imageId, conversationKey: 'wechat:private:101', mime: 'image/png', b64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  assert.equal((await f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId })).bytes, bytes.length);
  f.backend.image.conversationKey = 'wechat:group:202';
  await assert.rejects(f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId }), { code: 'IMAGE_CONVERSATION_MISMATCH' });
  f.backend.image.conversationKey = 'wechat:private:101'; f.backend.image.sha256 = '0'.repeat(64);
  await assert.rejects(f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId }), { code: 'IMAGE_INTEGRITY_FAILED' });
});

test('WeChat sticker listing and sending retain the existing native server receipt and replay rules', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const choices = await f.bridge.getStickers({ kind: 'private', target: '101', query: '测试' });
  assert.equal(choices.enabled, true); assert.equal(choices.stickers[0].description, '测试表情');
  const send = { kind: 'private', target: '101', id: 'd'.repeat(64), deliveryId: 'e'.repeat(64) };
  const result = await f.bridge.sendSticker(send);
  assert.equal(result.receipt, 'wechat-server-id'); assert.equal(result.media_type, 'wechat-sticker');
  assert.equal((await f.bridge.sendSticker(send)).reused, true);
  assert.equal(f.backend.sends, 1);
});

test('WeChat conversation settings directly reuse original console schema and retain other chats', () => {
  const config = { persona: { default: '默认', chats: { 'wechat:group:202': '旧人格' } },
    wechat: { whitelist: { private: ['101'], groups: ['202'] }, stickers: { enabled: true },
      dshAccess: { chats: { 'wechat:group:202': { skills: ['旧技能'], tools: [] } } } } };
  const before = JSON.stringify(config);
  const settings = { persona: '新人格', mode: 'mention', stickers: false, search: true, proactive: false, context: 16000 };
  const access = { skills: ['已授权技能'], tools: ['read_document'] };
  const next = updateConversationSettings(config, { kind: 'group', target: '202', settings, access });
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(readConversationSettings(next, { kind: 'group', target: '202' }), { key: 'wechat:group:202', settings, access });
  assert.equal(next.wechat.whitelist.private[0], '101');
  assert.throws(() => updateConversationSettings(config, { kind: 'private', target: '999', settings, access }), { code: 'CONVERSATION_NOT_ALLOWED' });
  assert.throws(() => updateConversationSettings(config, { kind: 'private', target: '101', settings, access }), /群聊回复方式/);
});
