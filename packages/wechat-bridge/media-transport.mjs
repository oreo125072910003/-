import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const fault = (code, attempted = false) => Object.assign(Error(code), { code, attempted });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
// External PowerShell cannot read an Electron ASAR archive. The packager unpacks
// this fixed product script; source runs retain their ordinary filesystem path.
const scriptPath = fileURLToPath(new URL('./send-attachment-ui.ps1', import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const INPUT_PREFLIGHT_CODES = new Set(['WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE', 'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT']);
let globalMediaBusy = false;

// Only the fixed sender's explicit pre-paste report can revoke a submission
// reservation. Missing, ambiguous or post-paste evidence remains uncertain.
export function wechatAttachmentUiError(event, granted) {
  const code = typeof event?.code === 'string' && /^WECHAT_[A-Z0-9_]{1,70}$/.test(event.code) ? event.code : 'WECHAT_ATTACHMENT_UI_FAILED';
  const provenPreSubmit = event?.submitted === false && INPUT_PREFLIGHT_CODES.has(code);
  return fault(code, granted && !provenPreSubmit);
}

export function inspectWechatAttachment(value) {
  if (!value || !['private', 'group'].includes(value.kind) || !/^[1-9]\d{0,15}$/.test(value.target ?? '') ||
      !Number.isSafeInteger(Number(value.target)) || !/^[a-f0-9]{64}$/.test(value.deliveryId ?? '') ||
      !['image', 'file'].includes(value.mediaType) || typeof value.path !== 'string' || !path.isAbsolute(value.path) ||
      typeof value.name !== 'string' || !value.name || value.name.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(value.name) ||
      typeof value.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(value.mime) ||
      !/^[a-f0-9]{64}$/.test(value.sha256 ?? '') || !Number.isSafeInteger(value.size) || value.size < 1 ||
      value.size > (value.mediaType === 'image' ? 8 : 50) * 1024 * 1024 || value.mediaType === 'image' && !IMAGE_MIMES.has(value.mime)) {
    throw fault('WECHAT_ATTACHMENT_ARGUMENT_INVALID');
  }
  try {
    const actual = path.resolve(value.path), stat = fs.lstatSync(actual);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(actual) !== actual || stat.size !== value.size || path.basename(actual) !== value.name) {
      throw fault('WECHAT_ATTACHMENT_INTEGRITY_FAILED');
    }
    const descriptor = fs.openSync(actual, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== value.size || opened.ino !== stat.ino || opened.dev !== stat.dev) throw fault('WECHAT_ATTACHMENT_INTEGRITY_FAILED');
      const bytes = fs.readFileSync(descriptor);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== value.size || sha256 !== value.sha256) throw fault('WECHAT_ATTACHMENT_INTEGRITY_FAILED');
      return { ...value, path: actual, md5: crypto.createHash('md5').update(bytes).digest('hex') };
    } finally { fs.closeSync(descriptor); }
  } catch { throw fault('WECHAT_ATTACHMENT_INTEGRITY_FAILED'); }
}

