import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { createStore } from '../packages/storage/index.mjs';
import { createMailController } from '../packages/mail-plugin/index.mjs';

const PASSWORD = 'test-only-mail-credential-NEVER-REAL';
const config = (address = 'owner@example.test', extra = {}) => ({ name: '工作邮箱', address, imap: { host: 'imap.example.test', secure: true }, smtp: { host: 'smtp.example.test', secure: false }, auth: { type: 'password', password: PASSWORD }, ...extra });
const mime = ({ subject = '本地测试邮件', attachment = false } = {}) => Buffer.from([
  'From: Test Sender <friend@example.test>', 'To: owner@example.test', `Subject: ${subject}`, 'Message-ID: <local-test-1@example.test>', 'Date: Sun, 25 Oct 2026 12:00:00 +0800',
  ...(attachment ? ['MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="test-boundary"', '', '--test-boundary', 'Content-Type: text/plain; charset=utf-8', '', '附件请核对', '--test-boundary', 'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="../../payload.exe"', 'Content-Transfer-Encoding: base64', '', Buffer.from('fixture-only-attachment').toString('base64'), '--test-boundary--'] : ['Content-Type: text/plain; charset=utf-8', '', '这是本机模拟邮件正文。'])
].join('\r\n'));

function vault() { const data = new Map(); return { data, get: async key => data.get(key), set: async (key, value) => data.set(key, value), delete: async key => data.delete(key) }; }
function fakeImap(sources, audit = [], { uidValidity = '11', oversized = false } = {}) {
  return options => {
    audit.push({ type: 'options', options }); const client = new EventEmitter();
    client.mailbox = { exists: sources.length, uidValidity: BigInt(uidValidity) };
    client.connect = async () => { audit.push({ type: 'connect' }); };
    client.getMailboxLock = async (name, settings) => { audit.push({ type: 'lock', name, settings }); return { release() { audit.push({ type: 'release' }); } }; };
    client.fetch = async function* (range, query) { audit.push({ type: 'fetch', range, query }); for (let index = 0; index < sources.length; index++) yield { uid: index + 1, size: oversized ? 9 * 1024 * 1024 : sources[index].length, flags: new Set(), envelope: { subject: 'metadata', from: [{ address: 'friend@example.test' }] } }; };
    client.fetchOne = async (uid, query, settings) => { audit.push({ type: 'source', uid, query, settings }); return { uid: Number(uid), source: sources[Number(uid) - 1] }; };
    client.close = () => { audit.push({ type: 'close' }); };
    return client;
  };
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-mail-test-'));
  let store = await createStore(directory), controller;
  const secrets = options.secretStore ?? vault();
  const make = () => createMailController({ dataDir: directory, store, secretStore: secrets, imapFactory: () => { throw Error('Unexpected network'); }, smtpFactory: () => { throw Error('Unexpected SMTP network'); }, ...options });
  controller = make();
  t.after(async () => { await controller.close(); store.close(); if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('assistant-mail-test-')) throw Error('Unexpected test cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, secrets, get store() { return store; }, get controller() { return controller; }, async restart() { await controller.close(); store.close(); store = await createStore(directory); store.recover(); controller = make(); return controller; } };
}

test('multi-account JSON import protects credentials and updates one account without changing another', async t => {
  const context = await setup(t), { controller, secrets, directory } = context;
  const imported = await controller.importAccounts(JSON.stringify({ accounts: [config(), config('second@example.test', { name: '个人邮箱' })] }));
  assert.equal(imported.imported, 2); assert.equal(controller.getState().accounts.length, 2); assert.equal(secrets.data.size, 2);
  assert.equal(JSON.stringify(controller.getState()).includes(PASSWORD), false);
  assert.equal(fs.readFileSync(path.join(directory, 'assistant.sqlite')).includes(Buffer.from(PASSWORD)), false);
  const original = controller.getState().accounts;
  await controller.importAccounts({ accounts: [config('owner@example.test', { name: '修改后的邮箱' })] });
  const updated = controller.getState().accounts;
  assert.equal(updated[0].id, original[0].id); assert.equal(updated[0].name, '修改后的邮箱'); assert.deepEqual(updated[1], original[1]); assert.equal(secrets.data.size, 2);
});

test('invalid configuration and protected-credential failure cannot leave half-imported accounts', async t => {
  const context = await setup(t), { controller } = context;
  await assert.rejects(controller.importAccounts({ accounts: [config(), config('bad\r\nBcc:other@example.test')] }), /控制字符|邮箱地址/);
  assert.equal(controller.getState().accounts.length, 0);
  await assert.rejects(controller.importAccounts({ accounts: [config(), config()] }), /重复邮箱/);
  let writes = 0; const originalSet = context.secrets.set; context.secrets.set = async (...args) => { if (++writes === 2) throw Error('Vault failed'); return originalSet(...args); };
  await assert.rejects(controller.importAccounts({ accounts: [config(), config('second@example.test')] }), /保存失败/);
  assert.equal(context.secrets.data.size, 0); assert.equal(controller.getState().accounts.length, 0);
});

test('IMAP synchronization uses a read-only mailbox and bounded UID body requests, preserves unread status', async t => {
  const audit = [], context = await setup(t, { imapFactory: fakeImap([mime()], audit) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const result = await context.controller.sync({ accountId: accounts[0].id });
  assert.equal(result.readOnly, true); assert.equal(result.pagination, 'latest-only'); assert.equal(result.received, 1);
  assert.equal(result.messages[0].unread, true); assert.match(result.messages[0].text, /模拟邮件正文/); assert.equal(result.messages[0].html, undefined);
  assert.deepEqual(audit.find(item => item.type === 'lock').settings, { readOnly: true });
  const source = audit.find(item => item.type === 'source'); assert.deepEqual(source.settings, { uid: true }); assert.equal(source.query.source.maxLength, 8 * 1024 * 1024 + 1);
  const options = audit.find(item => item.type === 'options').options; assert.equal(options.logger, false); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.auth.pass, PASSWORD);
  const again = await context.controller.sync({ accountId: accounts[0].id }); assert.equal(again.messages[0].id, result.messages[0].id); assert.equal(context.controller.getState().messages.length, 1);
});

test('STARTTLS is mandatory for non-implicit TLS IMAP and expired OAuth tokens never open a connection', async t => {
  const audit = [], context = await setup(t, { imapFactory: fakeImap([mime()], audit) });
  let { accounts } = await context.controller.importAccounts({ accounts: [config('owner@example.test', { imap: { host: 'imap.example.test', secure: false } })] });
  await context.controller.sync({ accountId: accounts[0].id }); assert.equal(audit[0].options.doSTARTTLS, true);
  ({ accounts } = await context.controller.importAccounts({ accounts: [config('expired@example.test', { auth: { type: 'oauth2', accessToken: 'test-only-expired-oauth', expiresAt: '2000-01-01T00:00:00Z' } })] }));
  const count = audit.filter(item => item.type === 'connect').length;
  await assert.rejects(context.controller.sync({ accountId: accounts[0].id }), /已过期/); assert.equal(audit.filter(item => item.type === 'connect').length, count);
});

test('attachments stay in quarantine with opaque paths and cannot be resolved under another email or after tampering', async t => {
  const context = await setup(t, { imapFactory: fakeImap([mime({ attachment: true }), mime({ subject: 'another' })]) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const result = await context.controller.sync({ accountId: accounts[0].id }), message = result.messages[0], attachment = message.attachments[0];
  assert.equal(attachment.name, 'payload.exe'); assert.equal(attachment.path, undefined); assert.equal(attachment.quarantine, true);
  const resolved = context.controller.resolveAttachment({ messageId: message.id, attachmentId: attachment.id });
  assert.match(resolved.path, /quarantine/); assert.equal(path.extname(resolved.path), '.bin'); assert.equal(fs.readFileSync(resolved.path, 'utf8'), 'fixture-only-attachment');
  assert.throws(() => context.controller.resolveAttachment({ messageId: result.messages[1].id, attachmentId: attachment.id }), /没有可读取/);
  fs.writeFileSync(resolved.path, 'fixture-only-ATTACHMENT'); assert.throws(() => context.controller.resolveAttachment({ messageId: message.id, attachmentId: attachment.id }), /变化|校验/);
});

test('large messages keep metadata without downloading bodies or attachments', async t => {
  const audit = [], context = await setup(t, { imapFactory: fakeImap([mime()], audit, { oversized: true }) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const result = await context.controller.sync({ accountId: accounts[0].id });
  assert.equal(result.messages[0].bodyStatus, 'omitted-size-limit'); assert.equal(audit.some(item => item.type === 'source'), false);
});

test('Reply-To is normalized, bounded and retained across storage restart without sending', async t => {
  const source=mime().toString().replace('To: owner@example.test', 'Reply-To: Reply Desk <reply@EXAMPLE.TEST>, reply@EXAMPLE.TEST, broken-address\r\nTo: owner@example.test');
  const context=await setup(t,{imapFactory:fakeImap([Buffer.from(source)])});
  const {accounts}=await context.controller.importAccounts({accounts:[config()]});
  const result=await context.controller.sync({accountId:accounts[0].id});
  assert.deepEqual(result.messages[0].replyTo,[{name:'Reply Desk',address:'reply@example.test'}]);
  await context.restart();
  assert.deepEqual(context.controller.getMessage({messageId:result.messages[0].id}).replyTo,result.messages[0].replyTo);
  assert.equal(context.controller.getState().drafts.length,0);
});

test('Reply-To keeps at most 50 valid recipients and falls back cleanly for absent or invalid headers', async t => {
  const base=mime().toString(),header=Array.from({length:65},(_,i)=>`reply${i}@example.test`).join(', ');
  const sources=[base.replace('To: owner@example.test',`Reply-To: ${header}\r\nTo: owner@example.test`),base,base.replace('To: owner@example.test','Reply-To: invalid-address\r\nTo: owner@example.test')].map(text=>Buffer.from(text));
  const context=await setup(t,{imapFactory:fakeImap(sources)});
  const {accounts}=await context.controller.importAccounts({accounts:[config()]});
  const {messages}=await context.controller.sync({accountId:accounts[0].id});
  assert.equal(messages[0].replyTo.length,50);assert.equal(messages[0].replyTo.at(-1).address,'reply49@example.test');
  assert.deepEqual(messages[1].replyTo,[]);assert.deepEqual(messages[2].replyTo,[]);
});

test('mailbox UIDVALIDITY changes create distinct identities instead of overwriting an old email', async t => {
  let validity = '11'; const context = await setup(t, { imapFactory: options => fakeImap([mime()], [], { uidValidity: validity })(options) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const first = await context.controller.sync({ accountId: accounts[0].id }); validity = '12'; const second = await context.controller.sync({ accountId: accounts[0].id });
  assert.notEqual(first.messages[0].id, second.messages[0].id); assert.equal(context.controller.getState().messages.length, 2);
});

test('manual SMTP send persists its receipt and repeated clicks or restart never resend the immutable draft', async t => {
  let sends = 0, observedSending = false, suppliedOptions, suppliedMessage; let context;
  context = await setup(t, { smtpFactory: options => { suppliedOptions = options; return { async sendMail(message) { sends++; suppliedMessage = message; observedSending = context.store.getMailDraft(message.messageId.slice(1, -'@assistant.local>'.length)).status === 'sending'; await new Promise(resolve => setTimeout(resolve, 10)); return { accepted: ['friend@example.test'], rejected: [], response: '250 2.0.0 local fixture accepted' }; }, close() {} }; } });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: '本机测试', text: '只发送给测试替身' });
  assert.equal(sends, 0);
  const [first, second] = await Promise.all([context.controller.sendDraft({ draftId: draft.id }), context.controller.sendDraft({ draftId: draft.id })]);
  assert.equal(sends, 1); assert.equal(observedSending, true); assert.equal(first.status, 'smtp-accepted'); assert.deepEqual(first, second);
  assert.equal(first.receipt.kind, 'smtp-server-accepted'); assert.equal(first.receipt.delivery, 'server-accepted');
  assert.equal(suppliedOptions.requireTLS, true); assert.equal(suppliedOptions.disableFileAccess, true); assert.equal(suppliedOptions.disableUrlAccess, true); assert.equal(suppliedOptions.tls.rejectUnauthorized, true);
  assert.deepEqual(suppliedMessage.envelope.to, ['friend@example.test']); assert.equal(suppliedMessage.attachments, undefined);
  await context.restart(); const after = await context.controller.sendDraft({ draftId: draft.id }); assert.equal(after.status, 'smtp-accepted'); assert.equal(sends, 1);
});

test('lost SMTP acknowledgement is unconfirmed, hides raw server errors and is never automatically retried', async t => {
  let sends = 0; const context = await setup(t, { smtpFactory: () => ({ async sendMail() { sends++; throw Error(`server dropped after DATA password=${PASSWORD}`); }, close() {} }) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: '未确认测试', text: '测试' });
  const result = await context.controller.sendDraft({ draftId: draft.id }); assert.equal(result.status, 'unconfirmed'); assert.equal(result.receipt.delivery, 'unknown'); assert.equal(JSON.stringify(result).includes(PASSWORD), false);
  await context.controller.sendDraft({ draftId: draft.id }); await context.restart(); await context.controller.sendDraft({ draftId: draft.id }); assert.equal(sends, 1);
});

test('preexisting interrupted SMTP attempts recover as unconfirmed without making a connection', async t => {
  const context = await setup(t); const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: '', text: '测试中断' });
  context.store.updateMailDraft(draft.id, { status: 'sending', receipt: { kind: 'smtp-attempt' } });
  await context.restart(); const result = await context.controller.sendDraft({ draftId: draft.id }); assert.equal(result.status, 'unconfirmed'); assert.match(result.error, /中断/);
});

test('SMTP header injection is rejected and a read-only account cannot send', async t => {
  const context = await setup(t); const { accounts } = await context.controller.importAccounts({ accounts: [config('owner@example.test', { smtp: null })] });
  assert.throws(() => context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: 'hello\r\nBcc:third@example.test', text: 'test' }), /控制字符/);
  assert.throws(() => context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test\r\nBcc:third@example.test'], text: 'test' }), /控制字符/);
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: 'read only', text: 'test' });
  assert.throws(() => context.controller.sendDraft({ draftId: draft.id }), /SMTP/); assert.equal(context.store.getMailDraft(draft.id).status, 'draft');
});

async function smtpFixture(t, { dropAfterData = false } = {}) {
  const sockets = new Set(), messages = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8');
    socket.write('220 localhost fixture ESMTP\r\n'); let buffer = '', data = false, body = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n'), line = buffer.slice(0, offset); buffer = buffer.slice(offset + 2);
        if (data) { if (line !== '.') { body += line + '\r\n'; continue; } data = false; messages.push(body); if (dropAfterData) { socket.destroy(); return; } socket.write('250 2.0.0 fixture queued\r\n'); continue; }
        if (/^EHLO|^HELO/.test(line)) socket.write('250-localhost fixture\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/.test(line)) socket.write('235 2.7.0 fixture authentication accepted\r\n');
        else if (/^MAIL FROM:|^RCPT TO:/.test(line)) socket.write('250 2.1.0 fixture accepted\r\n');
        else if (line === 'DATA') { data = true; body = ''; socket.write('354 send fixture data\r\n'); }
        else if (line === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { messages, factory: options => nodemailer.createTransport({ ...options, host: '127.0.0.1', port: server.address().port, secure: false, requireTLS: false, ignoreTLS: true }) };
}

test('actual Nodemailer SMTP protocol confirms local DATA receipt and includes a stable Message-ID', async t => {
  const fixture = await smtpFixture(t), context = await setup(t, { smtpFactory: fixture.factory });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], bcc: ['hidden@example.test'], subject: 'Local SMTP fixture', text: 'Fixture body' });
  const result = await context.controller.sendDraft({ draftId: draft.id });
  assert.equal(result.status, 'smtp-accepted'); assert.equal(fixture.messages.length, 1); assert.match(fixture.messages[0].replace(/\r\n[ \t]+/g, ' '), new RegExp(`Message-ID: <${draft.id}@assistant.local>`)); assert.equal(/\r\nBcc:/i.test(fixture.messages[0]), false);
});

test('actual Nodemailer SMTP connection loss after DATA records uncertainty and repeated clicks do not retransmit', async t => {
  const fixture = await smtpFixture(t, { dropAfterData: true }), context = await setup(t, { smtpFactory: fixture.factory });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const draft = context.controller.createDraft({ accountId: accounts[0].id, to: ['friend@example.test'], subject: 'Unconfirmed local SMTP', text: 'Fixture body' });
  const result = await context.controller.sendDraft({ draftId: draft.id }); assert.equal(result.status, 'unconfirmed'); assert.equal(fixture.messages.length, 1);
  await context.controller.sendDraft({ draftId: draft.id }); assert.equal(fixture.messages.length, 1);
});

test('actual ImapFlow protocol opens EXAMINE and UID BODY.PEEK without STORE or SELECT', async t => {
  const sockets = new Set(), commands = [], source = mime({ attachment: true });
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8');
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] local test fixture\r\n'); let buffer = '', authenticateTag;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n'), line = buffer.slice(0, offset); buffer = buffer.slice(offset + 2);
        if (authenticateTag) { socket.write(`${authenticateTag} OK authenticated\r\n`); authenticateTag = null; continue; }
        const match = /^(\S+) (.*)$/.exec(line); if (!match) continue;
        const [, tag, command] = match; commands.push(command.replace(/^(LOGIN|AUTHENTICATE).*$/i, '$1 [fixture credentials omitted]'));
        if (/^CAPABILITY/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK capability\r\n`);
        else if (/^AUTHENTICATE PLAIN\s+\S+/i.test(command) || /^LOGIN /i.test(command)) socket.write(`${tag} OK authenticated\r\n`);
        else if (/^AUTHENTICATE/i.test(command)) { authenticateTag = tag; socket.write('+ \r\n'); }
        else if (/^LIST /i.test(command)) socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (/^EXAMINE /i.test(command)) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 11] fixture\r\n* OK [UIDNEXT 2] fixture\r\n${tag} OK [READ-ONLY] examined\r\n`);
        else if (/^UID FETCH /i.test(command)) { socket.write(`* 1 FETCH (UID 1 BODY[] {${source.length}}\r\n`); socket.write(source); socket.write(`)\r\n${tag} OK fetched\r\n`); }
        else if (/^FETCH /i.test(command)) socket.write(`* 1 FETCH (UID 1 RFC822.SIZE ${source.length} FLAGS ())\r\n${tag} OK fetched\r\n`);
        else if (/^LOGOUT/i.test(command)) socket.end(`* BYE fixture\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} OK fixture\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const context = await setup(t, { imapFactory: options => new ImapFlow({ ...options, host: '127.0.0.1', port: server.address().port, secure: false, doSTARTTLS: false }) });
  const { accounts } = await context.controller.importAccounts({ accounts: [config()] });
  const result = await context.controller.sync({ accountId: accounts[0].id });
  assert.equal(result.received, 1); assert.match(result.messages[0].text, /附件请核对/); assert.equal(result.messages[0].attachments.length, 1);
  assert.ok(commands.some(command => /^EXAMINE /i.test(command))); assert.ok(commands.some(command => /^UID FETCH .*BODY\.PEEK\[\]/i.test(command))); assert.equal(commands.some(command => /^(?:UID )?STORE |^SELECT /i.test(command)), false);
});
