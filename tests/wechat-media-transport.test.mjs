import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createWechatBridge } from '../packages/wechat-bridge/index.mjs';
import { createWechatMediaTransport, inspectWechatAttachment, matchesWechatAttachmentReceipt, wechatAttachmentUiError } from '../packages/wechat-bridge/media-transport.mjs';

const digest = (bytes, algorithm = 'sha256') => crypto.createHash(algorithm).update(bytes).digest('hex');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function receipt(attachment, extra = {}) {
  return { localId: 101, serverId: '123456789012345678', isSend: true, senderUsername: 'wxid_synthetic_self',
    createTime: Math.floor(Date.now() / 1000), localType: attachment.mediaType === 'image' ? 3 : 25769803825,
    fullText: attachment.mediaType === 'image' ? `<msg><img md5="${attachment.md5}"/></msg>` :
      `<msg><appmsg><title>${escape(attachment.name)}</title><type>6</type><appattach><totallen>${attachment.size}</totallen><filemd5>${attachment.md5}</filemd5></appattach></appmsg></msg>`, ...extra };
}
function fixture(t, { mediaType = 'file', runner, directory, ...options } = {}) {
  const root = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-media-transport-'));
  if (!directory) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const name = mediaType === 'image' ? '合成图片.png' : '合成材料 & 校验.pdf', filename = path.join(root, name), bytes = Buffer.from('synthetic-offline-attachment-content');
  if (!fs.existsSync(filename)) fs.writeFileSync(filename, bytes);
  const attachment = { kind: 'private', target: '101', path: filename, name, sha256: digest(bytes), size: bytes.length,
    mime: mediaType === 'image' ? 'image/png' : 'application/pdf', deliveryId: 'a'.repeat(64), mediaType };
  const checked = inspectWechatAttachment(attachment), aborter = new AbortController();
  const state = { rows: [], calls: 0, account: 'synthetic-account', selfWxid: 'wxid_synthetic_self', target: { wxid: 'wxid_synthetic_friend', name: '合成收件人' }, ready: true };
  const transport = createWechatMediaTransport({ dataDir: root, signal: aborter.signal,
    assertReady(kind, target) { if (!state.ready || aborter.signal.aborted) throw Object.assign(Error('WECHAT_NOT_READY'), { code: 'WECHAT_NOT_READY' }); assert.equal(kind, 'private'); assert.equal(target, '101'); },
    verify: async () => ({ account: state.account, selfWxid: state.selfWxid }), resolveTarget: async () => state.target,
    readMessages: async () => state.rows,
    nativeRunner: async (request, context) => {
      state.calls++; assert.equal(Object.isFrozen(request), true);
      if (runner) return runner({ request, context, state, checked });
      await context.beforeSubmit(); state.rows.push(receipt(checked));
      return { submitted: true, targetChecked: true, windowChecked: true };
    }, receiptTimeoutMs: 20, pollMs: 2, ...options,
  });
  return { root, transport, attachment, checked, state, aborter };
}

