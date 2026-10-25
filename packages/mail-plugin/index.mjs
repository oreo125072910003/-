import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { boundedText, safeId } from '../contracts/index.mjs';
import { addresses, email, importInput, object, plain, runtimeAuth } from './config.mjs';

const stamp = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = values => hash(JSON.stringify(values)).slice(0, 32);
const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_SYNC_SOURCE = 32 * 1024 * 1024;
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const TIMEOUT = 60000;
const clone = value => JSON.parse(JSON.stringify(value));
const addressValues = parsed => (parsed?.value ?? []).flatMap(value => value.group ?? [value]).slice(0, 100).map(value => ({ name: String(value.name ?? '').slice(0, 200), address: String(value.address ?? '').slice(0, 320) }));
const replyAddresses = parsed => {
  const result = [], seen = new Set();
  for (const value of (parsed?.value ?? []).flatMap(item => item.group ?? [item]).slice(0, 100)) {
    try {
      const address = email(value.address);
      if (seen.has(address)) continue;
      seen.add(address); result.push({ name: String(value.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200), address });
      if (result.length === 50) break;
    } catch { /* Invalid incoming reply addresses cannot become recipients. */ }
  }
  return result;
};
const cleanName = value => path.win32.basename(path.posix.basename(String(value ?? '附件'))).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || '附件';

function publicAccount(account, busy) {
  const { credentialRef, ...visible } = account;
  return { ...clone(visible), credentialsConfigured: !!credentialRef, busy };
}

function readError(error) {
  if (error?.authenticationFailed || error?.code === 'EAUTH') return '邮箱登录未通过，请检查授权码、IMAP 开关或访问令牌。';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code)) return '邮箱服务器证书未通过校验，请检查服务器地址和证书。';
  if (error?.code === 'MAIL_TIMEOUT') return '收信连接超时，请检查服务器设置后手动重试。';
  return '邮箱读取失败，请检查服务器、网络和邮箱授权；未更改服务器邮件。';
}

function ensureDirectory(root, parts) {
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw Error('邮件附件目录无效，已停止读取附件。');
  }
  return directory;
}

function archiveAttachment(root, messageId, item, index) {
  const digest = hash(item.content), attachmentId = 'mailattachment_' + identity([messageId, index, digest]);
  const directory = ensureDirectory(root, ['mail', 'quarantine', messageId]);
  const filename = path.join(directory, attachmentId + '.bin');
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600); fs.writeFileSync(fd, item.content); fs.fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = fs.lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size !== item.content.length || hash(fs.readFileSync(filename)) !== digest) throw Error('隔离附件已被修改，未覆盖原文件。');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { id: attachmentId, name: cleanName(item.filename), size: item.content.length, sha256: digest, contentType: String(item.contentType ?? 'application/octet-stream').slice(0, 120), quarantine: true };
}