function decodeXml(value) {
  return value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[key]);
}
function tag(xml, name, container = false) {
  const matches = [...xml.matchAll(new RegExp('<' + name + '(?:\\s[^<>]*)?>([\\s\\S]*?)</' + name + '\\s*>', 'gi'))];
  return matches.length === 1 ? container ? matches[0][1].trim() : decodeXml(matches[0][1].trim()) : null;
}
function attribute(xml, name) {
  const matches = [...xml.matchAll(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(["\\\'])([^"\\\']*)\\1', 'gi'))];
  return matches.length === 1 ? decodeXml(matches[0][2]) : null;
}
const rowId = row => String(row?.localId ?? '');
const validRowId = row => /^[1-9]\d{0,31}$/.test(rowId(row));

/** Exact content proof only. A type or a new timestamp by itself is insufficient. */
export function matchesWechatAttachmentReceipt(row, attachment, attempt) {
  if (!row || !validRowId(row) || !(row.isSend === true || row.isSend === 1) || attempt.baseline.includes(rowId(row)) ||
      !Number.isSafeInteger(Number(row.createTime)) || Number(row.createTime) < Math.floor(attempt.startedAt / 1000) ||
      !/^\d{1,32}$/.test(String(row.serverId ?? '')) || BigInt(row.serverId) <= 0n ||
      row.senderUsername && row.senderUsername !== attempt.selfWxid) return false;
  const xml = row.fullText;
  if (typeof xml !== 'string' || xml.length > 128000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return false;
  const base = Number(row.localType) % 2 ** 32;
  if (attachment.mediaType === 'image') {
    if (base !== 3) return false;
    const imageTags = [...xml.matchAll(/<img\b([^<>]*)\/?\s*>/gi)];
    if (imageTags.length !== 1) return false;
    const md5 = attribute(imageTags[0][1], 'md5');
    return /^[a-f0-9]{32}$/i.test(md5 ?? '') && md5.toLowerCase() === attachment.md5;
  }
  if (base !== 49) return false;
  const app = tag(xml, 'appmsg', true), attachmentXml = app && tag(app, 'appattach', true);
  if (!app || !attachmentXml || tag(app, 'type') !== '6' || tag(app, 'title') !== attachment.name || tag(attachmentXml, 'totallen') !== String(attachment.size)) return false;
  const candidates = [tag(attachmentXml, 'filemd5'), tag(attachmentXml, 'md5'), tag(app, 'filemd5')].filter(value => value !== null);
  return candidates.length > 0 && candidates.every(value => /^[a-f0-9]{32}$/i.test(value) && value.toLowerCase() === attachment.md5);
}

/** One child process, no server. Only the fixed script receives structured JSON.
 * beforeSubmit is the one-use account/permission/lifecycle grant immediately
 * before the first paste. No code path retries paste or the send button.
 */
export async function runWechatAttachmentUi(request, { signal, beforeSubmit } = {}) {
  if (process.platform !== 'win32') throw fault('WECHAT_ATTACHMENT_UI_UNAVAILABLE');
  if (typeof beforeSubmit !== 'function') throw fault('WECHAT_ATTACHMENT_UI_GUARD_REQUIRED');
  if (signal?.aborted) throw fault('WECHAT_NOT_READY');
  return new Promise((resolve, reject) => {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', result = null, settled = false, granted = false, grantPending = null, bytes = 0, exited = false, pendingError = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      if (error && !exited) { pendingError = error; child.kill(); return; }
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', granted));
    const timer = setTimeout(() => finish(fault('WECHAT_ATTACHMENT_UI_TIMEOUT', granted)), 60000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(fault('WECHAT_ATTACHMENT_UI_UNAVAILABLE', granted)));
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) finish(fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', granted)); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32768) return finish(fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', granted));
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { finish(fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', granted)); return; }
        if (event.type === 'ready') {
          if (grantPending || granted) return finish(fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', granted));
          grantPending = Promise.resolve().then(beforeSubmit).then(() => {
            if (settled || signal?.aborted) return;
            granted = true; child.stdin.write(JSON.stringify({ type: 'submit', deliveryId: request.deliveryId }) + '\n');
          }).catch(error => finish(error));
        } else if (event.type === 'result' && event.submitted === true && granted) result = { submitted: true, targetChecked: true, windowChecked: true };
        else if (event.type === 'error') finish(wechatAttachmentUiError(event, granted));
        else return finish(fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', granted));
      }
    });
    child.on('close', code => {
      exited = true;
      if (pendingError) { reject(pendingError); return; }
      if (!settled) finish(code === 0 && result ? null : fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', granted), result);
    });
    if (signal?.aborted) abort();
    else child.stdin.write(JSON.stringify(request) + '\n');
  });
}

export function createWechatMediaTransport({ dataDir, signal, assertReady, verify, resolveTarget, readMessages,
  nativeRunner = runWechatAttachmentUi, receiptTimeoutMs = 18000, pollMs = 400 } = {}) {
  if (!path.isAbsolute(dataDir ?? '') || ![assertReady, verify, resolveTarget, readMessages, nativeRunner].every(value => typeof value === 'function')) throw fault('WECHAT_ATTACHMENT_INTERFACE_INVALID');
  const directory = path.join(dataDir, 'state', 'media-deliveries');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw fault('WECHAT_ATTACHMENT_STATE_INVALID');
  const save = (filename, value) => {
    const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  return {
    async send(value) {
      assertReady(value?.kind, value?.target);
      const taskSignal=value?.signal?AbortSignal.any([signal,value.signal].filter(Boolean)):signal;
      taskSignal?.throwIfAborted();
      await value?.beforeSubmit?.();
      const attachment = inspectWechatAttachment(value);
      if (globalMediaBusy) throw fault('SENDER_BUSY');
      globalMediaBusy = true;
      let attempt = null, filename = null;
      try {
        const identity = await verify(), target = await resolveTarget(attachment.kind, attachment.target);
        assertReady(attachment.kind, attachment.target);
        const key = hash([identity.account, attachment.deliveryId]); filename = path.join(directory, key + '.json');
        const fingerprint = hash([attachment.kind, attachment.target, attachment.name, attachment.sha256, attachment.size, attachment.mime, attachment.mediaType]);
        if (fs.existsSync(filename)) {
          if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > 64000) throw fault('WECHAT_ATTACHMENT_STATE_INVALID');
          try { attempt = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw fault('WECHAT_ATTACHMENT_STATE_INVALID'); }
          if (!attempt || attempt.version !== 1 || !['reserved', 'dispatching', 'confirmed', 'unconfirmed', 'rejected'].includes(attempt.state) ||
              !Array.isArray(attempt.baseline) || typeof attempt.attempted !== 'boolean' || !Number.isSafeInteger(attempt.startedAt)) throw fault('WECHAT_ATTACHMENT_STATE_INVALID');
          if (attempt.fingerprint !== fingerprint || attempt.wxid !== target.wxid || attempt.account !== identity.account) throw fault('WECHAT_ATTACHMENT_DELIVERY_CONFLICT');
          if (attempt.state === 'confirmed') return { ...attempt.response, reused: true };
          throw fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', attempt.attempted === true);
        }
        const rows = await readMessages(target.wxid);
        if (!Array.isArray(rows) || rows.length > 1000) throw fault('WECHAT_ATTACHMENT_RECEIPT_INVALID');
        attempt = { version: 1, fingerprint, account: identity.account, wxid: target.wxid, selfWxid: identity.selfWxid,
          deliveryId: attachment.deliveryId, state: 'reserved', attempted: false,
          baseline: rows.filter(validRowId).map(rowId), startedAt: Date.now() };
        // Durable reservation precedes any UI operation. Every repeated ID is
        // suppressed, including a crash or an ambiguous child process result.
        save(filename, attempt);
        let grantUsed = false;
        const beforeSubmit = async () => {
          if (grantUsed) throw fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', true);
          grantUsed = true;
          assertReady(attachment.kind, attachment.target);
          const checked = await verify(), mapped = await resolveTarget(attachment.kind, attachment.target);
          if (checked.account !== identity.account || checked.selfWxid !== identity.selfWxid || mapped.wxid !== target.wxid || mapped.name !== target.name) throw fault('WECHAT_ACCOUNT_CHANGED');
          assertReady(attachment.kind, attachment.target);
          inspectWechatAttachment(attachment);
          taskSignal?.throwIfAborted();
          await value?.beforeSubmit?.();
          taskSignal?.throwIfAborted();
          attempt.attempted = true; attempt.state = 'dispatching'; attempt.startedAt = Date.now(); save(filename, attempt);
        };
        let native;
        try {
          native = await nativeRunner(Object.freeze({ path: attachment.path, name: attachment.name, sha256: attachment.sha256,
            size: attachment.size, mime: attachment.mime, mediaType: attachment.mediaType, deliveryId: attachment.deliveryId,
            targetName: target.name, targetWxid: target.wxid, kind: attachment.kind, account: identity.account }), { signal:taskSignal, beforeSubmit });
        } catch (error) {
          if (error?.attempted === false && INPUT_PREFLIGHT_CODES.has(error?.code)) attempt.attempted = false;
          throw error;
        }
        if (!grantUsed || !attempt.attempted || native?.submitted !== true || native.targetChecked !== true || native.windowChecked !== true) throw fault('WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID', attempt.attempted);
        const deadline = Date.now() + receiptTimeoutMs;
        do {
          assertReady(attachment.kind, attachment.target);
          const checked = await verify();
          if (checked.account !== identity.account || checked.selfWxid !== identity.selfWxid) throw fault('WECHAT_ACCOUNT_CHANGED', true);
          const receipts = await readMessages(target.wxid);
          if (!Array.isArray(receipts) || receipts.length > 1000) throw fault('WECHAT_ATTACHMENT_RECEIPT_INVALID', true);
          const candidates = receipts.filter(row => matchesWechatAttachmentReceipt(row, attachment, attempt));
          // Two identical new media messages cannot be attributed to one click.
          if (candidates.length === 1) {
            const mapped = await resolveTarget(attachment.kind, attachment.target), finalIdentity = await verify();
            if (mapped.wxid !== target.wxid || finalIdentity.account !== identity.account || finalIdentity.selfWxid !== identity.selfWxid) throw fault('WECHAT_ACCOUNT_CHANGED', true);
            assertReady(attachment.kind, attachment.target);
            attempt.state = 'confirmed';
            attempt.response = { message_id: String(candidates[0].serverId), local_message_id: rowId(candidates[0]), receipt: 'wechat-server-id', delivered: 'database-confirmed',
              media_type: attachment.mediaType === 'image' ? 'wechat-image' : 'wechat-file', deliveryId: attachment.deliveryId };
            save(filename, attempt); return attempt.response;
          }
          if (candidates.length > 1) throw fault('WECHAT_ATTACHMENT_RECEIPT_AMBIGUOUS', true);
          await delay(pollMs, undefined, { signal:taskSignal });
        } while (Date.now() < deadline);
        throw fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED', true);
      } catch (error) {
        if (attempt && filename && attempt.state !== 'confirmed') {
          attempt.state = attempt.attempted ? 'unconfirmed' : 'rejected';
          try { save(filename, attempt); } catch { throw fault('WECHAT_ATTACHMENT_STATE_INVALID', attempt.attempted === true); }
        }
        const code = /^WECHAT_[A-Z0-9_]{1,70}$|^SENDER_BUSY$|^CONVERSATION_NOT_ALLOWED$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED';
        throw fault(code, attempt?.attempted === true);
      } finally { globalMediaBusy = false; }
    },
  };
}