test('input UI failures need a strict pre-paste report after a grant, while unknown failures stay uncertain', () => {
  for (const code of ['WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE', 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT']) {
    assert.equal(wechatAttachmentUiError({ code, submitted: false }, true).attempted, false);
    assert.equal(wechatAttachmentUiError({ code, submitted: false }, false).attempted, false);
    for (const submitted of [undefined, null, 0, 'false', true]) {
      const error = wechatAttachmentUiError({ code, submitted }, true);
      assert.equal(error.code, code); assert.equal(error.attempted, true);
    }
  }
  for (const code of ['WECHAT_ATTACHMENT_UI_TIMEOUT', 'WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE', 'WECHAT_ATTACHMENT_UNKNOWN']) {
    assert.equal(wechatAttachmentUiError({ code, submitted: false }, true).attempted, true);
  }
});

test('proven input preflight failures stay rejected before and after the grant without replaying a delivery', async t => {
  for (const code of ['WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE', 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT']) {
    for (const granted of [false, true]) {
      const f = fixture(t, { runner: async ({ context }) => {
        if (granted) await context.beforeSubmit();
        throw wechatAttachmentUiError({ code, submitted: false }, granted);
      } });
      await assert.rejects(f.transport.send(f.attachment), { code, attempted: false });
      const directory = path.join(f.root, 'state', 'media-deliveries');
      const record = JSON.parse(fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0]), 'utf8'));
      assert.equal(record.state, 'rejected'); assert.equal(record.attempted, false);
      await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempted: false });
      assert.equal(f.state.calls, 1);
    }
  }
  for (const event of [
    { code: 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE', submitted: true },
    { code: 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT' },
    { code: 'WECHAT_ATTACHMENT_UI_PREVIEW_UNREADABLE', submitted: false },
    { code: 'WECHAT_ATTACHMENT_UI_TIMEOUT', submitted: false },
    { code: 'WECHAT_ATTACHMENT_UNKNOWN', submitted: false },
  ]) {
    const uncertain = fixture(t, { runner: async ({ context }) => {
      await context.beforeSubmit();
      throw wechatAttachmentUiError(event, true);
    } });
    await assert.rejects(uncertain.transport.send(uncertain.attachment), { code: event.code, attempted: true });
  }
});

