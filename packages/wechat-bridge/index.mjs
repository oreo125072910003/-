import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HookOneBot, conversationId, onebotId } from '../../代码/项目/scripts/hook-onebot.mjs';
import { normalizeOneBotEvent } from '../../代码/项目/components/qq-bridge/src/onebot/normalize.js';
import { validateStickerSettings } from '../../代码/项目/components/qq-bridge/src/core/sticker-policy.js';
import { createWechatMediaTransport } from './media-transport.mjs';
import { createWechatHookMediaRunner } from './hook-media.mjs';

const MAX_EVENT_BYTES = 256_000;
const MAX_JSON_BYTES = 1_200_000;
const MAX_SEEN = 5_000;
const displayText = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit).trim() : '';
const fault = code => Object.assign(new Error(code), { code });
const codeOf = error => typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
  ? error.message : 'WECHAT_BACKEND_UNAVAILABLE';

function loopback(value, fallback) {
  let url;
  try { url = new URL(value ?? fallback); } catch { throw fault('WECHAT_LOOPBACK_REQUIRED'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw fault('WECHAT_LOOPBACK_REQUIRED');
  return url.origin;
}

function ids(value) {
  if (!Array.isArray(value) || value.length > 5_000) throw fault('WECHAT_ALLOWLIST_INVALID');
  if (value.some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw fault('WECHAT_ALLOWLIST_INVALID');
  }
  return [...new Set(value)];
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir)) {
    throw fault('WECHAT_DATA_DIRECTORY_REQUIRED');
  }
  if (typeof value.readerToken !== 'string' || value.readerToken.length < 16 || value.readerToken.length > 4_096 ||
      /[\u0000-\u0020\u007f]/.test(value.readerToken)) throw fault('WECHAT_READER_TOKEN_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(value.nativeToken ?? '')) throw fault('HOOK_TOKEN_MISSING');
  if ((value.expectedVersion ?? '4.1.10.27') !== '4.1.10.27') throw fault('HOOK_VERSION_MISMATCH');
  const nickname = value.nickname ?? '小助手';
  if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 80 || /[\u0000-\u001f]/.test(nickname)) {
    throw fault('WECHAT_NICKNAME_INVALID');
  }
  try { validateStickerSettings(value.stickerSettings); } catch { throw fault('WECHAT_STICKER_SETTINGS_INVALID'); }
  const dataDir = path.resolve(value.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw fault('WECHAT_DATA_DIRECTORY_INVALID');
  const stateDir = path.join(dataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  if (fs.lstatSync(stateDir).isSymbolicLink()) throw fault('WECHAT_DATA_DIRECTORY_INVALID');
  return {
    dataDir, nickname: nickname.trim(), expectedVersion: '4.1.10.27',
    readerBaseUrl: loopback(value.readerBaseUrl), hookBaseUrl: loopback(value.hookBaseUrl, 'http://127.0.0.1:30001'),
    readerToken: value.readerToken, nativeToken: value.nativeToken,
    allowedPrivate: ids(value.allowedPrivate ?? []), allowedGroups: ids(value.allowedGroups ?? []),
    stickerSettings: value.stickerSettings === undefined ? undefined : structuredClone(value.stickerSettings),
    subscriptionId: /^[a-f0-9-]{36}$/.test(value.connectionId??'') ? value.connectionId : crypto.randomUUID(),
  };
}

/** Reuses the reviewed native transport without starting its legacy HTTP/WS servers. */
export function createWechatBridge({
  onMessage = () => {}, onState = () => {}, onError = () => {}, fetchImpl = fetch,
  reconnectDelayMs = 1_500, healthIntervalMs = 5_000, idleTimeoutMs = 35_000,
  requestTimeoutMs = 5_000, receiptTimeoutMs = 18_000, pollMs = 400,
  mediaNativeRunner,
} = {}) {
  for (const value of [reconnectDelayMs, healthIntervalMs, idleTimeoutMs, requestTimeoutMs, receiptTimeoutMs, pollMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 60_000) throw fault('WECHAT_TIMEOUT_INVALID');
  }
  let state = { state: 'offline', detail: 'WECHAT_NOT_CONNECTED', accountVerified: false, readerConnected: false };
  let adapter = null, config = null, identity = null, accountLocked = false;
  let lifecycle = null, streamController = null, loop = null, healthTimer = null, healthPending = null;
  let activeSend = null, startPending = null, stopPending = null, generation = 0, receiveFailed = false;
  let account = null;
  let mediaTransport = null;
  let readerConfiguration = {state:'pending',version:1,detail:'名单待配置，新增会话尚未接收。'};
  const controllers = new Set(), seen = new Map();

  function publish(next) {
    state = { ...state, ...next };
    if (JSON.stringify(state) !== JSON.stringify(publish.last)) {
      publish.last = { ...state };
      try { onState({ ...state }); } catch { /* A UI callback cannot break transport cleanup. */ }
    }
  }
  function report(error) {
    const code = codeOf(error);
    try { onError({ code, message: code }); } catch { /* Never log raw backend data or identifiers. */ }
    return code;
  }
  function markError(error, { disconnected = false } = {}) {
    if(accountLocked&&codeOf(error)!=='WECHAT_PROFILE_ACCOUNT_MISMATCH')error=fault('WECHAT_ACCOUNT_CHANGED');
    const code = report(error);
    publish({ state: 'error', detail: code, accountVerified: false,
      ...(disconnected ? { readerConnected: false } : {}) });
    return code;
  }
  function current(signal) { return lifecycle && !lifecycle.signal.aborted && (!signal || signal === lifecycle.signal); }

  // Legacy actions retain their receipt semantics. This wrapper adds cancellation
  // and a body bound to their JSON requests; credentials never go to disk.
  async function boundedJsonFetch(url, options = {}) {
    const controller = new AbortController();
    controllers.add(controller);
    const signals = [controller.signal, lifecycle?.signal, options.signal].filter(Boolean);
    try {
      const response = await fetchImpl(url, { ...options, signal: AbortSignal.any(signals) });
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_JSON_BYTES) { controller.abort(); throw fault('WECHAT_RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString('utf8');
      return { ok: response.ok, status: response.status, json: async () => JSON.parse(body) };
    } finally { controllers.delete(controller); }
  }

  async function verify() {
    if (!current() || accountLocked || !adapter) throw fault(accountLocked ? 'WECHAT_ACCOUNT_CHANGED' : 'WECHAT_NOT_CONNECTED');
    const ownAdapter = adapter, signal = lifecycle.signal;
    const found = await ownAdapter.originalCheckNative();
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    if (accountLocked) throw fault('WECHAT_ACCOUNT_CHANGED');
    if (identity && (found.account !== identity.account || found.selfId !== identity.selfId || ownAdapter.ownWxid !== identity.selfWxid)) {
      accountLocked = true;
      ownAdapter.status.hook_account_verified = false;
      streamController?.abort();
      markError(fault('WECHAT_ACCOUNT_CHANGED'),{disconnected:true});
      throw fault('WECHAT_ACCOUNT_CHANGED');
    }
    identity ??= {...found,selfWxid:ownAdapter.ownWxid};
    if (!current()) throw fault('WECHAT_NOT_CONNECTED');
    return found;
  }

  async function syncReaderConfiguration() {
    const ownAdapter=adapter, signal=lifecycle?.signal, ownedConfig=config;
    try {
      const identity=await verify();
      if(ownAdapter.readerStatus?.productSubscriptionVersion!==1)throw fault('READER_SUBSCRIPTION_UNSUPPORTED');
      const route='/api/v1/product/subscription', subscriptionId=ownedConfig.subscriptionId;
      const prior=await ownAdapter.reader(route+'?subscriptionId='+encodeURIComponent(subscriptionId));
      const valid=value=>value?.version===1&&value.subscriptionId===subscriptionId&&value.accountDirectory===identity.account&&value.ownWxid===ownAdapter.ownWxid&&Number.isSafeInteger(value.revision)&&value.revision>=0&&Array.isArray(value.private)&&Array.isArray(value.groups);
      if(!valid(prior))throw fault('READER_SUBSCRIPTION_INVALID');
      if(!current(signal)||adapter!==ownAdapter)throw fault('WECHAT_NOT_CONNECTED');
      const body={version:1,subscriptionId,expectedRevision:prior.revision,accountDirectory:identity.account,ownWxid:ownAdapter.ownWxid,private:ownedConfig.allowedPrivate,groups:ownedConfig.allowedGroups};
      const applied=await ownAdapter.json(ownedConfig.readerBaseUrl,route,{method:'POST',headers:{Authorization:'Bearer '+ownedConfig.readerToken,'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!valid(applied)||applied.revision<=prior.revision||JSON.stringify(applied.private)!==JSON.stringify(body.private)||JSON.stringify(applied.groups)!==JSON.stringify(body.groups)||!Number.isFinite(applied.expiresAt)||applied.expiresAt*1000<=Date.now())throw fault('READER_SUBSCRIPTION_INVALID');
      await verify();
      if(!current(signal)||adapter!==ownAdapter)throw fault('WECHAT_NOT_CONNECTED');
      readerConfiguration={state:'applied',version:1,revision:applied.revision,expiresAt:new Date(applied.expiresAt*1000).toISOString(),
        digest:crypto.createHash('sha256').update(JSON.stringify([identity.account,body.private,body.groups])).digest('hex'),detail:'授权名单已同步到当前账号的消息读取服务。'};
    } catch(error) {
      if(!current(signal)||adapter!==ownAdapter)return;
      readerConfiguration={state:'pending',version:1,code:codeOf(error),detail:'名单待配置，新增会话尚未接收；请更新或核对消息读取组件后重新连接。'};
    }
    if(current(signal)&&adapter===ownAdapter)publish({readerConfiguration:{...readerConfiguration},selfEventsVerified:ownAdapter.readerStatus?.selfEvents==='account-conversation-v1'});
  }

  async function getProfile() {
    const verified = await verify(), ownAdapter = adapter, signal = lifecycle.signal;
    let profile, source = 'native';
    try { profile = await ownAdapter.native('/GetSelfProfile', {}, verified.account); }
    catch (error) {
      if (codeOf(error) !== 'API_HTTP_404') throw error;
      // The reviewed scripts/native-hook build exposes health/send routes but
      // not GetSelfProfile. Its existing reader contact catalog includes self.
      const result = await ownAdapter.reader('/api/v1/contacts?kind=private&keyword=' +
        encodeURIComponent(ownAdapter.ownWxid) + '&limit=100&refresh=1');
      if (!Array.isArray(result?.contacts) || result.contacts.length > 100) throw fault('WECHAT_PROFILE_INVALID');
      const matches = result.contacts.filter(item => item?.username === ownAdapter.ownWxid);
      if (matches.length !== 1) throw fault('WECHAT_PROFILE_UNAVAILABLE');
      const self = matches[0];
      profile = { wxid: self.username, nickname: self.displayName || self.nickname || self.remark || '', alias: '' };
      source = 'reader-contact';
    }
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    if (!profile || typeof profile !== 'object' || typeof profile.wxid !== 'string' || !profile.wxid || profile.wxid.length > 256) {
      throw fault('WECHAT_PROFILE_INVALID');
    }
    // The native profile is only UI identity; it must agree with the reader
    // account already used to gate message delivery.
    if (profile.wxid !== ownAdapter.ownWxid) {
      accountLocked = true; streamController?.abort();
      markError(fault('WECHAT_PROFILE_ACCOUNT_MISMATCH'), { disconnected: true });
      throw fault('WECHAT_PROFILE_ACCOUNT_MISMATCH');
    }
    await verify();
    account = { id: String(verified.selfId), name: displayText(profile.nickname, 200),
      wxid: displayText(profile.wxid, 256), alias: displayText(profile.alias, 200), source };
    // incoming() reloads this injected object, so the actual verified nickname
    // survives reloads without changing any legacy configuration on disk.
    if (account.name) ownAdapter.project.account.nicknames = [...new Set([...ownAdapter.project.account.nicknames, account.name])];
    publish({ account: { ...account }, profileError: undefined });
    return { ...account };
  }

  async function getDirectory({ kind = 'private', keyword = '', limit = 100 } = {}) {
    if (!['private', 'group'].includes(kind) || typeof keyword !== 'string' || keyword.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(keyword) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw fault('WECHAT_DIRECTORY_ARGUMENT_INVALID');
    }
    await verify();
    const ownAdapter = adapter, signal = lifecycle.signal;
    const data = await ownAdapter.reader('/api/v1/contacts?kind=' + (kind === 'group' ? 'groups' : 'private') +
      '&keyword=' + encodeURIComponent(keyword) + '&limit=' + limit + '&refresh=1');
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    if (!Array.isArray(data?.contacts) || data.contacts.length > 1_000) throw fault('WECHAT_DIRECTORY_INVALID');
    await verify();
    const rows = [];
    for (const item of data.contacts.slice(0, limit)) {
      if (!item || typeof item.username !== 'string' || !item.username || item.username.length > 256 ||
          item.username === ownAdapter.ownWxid || (item.username.includes('@chatroom') ? 'group' : 'private') !== kind) continue;
      let id;
      try { id = String(conversationId(item.username, item.displayName, item.conversationId)); } catch { continue; }
      rows.push({ id, kind, name: displayText(item.remark || item.displayName || item.nickname, 200) || '名称暂不可用',
        ambiguous: item.ambiguous === true, allowed: ownAdapter.allowed(kind, id) });
    }
    const counts = new Map();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    return { kind, contacts: rows.map(row => ({ ...row, ambiguous: row.ambiguous || counts.get(row.id) > 1 })) };
  }

  function assertTarget(kind, target) {
    if (!['private', 'group'].includes(kind) || typeof target !== 'string' || !/^[1-9]\d{0,15}$/.test(target)) throw fault('WECHAT_TARGET_INVALID');
    if (!adapter || !current() || accountLocked || receiveFailed) throw fault('WECHAT_NOT_READY');
    if (!adapter.allowed(kind, target)) throw fault('CONVERSATION_NOT_ALLOWED');
  }

  async function getSessions({ limit = 500 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fault('WECHAT_SESSION_ARGUMENT_INVALID');
    await verify();
    const ownAdapter = adapter, signal = lifecycle.signal;
    const data = await ownAdapter.reader('/api/v1/sessions?limit=' + limit);
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    if (!Array.isArray(data?.sessions) || data.sessions.length > 500) throw fault('WECHAT_SESSIONS_INVALID');
    await verify();
    const sessions = [];
    for (const item of data.sessions.slice(0, limit)) {
      if (!item || typeof item.username !== 'string' || item.username.length > 256 || item.username === ownAdapter.ownWxid) continue;
      const kind = item.username.includes('@chatroom') ? 'group' : 'private';
      let id; try { id = String(conversationId(item.username, item.displayName, item.conversationId)); } catch { continue; }
      if (!ownAdapter.allowed(kind, id)) continue;
      sessions.push({ id, kind, name: displayText(item.displayName, 200) || '名称暂不可用', allowed: true, ambiguous: item.ambiguous === true });
    }
    const counts = new Map();
    for (const item of sessions) { const key = item.kind + ':' + item.id; counts.set(key, (counts.get(key) ?? 0) + 1); }
    return { sessions: sessions.map(item => ({ ...item, ambiguous: item.ambiguous || counts.get(item.kind + ':' + item.id) > 1 })) };
  }

  async function getHistory({ kind, target, limit = 100 } = {}) {
    assertTarget(kind, target);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fault('WECHAT_HISTORY_ARGUMENT_INVALID');
    await verify();
    const ownAdapter = adapter, signal = lifecycle.signal;
    const wxid = await ownAdapter.resolveTarget(kind, target);
    const rows = await ownAdapter.messages(wxid);
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    await verify(); assertTarget(kind, target);
    const messages = [];
    for (const row of [...rows].sort((a, b) => Number(b?.createTime) - Number(a?.createTime)).slice(0, limit)) {
      if (!row || !/^[1-9]\d{0,31}$/.test(String(row.localId ?? '')) ||
          !Number.isSafeInteger(Number(row.createTime)) || Number(row.createTime) < 0) continue;
      const outgoing = row.isSend === true || row.isSend === 1;
      const sender = outgoing ? ownAdapter.ownWxid : typeof row.senderUsername === 'string' && row.senderUsername.length <= 256 ? row.senderUsername : kind === 'private' ? wxid : '';
      const type = Number(row.localType), baseType = type % 2 ** 32;
      const textSource = baseType === 1 ? row.fullText ?? row.content ?? row.parsedContent : row.parsedContent;
      // Preserve reader-api.py push_payload's exact existing message fingerprint
      // so reading history and receiving its SSE copy do not create two records.
      const externalId = crypto.createHash('sha256').update(JSON.stringify([wxid, row.serverId ?? null, row.localId, row.createTime])).digest('hex');
      messages.push({ message_id: String(row.localId), external_id: externalId, server_id: /^\d{1,32}$/.test(String(row.serverId ?? '')) ? String(row.serverId) : '',
        sender_id: sender ? String(onebotId(sender)) : '', sender_name: displayText(row.senderDisplay, 200) || (outgoing ? account?.name || '我' : '名称暂不可用'),
        text: typeof textSource === 'string' ? textSource.slice(0, 16_000) : baseType === 3 ? '[图片]' : baseType === 47 ? '[表情]' : '[非文本消息]',
        time: Number(row.createTime), outgoing, message_type: baseType === 1 ? 'text' : baseType === 3 ? 'image' : baseType === 47 ? 'sticker' : 'other' });
    }
    messages.sort((a, b) => a.time - b.time);
    const session = (await getSessions()).sessions.find(item => item.kind === kind && item.id === target);
    return { kind, target, name: session?.name || target, messages, pagination: 'latest-only' };
  }

  async function resolveImage({ kind, target, id } = {}) {
    assertTarget(kind, target);
    if (!/^[a-f0-9]{64}$/.test(id ?? '')) throw fault('INVALID_IMAGE_REFERENCE');
    await verify();
    const ownAdapter = adapter, signal = lifecycle.signal;
    const image = await ownAdapter.json(config.readerBaseUrl, '/api/v1/images/' + id,
      { headers: { Authorization: 'Bearer ' + config.readerToken } }, 12_000);
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    await verify(); assertTarget(kind, target);
    if (image?.imageId !== id || image.conversationKey !== 'wechat:' + kind + ':' + target) throw fault('IMAGE_CONVERSATION_MISMATCH');
    if (typeof image.b64 !== 'string' || image.b64.length > 1_100_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime)) throw fault('INVALID_IMAGE_DATA');
    const bytes = Buffer.from(image.b64, 'base64');
    if (!bytes.length || bytes.length > 768 * 1024 || bytes.toString('base64') !== image.b64 ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw fault('IMAGE_INTEGRITY_FAILED');
    return { id, mime: image.mime, b64: image.b64, sha256: image.sha256, bytes: bytes.length };
  }

  async function getStickers({ kind, target, query = '' } = {}) {
    assertTarget(kind, target);
    if (typeof query !== 'string' || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) throw fault('WECHAT_STICKER_QUERY_INVALID');
    const result = await adapter.action({ action: 'get_sticker_list', params: { kind, target, query } });
    if (result.status !== 'ok' || result.retcode !== 0) throw fault(codeOf({ message: result.message }));
    return result.data;
  }

  async function resolveMediaTarget(kind, target) {
    assertTarget(kind, target);
    const ownAdapter = adapter, signal = lifecycle.signal;
    const wxid = await ownAdapter.resolveTarget(kind, target);
    const sessions = await ownAdapter.reader('/api/v1/sessions?limit=500');
    const matches = (sessions?.sessions ?? []).filter(item => item?.username === wxid);
    if (matches.length !== 1 || matches[0].ambiguous === true) throw fault('WECHAT_ATTACHMENT_TARGET_AMBIGUOUS');
    const name = displayText(matches[0].displayName, 200);
    if (!name || name !== matches[0].displayName) throw fault('WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE');
    // UI Automation exposes a title, not a stable chat ID. Every title/alias
    // must be globally unique across private chats and groups before granting UI.
    const titleKey = value => typeof value === 'string' ? value.replace(/\s/gu, '') : '';
    // The recognizer inserts spaces between Chinese words. Search by the first
    // non-space character so a real alias containing spaces is also considered.
    const contacts = await ownAdapter.reader('/api/v1/contacts?keyword=' + encodeURIComponent([...titleKey(name)][0]) + '&limit=500&refresh=1');
    if (!Array.isArray(contacts?.contacts) || contacts.contacts.length >= 500) throw fault('WECHAT_ATTACHMENT_TARGET_AMBIGUOUS');
    const named = contacts.contacts.filter(item => [item?.remark, item?.displayName, item?.nickname,...(Array.isArray(item?.aliases)?item.aliases:[])].some(value => titleKey(value) === titleKey(name)));
    if (named.length !== 1 || named[0].username !== wxid || named[0].ambiguous === true) throw fault('WECHAT_ATTACHMENT_TARGET_AMBIGUOUS');
    const sessionAliases=(sessions?.sessions??[]).filter(item=>[item?.displayName,...(Array.isArray(item?.aliases)?item.aliases:[])].some(value=>titleKey(value)===titleKey(name)));
    if(sessionAliases.length!==1||sessionAliases[0].username!==wxid)throw fault('WECHAT_ATTACHMENT_TARGET_AMBIGUOUS');
    if (!current(signal) || adapter !== ownAdapter) throw fault('WECHAT_NOT_CONNECTED');
    assertTarget(kind, target);
    return { wxid, name };
  }

  function normalized(payload) {
    // Native source IDs are validated before invoking the legacy normalizer.
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof payload.sessionId !== 'string' || payload.sessionId.length > 256 ||
        typeof payload.talkerId !== 'string' || payload.talkerId.length > 256 ||
        !/^(?:[a-f0-9]{64}|[1-9]\d{0,31})$/.test(String(payload.rawid ?? '')) ||
        typeof payload.content !== 'string' || Buffer.byteLength(payload.content) > 64_000 ||
        payload.sourceName !== undefined && (typeof payload.sourceName !== 'string' || payload.sourceName.length > 200) ||
        payload.senderName !== undefined && (typeof payload.senderName !== 'string' || payload.senderName.length > 200) ||
        payload.groupName !== undefined && (typeof payload.groupName !== 'string' || payload.groupName.length > 200)) return null;
    // The original adapter filters our own outgoing events. Retain only a
    // verified self-send signal here so a human reply can stop a pending AI reply.
    if(payload.event==='message.new'&&payload.isSend===true&&payload.talkerId===adapter.ownWxid&&payload.accountWxid===adapter.ownWxid){
      try{
        const kind=payload.sessionId.includes('@chatroom')?'group':'private';
        const target=String(conversationId(payload.sessionId,payload.groupName,payload.conversationId));
        if(!adapter.allowed(kind,target))return null;
        const self=String(onebotId(adapter.ownWxid)),time=Number(payload.timestamp);
        if(!Number.isSafeInteger(time)||time<0)return null;
        return{self_id:self,kind,conversation_id:target,sender_id:self,outgoing:true,text:payload.type===1?payload.content.slice(0,16000):'',message_id:String(payload.rawid),time,
          ...(/^[1-9]\d{0,31}$/.test(payload.sourceLocalId??'')?{sourceLocalId:payload.sourceLocalId}:{})};
      }catch{return null;}
    }
    const event = adapter.incoming(payload);
    if (!event) return null;
    const legacy = normalizeOneBotEvent('wechat', 'wechat-hook', event);
    const time = Number(event.time);
    if (!Number.isSafeInteger(time) || time < 0) return null;
    const kind = event.message_type;
    // Private conversation mappings can differ from sender IDs; use the actual
    // reader conversation ID when supplied, matching the native target resolver.
    const conversation = kind === 'group' ? event.group_id : payload.conversationId ?? event.user_id;
    return {
      self_id: String(event.self_id), kind, conversation_id: String(conversation),
      sender_id: String(event.user_id), text: event.raw_message, message_id: String(event.message_id),
      conversation_name: String(kind === 'group' ? payload.groupName || conversation : payload.sourceName || payload.senderName || conversation)
        .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200),
      sender_name: event.sender.nickname, time,
      ...(legacy?.images?.length ? { images: legacy.images } : {}),
      ...(legacy?.interaction ? { interaction: legacy.interaction } : {}),
      ...(legacy?.segments?.length ? {segments:legacy.segments.slice(0,32).filter(item=>item?.type==='at'||item?.type==='text').map(item=>item.type==='at'?{type:'at',data:{qq:String(item.data?.qq??'').slice(0,32)}}:{type:'text',data:{text:String(item.data?.text??'').slice(0,16000)}})} : {}),
      ...(legacy?.quoteReply ? {quoteReply:structuredClone(legacy.quoteReply)} : {}),
    };
  }

  async function accept(payload, signal) {
    if (!current(signal) || accountLocked || receiveFailed || !state.accountVerified) return;
    if(payload?.isSend===true){
      const ownAdapter=adapter;
      try {
        await verify();
        const kind=payload.sessionId?.includes('@chatroom')?'group':'private', target=String(payload.conversationId??'');
        const wxid=await ownAdapter.resolveTarget(kind,target);
        await verify();
        if(!current(signal)||adapter!==ownAdapter||wxid!==payload.sessionId||payload.accountWxid!==ownAdapter.ownWxid)return;
      } catch { return; }
    }
    const message = normalized(payload);
    if (!message) return;
    const key = [message.self_id, message.kind, message.conversation_id, message.message_id].join(':');
    if (seen.has(key)) return;
    let timer, abortHandler;
    try {
      await Promise.race([
        Promise.resolve().then(() => onMessage(message)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fault('WECHAT_MESSAGE_HANDLER_TIMEOUT')), requestTimeoutMs); }),
        new Promise((_, reject) => {
          if (signal.aborted) reject(fault('WECHAT_NOT_CONNECTED'));
          else {
            abortHandler = () => reject(fault('WECHAT_NOT_CONNECTED'));
            signal.addEventListener('abort', abortHandler, { once: true });
          }
        }),
      ]);
      seen.set(key, true);
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    } catch {
      // A failed database callback cannot be recorded as delivered. Stop this
      // receive session visibly, retaining the message's eligibility on restart.
      if (current(signal)) {
        receiveFailed = true;
        throw fault('WECHAT_MESSAGE_HANDLER_FAILED');
      }
    }
    finally { clearTimeout(timer); if (abortHandler) signal.removeEventListener('abort', abortHandler); }
  }

  async function consume(signal) {
    const controller = new AbortController(); streamController = controller;
    let watchdog;
    const resetWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), idleTimeoutMs); };
    resetWatchdog();
    try {
      const response = await fetchImpl(config.readerBaseUrl + '/api/v1/push/messages', {
        headers: { Authorization: 'Bearer ' + config.readerToken }, redirect: 'error',
        signal: AbortSignal.any([signal, controller.signal]),
      });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
        throw fault('READER_STREAM_UNAVAILABLE');
      }
      // The reader may have changed accounts while the SSE handshake completed.
      const verified = await verify();
      if (!current(signal)) return;
      adapter.status.reader_connected = true;
      publish({ state: 'ready', detail: 'WECHAT_READY', accountVerified: true, readerConnected: true, selfId: String(verified.selfId), account: account ? { ...account } : null });
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '', data = [], eventBytes = 0;
      for await (const chunk of response.body) {
        if (!current(signal) || accountLocked || receiveFailed) break;
        resetWatchdog();
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_EVENT_BYTES) throw fault('READER_EVENT_TOO_LARGE');
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          let line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          eventBytes += Buffer.byteLength(line) + 1;
          if (eventBytes > MAX_EVENT_BYTES) throw fault('READER_EVENT_TOO_LARGE');
          if (!line) {
            if (data.length) {
              let payload;
              try { payload = JSON.parse(data.join('\n')); } catch { throw fault('READER_EVENT_INVALID'); }
              await accept(payload, signal);
            }
            data = []; eventBytes = 0;
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (current(signal) && !accountLocked) throw fault('READER_STREAM_DISCONNECTED');
    } finally {
      clearTimeout(watchdog); controller.abort();
      if (streamController === controller) streamController = null;
      if (adapter) adapter.status.reader_connected = false;
    }
  }

  async function reconnect(signal) {
    while (current(signal) && !accountLocked && !receiveFailed) {
      try {
        await verify();
        await consume(signal);
      } catch (error) {
        if (!current(signal)) break;
        markError(error, { disconnected: true });
      }
      if (!current(signal) || accountLocked || receiveFailed) break;
      try { await delay(reconnectDelayMs, undefined, { signal }); } catch { break; }
      if (current(signal)) publish({ state: 'connecting', detail: 'WECHAT_RECONNECTING', accountVerified: false, readerConnected: false });
    }
  }

  async function stopInternal() {
    lifecycle?.abort();
    streamController?.abort();
    clearInterval(healthTimer); healthTimer = null;
    if (adapter) { adapter.stopped = true; adapter.status.hook_account_verified = false; }
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([loop, healthPending, activeSend].filter(Boolean));
    loop = null; healthPending = null; activeSend = null; lifecycle = null;
    adapter = null; config = null; identity = null; accountLocked = false; receiveFailed = false; account = null;
    mediaTransport = null;
    readerConfiguration={state:'pending',version:1,detail:'名单待配置，新增会话尚未接收；连接并同步当前账号后生效。'};
    publish({ state: 'offline', detail: 'WECHAT_DISCONNECTED', accountVerified: false, readerConnected: false, selfId: undefined, account: null, profileError: undefined,
      readerConfiguration:{...readerConfiguration},selfEventsVerified:false });
  }

  function start(value) {
    if (startPending || stopPending) return Promise.reject(fault('WECHAT_BUSY'));
    const epoch = ++generation;
    const job = (async () => { try {
      const next = validateConfig(value);
      await stopInternal();
      if (epoch !== generation) throw fault('WECHAT_START_CANCELLED');
      config = next; lifecycle = new AbortController();
      publish({ state: 'connecting', detail: 'WECHAT_VERIFYING', accountVerified: false, readerConnected: false });
      adapter = new HookOneBot({
        directory: config.dataDir, fetchImpl: boundedJsonFetch, receiptTimeoutMs, pollMs,
        configuration: {
          project: {
            runtime: { sender: 'wechat-hook', weflowMode: 'nt' },
            hook: { baseUrl: config.hookBaseUrl, expectedVersion: config.expectedVersion, requestTimeoutMs, maxConcurrentSends: 1 },
            wechat: { whitelist: { private: config.allowedPrivate, groups: config.allowedGroups }, stickers: config.stickerSettings },
            account: { nicknames: [config.nickname] },
          },
          api: { reader_base_url: config.readerBaseUrl, reader_token: config.readerToken },
          nativeToken: config.nativeToken,
        },
      });
      adapter.originalCheckNative = adapter.checkNative.bind(adapter);
      adapter.checkNative = async () => {
        try { return await verify(); }
        catch (error) { if (current()) { markError(error); streamController?.abort(); } throw error; }
      };
      mediaTransport = createWechatMediaTransport({ dataDir: config.dataDir, signal: lifecycle.signal,
        assertReady: (kind, target) => {
          assertTarget(kind, target);
          if (state.state !== 'ready' || !state.accountVerified || !state.readerConnected) throw fault('WECHAT_NOT_READY');
        },
        verify: async () => { const found = await verify(); return { ...found, selfWxid: adapter.ownWxid }; },
        resolveTarget: resolveMediaTarget, readMessages: wxid => adapter.messages(wxid),
        nativeRunner:mediaNativeRunner??createWechatHookMediaRunner({baseUrl:config.hookBaseUrl,token:config.nativeToken,fetchImpl:boundedJsonFetch}), receiptTimeoutMs, pollMs,
      });
      const found = await verify();
      if (epoch !== generation) throw fault('WECHAT_START_CANCELLED');
      publish({ selfId: String(found.selfId), accountVerified: true });
      await syncReaderConfiguration();
      try { await getProfile(); }
      catch (error) {
        if (epoch !== generation) throw fault('WECHAT_START_CANCELLED');
        if (accountLocked) throw error;
        // Older reviewed builds may lack this read-only endpoint. Never replace
        // missing profile data with the assistant's configured nickname.
        publish({ account: null, profileError: codeOf(error) });
      }
      if (epoch !== generation) throw fault('WECHAT_START_CANCELLED');
      const signal = lifecycle.signal;
      loop = reconnect(signal);
      healthTimer = setInterval(() => {
        if (healthPending || !current(signal) || accountLocked || receiveFailed) return;
        healthPending = verify().then(syncReaderConfiguration).then(() => {
          if (current(signal) && !accountLocked && !receiveFailed && adapter.status.reader_connected) publish({ state: 'ready', detail: 'WECHAT_READY', accountVerified: true, readerConnected: true });
        }).catch(error => {
          if (current(signal)) { markError(error); streamController?.abort(); }
        }).finally(() => { healthPending = null; });
      }, healthIntervalMs);
      return { ...state };
    } catch (error) {
      if (epoch !== generation) throw fault('WECHAT_START_CANCELLED');
      markError(error, { disconnected: true });
      throw fault(codeOf(error));
    } })().finally(() => { if (startPending === job) startPending = null; });
    startPending = job;
    return job;
  }

  function stop() {
    if (stopPending) return stopPending;
    const release=config&&identity&&readerConfiguration.state==='applied'?{
      url:config.readerBaseUrl+'/api/v1/product/subscription',token:config.readerToken,
      body:{version:1,subscriptionId:config.subscriptionId,expectedRevision:readerConfiguration.revision,
        accountDirectory:identity.account,ownWxid:adapter?.ownWxid,private:[],groups:[]},
    }:null;
    generation++;
    lifecycle?.abort(); streamController?.abort();
    for (const controller of controllers) controller.abort();
    const pending = startPending;
    const job = (async () => {
      if (pending) await pending.catch(() => {});
      // Release only our separate lease. A failed/CAS-conflicting release is
      // bounded by the reader's expiry and never rewrites legacy configuration.
      if(release)try{
        const response=await fetchImpl(release.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(1000),headers:{Authorization:'Bearer '+release.token,'Content-Type':'application/json'},body:JSON.stringify(release.body)});
        await response.body?.cancel();
      }catch{}
      await stopInternal(); return { ...state };
    })().finally(() => { if (stopPending === job) stopPending = null; });
    stopPending = job;
    return job;
  }

  async function sendText({ kind, target, text, deliveryId, beforeSubmit, signal } = {}) {
    if (!['private', 'group'].includes(kind) || typeof target !== 'string' || !/^[1-9]\d{0,15}$/.test(target) ||
        typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16_000 ||
        !/^[a-f0-9]{64}$/.test(deliveryId ?? '')) throw fault('WECHAT_SEND_ARGUMENT_INVALID');
    return performSend({ action: kind === 'group' ? 'send_group_msg' : 'send_private_msg',
      params: { [kind === 'group' ? 'group_id' : 'user_id']: target,
        message: [{ type: 'text', data: { text } }], wechatagent_delivery_id: deliveryId } }, deliveryId, {beforeSubmit,signal});
  }

  async function sendSticker({ kind, target, id, deliveryId, beforeSubmit, signal } = {}) {
    assertTarget(kind, target);
    if (!/^[a-f0-9]{64}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(deliveryId ?? '')) throw fault('INVALID_STICKER_REFERENCE');
    return performSend({ action: kind === 'group' ? 'send_group_msg' : 'send_private_msg',
      params: { [kind === 'group' ? 'group_id' : 'user_id']: target,
        message: [{ type: 'wechat_sticker', data: { id } }], wechatagent_delivery_id: deliveryId } }, deliveryId, {beforeSubmit,signal});
  }

  async function sendAttachment(value = {}) {
    assertTarget(value.kind, value.target);
    if (activeSend) throw Object.assign(fault('SENDER_BUSY'), { attempted: false });
    if (!mediaTransport || state.state !== 'ready' || !state.accountVerified || !state.readerConnected) throw fault('WECHAT_NOT_READY');
    const job = mediaTransport.send(value); activeSend = job;
    try { return await job; }
    finally { if (activeSend === job) activeSend = null; }
  }

  async function performSend(request, deliveryId, context = {}) {
    if (!current() || !adapter || accountLocked || receiveFailed || state.state !== 'ready' || !state.accountVerified || !state.readerConnected) {
      throw Object.assign(fault(accountLocked ? 'WECHAT_ACCOUNT_CHANGED' : 'WECHAT_NOT_READY'),{attempted:false});
    }
    if (activeSend) throw Object.assign(fault('SENDER_BUSY'),{attempted:false});
    const ownAdapter = adapter, ownSignal=lifecycle.signal, epoch=generation;
    const beforeSubmit=()=>{
      if(epoch!==generation||adapter!==ownAdapter||!current(ownSignal)||accountLocked||receiveFailed||state.state!=='ready'||!state.accountVerified||!state.readerConnected)throw fault('WECHAT_NOT_READY');
      context.beforeSubmit?.();
      if(context.signal?.aborted)throw fault('WECHAT_SEND_CANCELLED');
    };
    const job = ownAdapter.action(request,{beforeSubmit,signal:context.signal});
    activeSend = job;
    try {
      const response = await job;
      if (response.status !== 'ok' || response.retcode !== 0) {
        const error = fault(codeOf({ message: response.message }));
        if (typeof response.data?.attempted === 'boolean') error.attempted = response.data.attempted;
        throw error;
      }
      // A response cannot confirm a previous connection after stop/reconnect or
      // an account change observed while the receipt was being returned.
      try {
        await verify();
        if(epoch!==generation||adapter!==ownAdapter||!current(ownSignal)||accountLocked)throw fault('WECHAT_ACCOUNT_CHANGED');
      } catch(error) { throw Object.assign(fault(codeOf(error)),{attempted:true}); }
      return { ...response.data, deliveryId };
    } finally { if (activeSend === job) activeSend = null; }
  }

  return { start, stop, getStatus: () => ({ ...state, account: account ? { ...account } : null }),
    getProfile, getDirectory, getSessions, getHistory, resolveImage, getStickers, sendText, sendSticker, sendAttachment };
}
