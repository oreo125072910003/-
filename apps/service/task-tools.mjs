import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DOMParser } from '@xmldom/xmldom';
import { Resvg } from '@resvg/resvg-js';
import { extractDocument, writeOfficeDocument } from '../../packages/documents/index.mjs';
import { productTool } from '../../packages/contracts/product-tools.mjs';

const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const text = (value, maximum = 1000) => { if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw Error('输入内容无效或超过长度限制。'); return value; };
const name = value => { text(value, 100); if (/[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(value)) throw Error('文件名称无效。'); return value; };
const same = (a, b) => { const aa = Buffer.from(a || ''), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const publicArtifact = item => ({ id: item.id, name: item.name, size: item.size, type: item.type, sha256: item.sha256 });
const TEXT = /\.(?:txt|md|csv|tsv|json|tex|bib|yaml|yml)$/i;
const exportedMime = (filename, bytes) => {
  if (/\.png$/i.test(filename) && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (/\.jpe?g$/i.test(filename) && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if (/\.gif$/i.test(filename) && /^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (/\.webp$/i.test(filename) && bytes.subarray(0,4).toString('ascii')==='RIFF' && bytes.subarray(8,12).toString('ascii')==='WEBP') return 'image/webp';
  return 'application/octet-stream';
};

export function renderProductDrawing(svg) {
  text(svg, 200000);
  if (/<!|<\?|\b(?:href|src|on[a-z]+)\s*=|@import|url\(\s*[^#]/i.test(svg)) throw Error('绘图包含外部资源或活动内容，请只使用独立矢量图形。');
  const allowed = new Set(['svg','g','defs','linearGradient','radialGradient','stop','clipPath','mask','title','desc','rect','circle','ellipse','line','polyline','polygon','path','text','tspan']);
  let malformed = false;
  const document = new DOMParser({ onError: () => { malformed = true; } }).parseFromString(svg, 'image/svg+xml');
  if (malformed || document.documentElement?.tagName !== 'svg') throw Error('SVG 图形格式无效。');
  let count = 0;
  function visit(node) {
    if (++count > 12000) throw Error('图形过于复杂，请减少元素。');
    if (node.nodeType === 1) {
      if (!allowed.has(node.tagName)) throw Error('图形包含不支持的元素：' + node.tagName);
      for (const attribute of Array.from(node.attributes)) if (/^(?:on|href|src)/i.test(attribute.name) || /(?:file:|https?:|data:|javascript:)/i.test(attribute.value) && attribute.name !== 'xmlns') throw Error('图形不能引用外部资源。');
    }
    for (const child of Array.from(node.childNodes || [])) visit(child);
  }
  visit(document.documentElement);
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: 1280 }, font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' } });
  if (rendered.width < 1 || rendered.height < 1 || rendered.height > 4096) throw Error('图形尺寸无效，请设置合理的宽高或 viewBox。');
  const png = Buffer.from(rendered.render().asPng());
  if (!png.length || png.length > 8 * 1024 * 1024) throw Error('绘图结果超过图片大小限制。');
  return png;
}

export function runProductCommand(command, { cwd, signal, timeoutMs = 30000 } = {}) {
  text(command, 12000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw Error('命令时限无效。');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const executable = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : '/bin/sh';
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n" + command;
    const child = spawn(executable, windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-c', command], { cwd, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    const chunks = []; let size = 0, truncated = false, reason, settled = false, exited = false, drainTimer, stopTimer, outputDetached = false;
    const cleanup = () => { clearTimeout(timer); clearTimeout(drainTimer); clearTimeout(stopTimer); signal?.removeEventListener('abort', abort); };
    const finish = (error, code = child.exitCode) => {
      if (settled) return;
      settled = true; cleanup();
      child.stdout.destroy(); child.stderr.destroy();
      if (error) { reject(error); return; }
      if (reason === 'cancelled') { reject(Error('电脑任务已取消。')); return; }
      resolve({ exitCode: code, output: Buffer.concat(chunks).toString('utf8'), truncated, ...(reason ? { stopped: reason } : {}), ...(outputDetached ? { outputDetached: true } : {}) });
    };
    const terminate = why => {
      if (settled || reason) return;
      reason = why;
      // A GUI child can retain inherited output pipes after PowerShell exits.
      // Never target that exited shell's PID again; it may already be reused.
      if (exited || child.exitCode !== null || child.signalCode !== null) { outputDetached = true; finish(); return; }
      const fallback = () => { if (!settled && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
      if (windows && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', fallback); killer.once('exit', code => { if (code !== 0) fallback(); });
      } else fallback();
      stopTimer = setTimeout(() => {
        if (exited || child.exitCode !== null || child.signalCode !== null) { outputDetached = true; finish(); }
        else finish(Object.assign(Error('已请求停止电脑命令，但尚未确认进程退出。'), { code: 'LOCAL_COMMAND_STOP_UNCONFIRMED', stopUnconfirmed: true }));
      }, 2500);
    };
    const read = chunk => { const remaining = 65536 - size; if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); size += Math.min(remaining, chunk.length); } if (chunk.length > remaining) { truncated = true; terminate('output-limit'); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    const abort = () => terminate('cancelled'), timer = setTimeout(() => terminate('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => finish(error));
    child.once('exit', code => {
      exited = true; clearTimeout(timer); clearTimeout(stopTimer);
      // Drain trailing output briefly, without waiting for launched desktop
      // programs to close their inherited handles before admitting another task.
      drainTimer = setTimeout(() => { outputDetached = true; finish(undefined, code); }, 250);
    });
    child.once('close', code => finish(undefined, code));
  });
}

export async function captureProductScreenshot(destination, options = {}) {
  if (process.platform !== 'win32') throw Error('桌面截图目前需要 Windows。');
  const literal = "'" + destination.replaceAll("'", "''") + "'";
  const result = await runProductCommand(`Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$shotBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen\n$shotBitmap = [System.Drawing.Bitmap]::new($shotBounds.Width, $shotBounds.Height)\n$shotGraphics = [System.Drawing.Graphics]::FromImage($shotBitmap)\ntry { $shotGraphics.CopyFromScreen($shotBounds.Left, $shotBounds.Top, 0, 0, $shotBounds.Size); $shotBitmap.Save(${literal}, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $shotGraphics.Dispose(); $shotBitmap.Dispose() }`, { ...options, timeoutMs: 15000 });
  if (result.exitCode !== 0 || !fs.existsSync(destination) || !fs.statSync(destination).size) throw Error('桌面截图未成功，请检查桌面是否处于可读取状态。');
}

/** One capability per live product task. No authority or address is taken from
 * model arguments; every operation rechecks the current product-side grant. */
export async function createTaskToolAccess({ task, tools, signal, authorize, addArtifact, resolveArtifact, onDelivery, mail, wechat, conversation, screenshot = captureProductScreenshot, runCommand = runProductCommand } = {}) {
  const selected = new Set(tools.filter(name => productTool(name)));
  if (!selected.size) return { connection: undefined, async close() {} };
  const token = randomBytes(32).toString('base64url'), requests = new Map(), operations = new Set();
  const lifetime = new AbortController(), bounded = AbortSignal.any([signal, lifetime.signal]);
  let closed = false, calls = 0;
  const workspace = fs.realpathSync(task.workspace);
  const output = path.join(workspace, '成果'); fs.mkdirSync(output, { recursive: true });
  const outputRoot = fs.realpathSync(output);
  if (!inside(workspace, outputRoot) || fs.lstatSync(output).isSymbolicLink()) throw Error('成果目录无效。');
  const check = async toolName => { bounded.throwIfAborted(); if (closed || !selected.has(toolName) || !await authorize(toolName)) throw Error('本轮功能权限已撤销或会话已变化。'); };
  const file = (value, local = false) => {
    text(value);
    const absolute = path.resolve(workspace, value), info = fs.lstatSync(absolute), real = fs.realpathSync(absolute);
    if (info.isSymbolicLink() || !local && !inside(workspace, real)) throw Error('文件不在本轮已授权资料中。');
    return { absolute: real, info };
  };
  const destination = filename => {
    if (fs.realpathSync(output) !== outputRoot || fs.lstatSync(output).isSymbolicLink()) throw Error('成果目录已变化。');
    return path.join(output, randomUUID().slice(0, 8) + '_' + name(filename));
  };
  const register = (filename, mime) => publicArtifact(addArtifact(filename, path.basename(filename), mime));
  async function execute(toolName, args) {
    await check(toolName);
    const schema = productTool(toolName).parameters;
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || schema.required?.some(key => !Object.hasOwn(args, key))) throw Error('功能参数无效。');
    switch (toolName) {
      case 'xiaozhushou_document': {
        const written = await writeOfficeDocument({ workspace: output, title: args.title, blocks: args.blocks, formats: args.formats ?? ['docx'], signal: bounded });
        await check(toolName);
        return { artifacts: written.artifacts.map(item => register(item.path, item.mime)), diagnostics: written.diagnostics };
      }
      case 'xiaozhushou_save_text': {
        const filename = destination(args.name); if (!TEXT.test(filename)) throw Error('请使用 txt、md、csv、json、tex、bib 等文字文件格式。');
        const bytes = Buffer.from(text(args.text, 200000)); fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
        return { artifact: register(filename, 'text/plain') };
      }
      case 'xiaozhushou_draw': {
        const png = renderProductDrawing(args.svg), filename = destination(name(args.title) + '.png');
        await check(toolName); fs.writeFileSync(filename, png, { flag: 'wx', mode: 0o600 });
        return { artifact: register(filename, 'image/png'), method: 'DSH 原创矢量绘图，已渲染 PNG' };
      }
      case 'xiaozhushou_attachment': {
        if (!['image','file'].includes(args.mediaType)) throw Error('请选择图片或文件交付方式。');
        const item = resolveArtifact(text(args.artifactId, 100));
        if (item.taskId !== task.id || !inside(workspace, fs.realpathSync(item.path)) || digest(fs.readFileSync(item.path)) !== item.sha256) throw Error('只能交付本轮真实生成并校验的成果。');
        if (args.mediaType === 'image' && !/^image\/(?:png|jpeg|gif|webp)$/.test(item.type)) throw Error('此成果不是可发送的图片。');
        await onDelivery({ kind: 'artifact', artifactId: item.id, mediaType: args.mediaType });
        return { queued: true, artifact: publicArtifact(item), delivery: conversation ? '本轮成功后发送到原微信会话' : '已保存在本轮成果，供主人打开或发送' };
      }
      case 'xiaozhushou_read_document': case 'xiaozhushou_read_local_file': {
        const local = toolName === 'xiaozhushou_read_local_file', current = file(args.path, local);
        const result = await extractDocument({ path: current.absolute, allowedRoot: local ? path.dirname(current.absolute) : workspace, maxChars: 40000, signal: bounded });
        await check(toolName); return result;
      }
      case 'xiaozhushou_list_local_dir': {
        const current = file(args.path, true); if (!current.info.isDirectory()) throw Error('此路径不是目录。');
        const entries = fs.readdirSync(current.absolute, { withFileTypes: true });
        return { entries: entries.slice(0, 200).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file' })), truncated: entries.length > 200 };
      }
      case 'xiaozhushou_write_local_file': {
        text(args.path); if (!path.isAbsolute(args.path) || !TEXT.test(args.path)) throw Error('请提供本地文字文件的完整路径。');
        const parent = fs.realpathSync(path.dirname(args.path)), filename = path.join(parent, name(path.basename(args.path)));
        fs.writeFileSync(filename, text(args.text, 200000), { flag: 'wx', mode: 0o600 }); return { path: filename, created: true };
      }
      case 'xiaozhushou_run_local_shell': return runCommand(args.command, { cwd: workspace, signal: bounded, timeoutMs: args.timeoutMs ?? 30000 });
      case 'xiaozhushou_screenshot': {
        const filename = destination('电脑截图.png'); await screenshot(filename, { cwd: workspace, signal: bounded }); await check(toolName);
        return { artifact: register(filename, 'image/png') };
      }
      case 'xiaozhushou_export_file': {
        const current = file(args.path, true);
        if (!current.info.isFile() || current.info.size < 1 || current.info.size > 50 * 1024 * 1024) throw Error('仅支持不超过 50 MiB 的普通文件。');
        const descriptor = fs.openSync(current.absolute, 'r'); let bytes;
        try { const before = fs.fstatSync(descriptor); bytes = fs.readFileSync(descriptor); const after = fs.fstatSync(descriptor); if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('文件在复制时发生变化。'); } finally { fs.closeSync(descriptor); }
        const filename = destination(path.basename(current.absolute)); fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); return { artifact: register(filename, exportedMime(filename,bytes)) };
      }
      case 'xiaozhushou_sticker': {
        if (!conversation) throw Error('此功能需要来自微信原会话的任务。');
        const list = await wechat.getStickers({ kind: conversation.kind, target: conversation.target }); await check(toolName);
        if (args.action === 'list') return list;
        if (args.action !== 'select' || !/^[a-f0-9]{64}$/.test(args.id || '') || !list.stickers?.some(item => item.id === args.id)) throw Error('请选择本次列表中实际存在的表情。');
        await onDelivery({ kind: 'sticker', stickerId: args.id }); return { queued: true, delivery: '本轮成功后发送到原会话' };
      }
      case 'xiaozhushou_mail': {
        const state = mail.getState();
        if (args.action === 'accounts') return { accounts: state.accounts.map(({ id, name, address, status, error }) => ({ id, name, address, status, error })) };
        if (!state.accounts.length) throw Error('尚未连接邮箱，请在“邮箱通信 → 我的邮箱”添加账号。');
        if (args.action === 'inbox') return { messages: state.messages.filter(item => !args.accountId || item.accountId === args.accountId).slice(0, 50) };
        if (args.action === 'read') return mail.getMessage({ messageId: args.messageId });
        if (args.action === 'draft') return { draft: mail.createDraft({ accountId: args.accountId, to: args.to, subject: args.subject, text: args.text }), sent: false };
        throw Error('邮件操作无效。');
      }
      default: throw Error('此功能未接通。');
    }
  }
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => { if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value)); };
    try {
      if (closed || request.headers.host !== `127.0.0.1:${server.address()?.port}` || request.headers.origin || request.headers['sec-fetch-site'] || !same(request.headers.authorization, 'Bearer ' + token) || request.url !== '/tools' || request.method !== 'POST') { request.resume(); reply(403, { content: '本轮功能连接无效。', isError: true }); return; }
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 600 * 1024) throw Error('功能输入超过限制。'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString('utf8'));
      if (!body || Object.keys(body).sort().join(',') !== 'args,id,name' || !/^[a-f0-9-]{36}$/.test(body.id || '')) throw Error('功能请求格式无效。');
      await check(body.name);
      const fingerprint = digest(bytes), previous = requests.get(body.id);
      if (previous && previous.digest !== fingerprint) throw Error('此调用编号已用于其他请求。');
      if (!previous && ++calls > 32) throw Error('本轮功能调用次数已达到上限。');
      const operation = previous?.operation ?? execute(body.name, body.args).then(result => ({ content: JSON.stringify(result), isError: false }), error => ({ content: String(error.message || '功能执行失败。').slice(0, 1000), isError: true }));
      requests.set(body.id, { digest: fingerprint, operation }); operations.add(operation);
      try { const result = await operation; await check(body.name); reply(200, result); } finally { operations.delete(operation); }
    } catch (error) { reply(400, { content: String(error.message || '功能执行失败。').slice(0, 1000), isError: true }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { connection: { endpoint: `http://127.0.0.1:${server.address().port}/tools`, token }, async close() { if (closed) return; closed = true; lifetime.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...operations]); } };
}