test('PowerShell input preflight distinguishes unreadable values from actual drafts without loading the sender', { skip: process.platform !== 'win32' }, () => {
  const source = path.resolve('packages/wechat-bridge/send-attachment-ui.ps1').replaceAll("'", "''");
  const probe = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$tokens,[ref]$parseErrors)
if (@($parseErrors).Count -ne 0) { throw 'Offline sender parse failed' }
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-Input'},$true)
if ($null -eq $definition) { throw 'Missing input preflight' }
Invoke-Expression $definition.Extent.Text
function Fail([string]$code) { throw [System.Exception]::new($code) }
function Get-Elements { return ,$script:elements }
$root=[pscustomobject]@{Current=[pscustomobject]@{BoundingRectangle=[pscustomobject]@{Left=0;Top=0;Height=1000}}}
$cases=@(
  @{Name='unsupported';Readable=$false;Text=''},
  @{Name='pattern-error';Readable=$true;ThrowPattern=$true;Text=''},
  @{Name='value-error';Readable=$true;ThrowValue=$true;Text=''},
  @{Name='null-value';Readable=$true;Text=$null},
  @{Name='empty';Readable=$true;Text=''},
  @{Name='draft';Readable=$true;Text='synthetic-offline-draft'},
  @{Name='whitespace-draft';Readable=$true;Text=' '}
)
$results=@(foreach ($case in $cases) {
  $script:submitted=$false
  $current=[pscustomobject]@{Value=$case.Text}
  if ($case.ThrowValue) { $current | Add-Member -MemberType ScriptProperty -Name Value -Value { throw 'Synthetic unavailable property' } -Force }
  $element=[pscustomobject]@{
    Current=[pscustomobject]@{ControlType=[System.Windows.Automation.ControlType]::Edit;IsOffscreen=$false;IsEnabled=$true;BoundingRectangle=[pscustomobject]@{Left=300;Top=600}}
    Readable=$case.Readable;ThrowPattern=$case.ThrowPattern;Pattern=[pscustomobject]@{Current=$current}
  }
  $element | Add-Member -MemberType ScriptMethod -Name TryGetCurrentPattern -Value {
    param($pattern,[ref]$result)
    if ($this.ThrowPattern) { throw 'Synthetic unavailable pattern' }
    $result.Value=$this.Pattern
    return $this.Readable
  }
  $script:elements=@($element)
  $code='OK'
  try { $null=Find-Input } catch { $code=$_.Exception.Message }
  @{name=$case.Name;code=$code;submitted=$script:submitted}
})
$results | ConvertTo-Json -Compress
`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  const results = JSON.parse(output);
  for (const item of results) {
    const expected = item.name === 'empty' ? 'OK' : item.name.includes('draft') ? 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT' : 'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE';
    assert.equal(item.code, expected, item.name); assert.equal(item.submitted, false, item.name);
  }
  assert.equal(results.length, 7);
});

test('image and file sends require exact database media and return the actual server ID', async t => {
  for (const mediaType of ['image', 'file']) {
    const f = fixture(t, { mediaType });
    const result = await f.transport.send(f.attachment);
    assert.equal(result.receipt, 'wechat-server-id'); assert.equal(result.delivered, 'database-confirmed');
    assert.equal(result.message_id, '123456789012345678'); assert.equal(result.local_message_id, '101');
    assert.equal(result.media_type, mediaType === 'image' ? 'wechat-image' : 'wechat-file');
    assert.equal((await f.transport.send(f.attachment)).reused, true); assert.equal(f.state.calls, 1);
    const record = fs.readFileSync(path.join(f.root, 'state', 'media-deliveries', fs.readdirSync(path.join(f.root, 'state', 'media-deliveries'))[0]), 'utf8');
    assert.equal(record.includes(f.attachment.path), false); assert.equal(record.includes('synthetic-offline-attachment-content'), false);
  }
});

test('attachment integrity, names, media limits and symlink checks fail before UI submission', async t => {
  const f = fixture(t);
  for (const patch of [{ sha256: 'f'.repeat(64) }, { size: f.attachment.size + 1 }, { name: '../bad.pdf' }, { mime: 'text/plain\nextra' }, { size: 51 * 1024 * 1024 }, { mediaType: 'image', mime: 'application/pdf' }]) {
    await assert.rejects(f.transport.send({ ...f.attachment, ...patch }));
  }
  fs.appendFileSync(f.attachment.path, 'changed');
  await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ATTACHMENT_INTEGRITY_FAILED' });
  assert.equal(f.state.calls, 0);
});

test('receipt matching rejects wrong hash, name, size, direction, type, time, identity and zero IDs', async t => {
  const f = fixture(t), startedAt = Date.now(), attempt = { baseline: [], startedAt, selfWxid: f.state.selfWxid };
  assert.equal(matchesWechatAttachmentReceipt(receipt(f.checked), f.checked, attempt), true);
  const invalid = [
    { serverId: '0' }, { serverId: 'not-an-id' }, { isSend: false }, { isSend: '1' }, { localType: 1 }, { localId: '0' },
    { senderUsername: 'wxid_other' }, { createTime: Math.floor(startedAt / 1000) - 1 },
    { fullText: receipt(f.checked).fullText.replace(f.checked.md5, 'b'.repeat(32)) },
    { fullText: receipt(f.checked).fullText.replace('<totallen>' + f.checked.size, '<totallen>1') },
    { fullText: receipt(f.checked).fullText.replace(escape(f.checked.name), '别的文件.pdf') },
    { fullText: '<!DOCTYPE msg [<!ENTITY sample SYSTEM "file:///private">]>' + receipt(f.checked).fullText },
  ];
  for (const row of invalid) assert.equal(matchesWechatAttachmentReceipt(receipt(f.checked, row), f.checked, attempt), false, JSON.stringify(row));
  assert.equal(matchesWechatAttachmentReceipt(receipt(f.checked), f.checked, { ...attempt, baseline: ['101'] }), false);
  const image = fixture(t, { mediaType: 'image' });
  assert.equal(matchesWechatAttachmentReceipt(receipt(image.checked, { fullText: '<msg><img md5="' + 'b'.repeat(32) + '"/></msg>' }), image.checked, { ...attempt, baseline: [] }), false);
});

test('accepted UI work with no exact receipt never retries, including after transport reconstruction', async t => {
  const runner = async ({ context, state, checked }) => { await context.beforeSubmit(); state.rows.push(receipt(checked, { fullText: '<msg><appmsg><type>6</type></appmsg></msg>' })); return { submitted: true, targetChecked: true, windowChecked: true }; };
  const f = fixture(t, { runner });
  await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempted: true });
  await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempted: true });
  const resumed = fixture(t, { directory: f.root, runner });
  await assert.rejects(resumed.transport.send(resumed.attachment), { code: 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempted: true });
  assert.equal(f.state.calls, 1); assert.equal(resumed.state.calls, 0);
});

test('ambiguous new exact media rows are never attributed to a single UI submission', async t => {
  const f = fixture(t, { runner: async ({ context, state, checked }) => { await context.beforeSubmit(); state.rows.push(receipt(checked), receipt(checked, { localId: 102, serverId: '9999' })); return { submitted: true, targetChecked: true, windowChecked: true }; } });
  await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ATTACHMENT_RECEIPT_AMBIGUOUS', attempted: true });
});

test('global media exclusion spans separate bridges and grants only one submission', async t => {
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), entry = new Promise(resolve => { entered = resolve; });
  const first = fixture(t, { runner: async ({ context, state, checked }) => { entered(); await gate; await context.beforeSubmit(); state.rows.push(receipt(checked)); return { submitted: true, targetChecked: true, windowChecked: true }; } });
  const second = fixture(t); const sending = first.transport.send(first.attachment); await entry;
  await assert.rejects(second.transport.send(second.attachment), { code: 'SENDER_BUSY', attempted: false });
  release(); await sending;
  const duplicate = fixture(t, { runner: async ({ context }) => { await context.beforeSubmit(); await context.beforeSubmit(); } });
  await assert.rejects(duplicate.transport.send(duplicate.attachment), { code: 'WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', attempted: true });
});

test('account changes and cancellation revoke the final submission grant', async t => {
  for (const mode of ['account', 'mapping', 'abort']) {
    const f = fixture(t, { runner: async ({ context, state }) => {
      if (mode === 'account') state.account = 'changed-account';
      if (mode === 'mapping') state.target = { ...state.target, wxid: 'changed-target' };
      if (mode === 'abort') f.aborter.abort();
      await context.beforeSubmit(); assert.fail('revoked grant must not reach UI');
    } });
    await assert.rejects(f.transport.send(f.attachment), { attempted: false }); assert.equal(f.state.calls, 1);
  }
});

test('unreadable target and runner without a trusted grant never claim successful sending', async t => {
  const unreadable = fixture(t, { runner: async () => { throw Object.assign(Error('WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE'), { code: 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE' }); } });
  await assert.rejects(unreadable.transport.send(unreadable.attachment), { code: 'WECHAT_ATTACHMENT_UI_TARGET_UNREADABLE', attempted: false });
  await assert.rejects(unreadable.transport.send(unreadable.attachment), { code: 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempted: false });
  assert.equal(unreadable.state.calls, 1);
  const noGrant = fixture(t, { runner: async () => ({ submitted: true, targetChecked: true, windowChecked: true }) });
  await assert.rejects(noGrant.transport.send(noGrant.attachment), { code: 'WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', attempted: false });
});

test('a changed account after the receipt query cannot turn media into a confirmed delivery', async t => {
  const f = fixture(t, { readMessages: async () => {
    if (f.state.rows.length) f.state.account = 'changed-after-query';
    return f.state.rows;
  } });
  await assert.rejects(f.transport.send(f.attachment), { code: 'WECHAT_ACCOUNT_CHANGED', attempted: true });
  assert.equal(f.state.calls, 1);
});

test('same delivery identity cannot be reused for different attachment content', async t => {
  const f = fixture(t); await f.transport.send(f.attachment);
  const content = Buffer.from('different synthetic content'); fs.writeFileSync(f.attachment.path, content);
  await assert.rejects(f.transport.send({ ...f.attachment, sha256: digest(content), size: content.length }), { code: 'WECHAT_ATTACHMENT_DELIVERY_CONFLICT' });
  assert.equal(f.state.calls, 1);
});

test('product bridge wires its exact target mapping, account grant and attachment server receipt', async t => {
  const f = fixture(t), clients = new Set(), backend = { rows: [], calls: 0 }, events = [];
  const readerToken = 'synthetic-media-reader-token', nativeToken = 'c'.repeat(64);
  const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const isNative = ['/WeChatAgent/health', '/GetSelfProfile'].includes(url.pathname);
    if (request.headers.authorization !== 'Bearer ' + (isNative ? nativeToken : readerToken)) return json(response, {}, 401);
    if (url.pathname === '/WeChatAgent/health') return json(response, { integration: 'WeChatAgent-1', backend: 'wechat-hook', version: '4.1.10.27', startupState: 'ready', databaseAccounts: ['synthetic-account'] });
    if (url.pathname === '/api/v1/reader/status') return json(response, { backend: 'weflow-cli-nt', ownWxid: f.state.selfWxid, accountDirectory: 'synthetic-account' });
    if (url.pathname === '/GetSelfProfile') return json(response, { wxid: f.state.selfWxid, nickname: '已核验真实昵称' });
    if (url.pathname === '/api/v1/sessions') return json(response, { sessions: [{ username: f.state.target.wxid, displayName: f.state.target.name, conversationId: 101 }] });
    if (url.pathname === '/api/v1/contacts') return json(response, { contacts: [{ username: f.state.target.wxid, displayName: f.state.target.name, conversationId: 101 }] });
    if (url.pathname === '/api/v1/messages') return json(response, { messages: backend.rows });
    if (url.pathname === '/api/v1/push/messages') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n'); clients.add(response); request.on('close', () => clients.delete(response)); return; }
    return json(response, {}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = 'http://127.0.0.1:' + server.address().port;
  const bridge = createWechatBridge({ onMessage: event => events.push(event), receiptTimeoutMs: 60, pollMs: 5, healthIntervalMs: 1000, mediaNativeRunner: async (request, context) => {
    backend.calls++; assert.equal(request.targetName, f.state.target.name); assert.equal(request.targetWxid, f.state.target.wxid);
    await context.beforeSubmit(); backend.rows.push(receipt(f.checked)); return { submitted: true, targetChecked: true, windowChecked: true };
  } });
  t.after(async () => { await bridge.stop(); for (const client of clients) client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await bridge.start({ dataDir: f.root, readerBaseUrl: base, hookBaseUrl: base, readerToken, nativeToken, allowedPrivate: ['101'], allowedGroups: ['202'] });
  const end = Date.now() + 3000; while (bridge.getStatus().state !== 'ready') { if (Date.now() > end) throw Error('SYNTHETIC_BRIDGE_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 5)); }
  for (const client of clients) client.write('data: ' + JSON.stringify({ event: 'message.new', type: 1, sessionId: 'synthetic@chatroom', talkerId: 'wxid_synthetic_member', conversationId: 202,
    rawid: '81234', content: '@已核验真实昵称\u2005合成群唤醒', timestamp: Math.floor(Date.now() / 1000), groupName: '合成测试群' }) + '\n\n');
  while (!events.length) { if (Date.now() > end) throw Error('SYNTHETIC_MENTION_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(events[0].segments?.some(segment => segment.type === 'at' && String(segment.data.qq) === events[0].self_id), true);
  const result = await bridge.sendAttachment(f.attachment); assert.equal(result.message_id, '123456789012345678'); assert.equal(backend.calls, 1);
  assert.equal((await bridge.sendAttachment(f.attachment)).reused, true); assert.equal(backend.calls, 1);
  await assert.rejects(bridge.sendAttachment({ ...f.attachment, target: '999' }), { code: 'CONVERSATION_NOT_ALLOWED' });
});