export function createMailController({ store, dataDir, secretStore, onChange = () => {}, imapFactory = options => new ImapFlow(options), smtpFactory = options => nodemailer.createTransport(options) }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const root = fs.realpathSync(dataDir), active = new Map(), clients = new Set(), cancelled = new WeakSet();
  let closing = false, importing = false, closeOperation, importOperation;
  const notify = () => { try { onChange(); } catch {} };
  const accountById = id => { const value = store.getMailAccount(safeId(id)); if (!value) throw Error('没有找到这个邮箱账号。'); return value; };
  const messageById = id => { const value = store.getMailMessage(safeId(id)); if (!value) throw Error('没有找到这封邮件。'); return value; };
  const draftById = id => { const value = store.getMailDraft(safeId(id)); if (!value) throw Error('没有找到这封邮件草稿。'); return value; };
  function usable() { if (closing) throw Error('邮件插件正在关闭。'); if (importing) throw Error('正在导入邮箱配置，请稍后重试。'); }
  async function credentials(account) {
    const raw = await secretStore?.get(account.credentialRef);
    if (!raw) throw Error('系统中没有这个邮箱的受保护凭据，请重新导入。');
    try { const parsed = JSON.parse(raw); if (parsed.accountId !== account.id) throw Error(); return parsed; }
    catch { throw Error('邮箱凭据与账号不匹配，请重新导入。'); }
  }
  async function bounded(operation, client) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { cancelled.add(client); try { client.close?.(); } catch {} const error = Error('MAIL_TIMEOUT'); error.code = 'MAIL_TIMEOUT'; reject(error); }, TIMEOUT); })]);
    } finally { clearTimeout(timer); }
  }
  function track(key, execute) {
    if (active.has(key)) return active.get(key);
    const operation = Promise.resolve().then(execute).finally(() => { active.delete(key); notify(); });
    active.set(key, operation); notify(); return operation;
  }
  function accountBusy(id) { return [...active.keys()].some(key => key === `sync:${id}` || key.startsWith(`send:${id}:`)); }

  const api = {
    getState() {
      const accounts = store.listMailAccounts().map(account => publicAccount(account, accountBusy(account.id)));
      return { accounts, messages: store.listMailMessages(), drafts: store.listMailDrafts(), status: accounts.length ? 'configured' : 'unconfigured', automaticSending: false };
    },

    async importAccounts(input) {
      usable();
      if (!secretStore?.get || !secretStore?.set || !secretStore?.delete) throw Error('系统凭据保护不可用，未导入邮箱。');
      const items = importInput(input), existing = store.listMailAccounts(), ids = new Set(), names = new Set(), savedSecrets = [];
      const prepared = items.map(item => {
        const matching = item.id ? existing.find(account => account.id === item.id) : existing.find(account => account.address.toLowerCase() === item.address.toLowerCase());
        if (item.id && !matching) throw Error('更新的邮箱账号不存在，请去掉 id 作为新账号导入。');
        if (matching && matching.address.toLowerCase() !== item.address.toLowerCase()) throw Error('不能用另一个邮箱地址覆盖已有账号，请新增账号。');
        const id = matching?.id ?? 'mailaccount_' + randomUUID();
        if (accountBusy(id)) throw Error('该邮箱正在收信或发送，请完成后再更换配置。');
        if (ids.has(id) || names.has(item.address.toLowerCase())) throw Error('同一批配置里含有重复邮箱。');
        ids.add(id); names.add(item.address.toLowerCase());
        const credentialRef = `mail:${id}:${randomUUID()}`;
        const changedServer = matching && JSON.stringify(matching.imap) !== JSON.stringify(item.imap);
        return { account: { id, name: item.name, address: item.address, imap: item.imap, smtp: item.smtp, credentialRef, createdAt: matching?.createdAt ?? stamp(), updatedAt: stamp(), lastSyncAt: changedServer ? null : matching?.lastSyncAt ?? null, uidValidity: changedServer ? null : matching?.uidValidity ?? null, status: 'configured', error: '' }, credentials: { accountId: id, ...item.credentials }, previousRef: matching?.credentialRef };
      });
      if (existing.length + prepared.filter(value => !existing.some(account => account.id === value.account.id)).length > 30) throw Error('最多保存 30 个邮箱账号。');
      importing = true;
      let finishImport;
      importOperation = new Promise(resolve => { finishImport = resolve; });
      try {
        for (const item of prepared) { await secretStore.set(item.account.credentialRef, JSON.stringify(item.credentials)); savedSecrets.push(item.account.credentialRef); }
        store.saveMailAccounts(prepared.map(item => item.account));
      } catch {
        for (const reference of savedSecrets) await secretStore.delete(reference).catch(() => {});
        throw Error('邮箱配置保存失败，原账号配置保留。请检查系统凭据保护和数据目录。');
      } finally { importing = false; finishImport(); }
      for (const item of prepared) if (item.previousRef) await secretStore.delete(item.previousRef).catch(() => {});
      notify(); return { imported: prepared.length, accounts: prepared.map(item => publicAccount(item.account, false)) };
    },

    sync({ accountId, limit = 50 } = {}) {
      usable(); const account = accountById(accountId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error('每次收信数量须为 1 至 100。');
      return track(`sync:${account.id}`, async () => {
        const secret = await credentials(account), auth = runtimeAuth(account, secret, 'imap');
        if (closing) throw Error('邮件插件正在关闭。');
        const options = { ...account.imap, auth, logger: false, disableAutoIdle: true, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 30000, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, ...(account.imap.secure ? {} : { doSTARTTLS: true }) };
        delete options.username; delete options.mailbox;
        const client = imapFactory(options); clients.add(client); client.on?.('error', () => {});
        let lock;
        try {
          const result = await bounded((async () => {
            await client.connect();
            if (closing || cancelled.has(client)) throw Error('MAIL_CLOSED');
            lock = await client.getMailboxLock(account.imap.mailbox, { readOnly: true });
            const exists = Number(client.mailbox?.exists ?? 0), uidValidity = String(client.mailbox?.uidValidity ?? '');
            if (!Number.isSafeInteger(exists) || exists < 0 || !/^\d+$/.test(uidValidity)) throw Error('MAIL_INVALID_MAILBOX');
            const rows = [];
            if (exists) for await (const row of client.fetch(`${Math.max(1, exists - limit + 1)}:${exists}`, { uid: true, size: true, flags: true, envelope: true, internalDate: true })) {
              if (rows.length >= limit) throw Error('MAIL_INVALID_BATCH');
              rows.push(row);
            }
            const messages = []; let sourceBytes = 0;
            for (const row of rows) {
              if (closing || cancelled.has(client)) throw Error('MAIL_CLOSED');
              if (!Number.isSafeInteger(row.uid) || row.uid < 1 || !Number.isSafeInteger(row.size) || row.size < 0) throw Error('MAIL_INVALID_MESSAGE');
              const id = 'mail_' + identity([account.id, account.imap.host, account.imap.username, account.imap.mailbox, uidValidity, row.uid]);
              const envelope = row.envelope ?? {};
              const message = { id, accountId: account.id, uid: row.uid, uidValidity, mailbox: account.imap.mailbox, subject: String(envelope.subject ?? '（无主题）').slice(0, 1000), from: addressValues({ value: envelope.from }), replyTo: replyAddresses({ value: envelope.replyTo }), to: addressValues({ value: envelope.to }), cc: addressValues({ value: envelope.cc }), date: Number.isFinite(new Date(envelope.date ?? row.internalDate).getTime()) ? new Date(envelope.date ?? row.internalDate).toISOString() : null, messageId: String(envelope.messageId ?? '').slice(0, 998), unread: !row.flags?.has?.('\\Seen'), size: row.size, text: '', attachments: [], receivedAt: stamp(), bodyStatus: 'omitted-size-limit', remoteContentLoaded: false };
              if (row.size <= MAX_SOURCE && sourceBytes + row.size <= MAX_SYNC_SOURCE) {
                const fetched = await client.fetchOne(String(row.uid), { source: { start: 0, maxLength: MAX_SOURCE + 1 } }, { uid: true });
                if (!fetched || !Buffer.isBuffer(fetched.source)) { message.bodyStatus = 'unavailable'; messages.push(message); continue; }
                sourceBytes += fetched.source.length;
                if (fetched.source.length <= MAX_SOURCE && sourceBytes <= MAX_SYNC_SOURCE) {
                  const parsed = await simpleParser(fetched.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 256 * 1024 });
                  if (closing || cancelled.has(client)) throw Error('MAIL_CLOSED');
                  message.subject = String(parsed.subject ?? message.subject).slice(0, 1000);
                  message.from = addressValues(parsed.from); message.to = addressValues(Array.isArray(parsed.to) ? { value: parsed.to.flatMap(item => item.value) } : parsed.to);
                  message.cc = addressValues(Array.isArray(parsed.cc) ? { value: parsed.cc.flatMap(item => item.value) } : parsed.cc);
                  message.replyTo = replyAddresses(parsed.replyTo);
                  message.text = String(parsed.text ?? '').replace(/\0/g, '').slice(0, 64000);
                  message.messageId = String(parsed.messageId ?? message.messageId).slice(0, 998);
                  message.bodyStatus = parsed.textConversionError ? 'unavailable' : message.text.length >= 64000 ? 'truncated' : 'available';
                  message.omittedAttachmentCount = Math.max(0, (parsed.attachments?.length ?? 0) - 20);
                  message.attachments = (parsed.attachments ?? []).slice(0, 20).map((item, index) => item.content.length <= MAX_ATTACHMENT ? archiveAttachment(root, id, item, index) : { id: 'mailattachment_' + identity([id, index, 'omitted']), name: cleanName(item.filename), size: item.content.length, contentType: String(item.contentType ?? '').slice(0, 120), quarantine: true, unavailable: true, reason: 'size-limit' });
                }
              }
              messages.push(message);
            }
            if (closing || cancelled.has(client)) throw Error('MAIL_CLOSED');
            const updated = { ...account, lastSyncAt: stamp(), uidValidity, status: 'ready', error: '' };
            store.commitMailSync(updated, messages);
            return { accountId: account.id, received: messages.length, pagination: 'latest-only', limit, readOnly: true, messages };
          })(), client);
          notify(); return result;
        } catch (error) {
          const detail = readError(error);
          if (!closing) store.saveMailAccount({ ...account, status: 'error', error: detail });
          notify(); throw Error(detail);
        } finally {
          try { lock?.release(); } catch {}
          try { client.close?.(); } catch {}
          clients.delete(client);
        }
      });
    },

    getMessage({ messageId } = {}) { return clone(messageById(messageId)); },

    createDraft(input) {
      usable(); object(input, '邮件草稿'); const account = accountById(input.accountId);
      const to = addresses(input.to, '收件人', { required: true }), cc = addresses(input.cc ?? [], '抄送人'), bcc = addresses(input.bcc ?? [], '密送人');
      if (to.length + cc.length + bcc.length > 50) throw Error('每封邮件最多 50 个收件人。');
      const subject = plain(input.subject ?? '', '邮件主题', 998, { empty: true }), text = boundedText(input.text, '邮件正文', 128000);
      let inReplyTo = '';
      if (input.inReplyTo) { const source = messageById(input.inReplyTo); if (source.accountId !== account.id) throw Error('只能从原收信邮箱回复邮件。'); inReplyTo = /^<[^\s<>@]+@[^\s<>@]+>$/.test(source.messageId) ? source.messageId : ''; }
      const draft = { id: 'maildraft_' + randomUUID(), accountId: account.id, from: account.address, to, cc, bcc, subject, text, inReplyTo, status: 'draft', createdAt: stamp() };
      return store.saveMailDraft(draft);
    },

    sendDraft({ draftId } = {}) {
      usable(); const initial = draftById(draftId), account = accountById(initial.accountId);
      if (initial.status !== 'draft') return Promise.resolve(clone(initial));
      if (!account.smtp) throw Error('这个账号未配置 SMTP 发信服务器。');
      return track(`send:${account.id}:${initial.id}`, async () => {
        const fresh = draftById(initial.id);
        if (fresh.status !== 'draft') return fresh;
        const secret = await credentials(account), auth = runtimeAuth(account, secret, 'smtp');
        if (closing) throw Error('邮件插件正在关闭。');
        const client = smtpFactory({ ...account.smtp, auth, pool: false, logger: false, debug: false, requireTLS: !account.smtp.secure, connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 30000, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, disableFileAccess: true, disableUrlAccess: true });
        clients.add(client);
        const messageId = `<${fresh.id}@assistant.local>`, recipients = [...new Set([...fresh.to, ...fresh.cc, ...fresh.bcc])];
        try {
          // Persist the attempt before any SMTP I/O. A repeated click can never
          // start a second attempt, including after an uncertain connection loss.
          store.updateMailDraft(fresh.id, { status: 'sending', receipt: { kind: 'smtp-attempt', messageId, attemptedAt: stamp() } });
          notify();
          const result = await bounded(client.sendMail({ from: { name: account.name, address: account.address }, to: fresh.to, cc: fresh.cc, bcc: fresh.bcc, subject: fresh.subject, text: fresh.text, messageId, ...(fresh.inReplyTo ? { inReplyTo: fresh.inReplyTo, references: [fresh.inReplyTo] } : {}), envelope: { from: account.address, to: recipients }, disableFileAccess: true, disableUrlAccess: true }), client);
          const accepted = (result?.accepted ?? []).map(item => typeof item === 'string' ? item : item?.address).filter(item => recipients.includes(item));
          const rejected = (result?.rejected ?? []).map(item => typeof item === 'string' ? item : item?.address).filter(item => recipients.includes(item));
          if (!accepted.length || !/^250(?:[ -]|$)/.test(String(result?.response ?? ''))) throw Error('MAIL_SMTP_UNCONFIRMED');
          const receipt = { kind: 'smtp-server-accepted', messageId, accepted, rejected, responseCode: 250, acceptedAt: stamp(), delivery: 'server-accepted' };
          return store.updateMailDraft(fresh.id, { status: 'smtp-accepted', receipt, error: rejected.length ? '部分收件人被服务器拒绝，请查看回执；不会自动重发。' : '' });
        } catch {
          // A transport error cannot prove the server did not accept DATA.
          return store.updateMailDraft(fresh.id, { status: 'unconfirmed', error: '无法确认 SMTP 服务器是否接收这封邮件。请在邮箱中核对，程序不会自动重发。', receipt: { kind: 'smtp-unconfirmed', messageId, attemptedAt: stamp(), delivery: 'unknown' } });
        } finally { try { client.close?.(); } catch {} clients.delete(client); notify(); }
      });
    },

    resolveAttachment({ messageId, attachmentId } = {}) {
      const message = messageById(messageId), id = safeId(attachmentId), item = message.attachments.find(attachment => attachment.id === id);
      if (!item || item.unavailable) throw Error('这封邮件没有可读取的这个附件。');
      const directory = ensureDirectory(root, ['mail', 'quarantine', message.id]), filename = path.join(directory, id + '.bin');
      const resolved = fs.realpathSync(filename), info = fs.lstatSync(filename);
      if (resolved !== filename || !info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size !== item.size || info.size > MAX_ATTACHMENT) throw Error('隔离附件路径或大小发生变化，未读取。');
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { const content = fs.readFileSync(fd); if (hash(content) !== item.sha256) throw Error('隔离附件校验失败，未读取。'); return { path: filename, name: item.name, sha256: item.sha256, size: item.size, contentType: item.contentType, quarantine: true }; }
      finally { fs.closeSync(fd); }
    },

    close() {
      if (closeOperation) return closeOperation;
      closing = true; for (const client of clients) { cancelled.add(client); try { client.close?.(); } catch {} }
      closeOperation = Promise.allSettled([...active.values(), ...(importOperation ? [importOperation] : [])]).then(() => {}); return closeOperation;
    }
  };
  return api;
}
