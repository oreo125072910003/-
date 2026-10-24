import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ExtensionError extends Error {
  constructor(code, message, details) { super(message); this.name = 'ExtensionError'; this.code = code; if (details) this.details = details; }
}
export function fail(code, message) { throw new ExtensionError(code, message); }
export function object(value, label = '配置') { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label}必须是对象。`); return value; }
export function text(value, label, max = 2048, empty = false) { if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) fail('INVALID_INPUT', `${label}无效。`); return value.trim(); }
export function extensionId(value) { const id = text(value, '扩展编号', 64); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail('INVALID_ID', '扩展编号应使用小写字母、数字和连字符。'); return id; }
export function boundedJson(value, max = 1024 * 1024) { const json = JSON.stringify(value); if (!json || Buffer.byteLength(json) > max) fail('MESSAGE_TOO_LARGE', '扩展消息超过大小限制。'); return json; }
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function fileDigest(filename) { return digest(fs.readFileSync(filename)); }
export function within(root, filename) { const relative = path.relative(path.resolve(root), path.resolve(filename)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
export function plainFile(filename, limit = 1024 * 1024) {
  const absolute = path.resolve(filename); const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('INVALID_FILE', '文件类型或大小不符合导入要求。');
  return absolute;
}
export function atomicJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true }); const temporary = `${filename}.${randomUUID()}.tmp`;
  try { const handle = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(handle); } finally { fs.closeSync(handle); } fs.renameSync(temporary, filename); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function safeError(error) { return { code: error?.code ?? 'EXTENSION_FAILED', message: error instanceof ExtensionError ? error.message : '扩展执行失败，请检查连接配置。' }; }
