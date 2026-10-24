import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { fail, object, text, extensionId, boundedJson, digest, fileDigest, within, plainFile } from './common.mjs';

const MAX_FILES = 128, MAX_TOTAL = 8 * 1024 * 1024, MAX_FILE = 2 * 1024 * 1024;
const scriptExtensions = new Set(['.js', '.mjs', '.cjs', '.py', '.ps1', '.sh', '.bat', '.cmd', '.exe', '.dll']);
function strings(value, label) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 64) fail('INVALID_SKILL', `${label}必须是有界清单。`); return [...new Set(value.map(item => text(item, label, 128)))]; }
function scanDirectory(root) {
  const files = []; let bytes = 0;
  const walk = (directory, depth) => {
    if (depth > 8) fail('SKILL_TOO_LARGE', '技能目录层级过深。');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', 'node_modules', '__pycache__'].includes(entry.name)) fail('SKILL_UNSAFE_PATH', '技能不能包含版本库或安装依赖目录。');
      if (entry.name.includes(':') || entry.name.includes('\0')) fail('SKILL_UNSAFE_PATH', '技能文件名无效。');
      const filename = path.join(directory, entry.name), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || !within(root, fs.realpathSync(filename))) fail('SKILL_UNSAFE_PATH', '技能不能包含符号链接或目录外文件。');
      if (stat.isDirectory()) walk(filename, depth + 1);
      else {
        plainFile(filename, MAX_FILE); bytes += stat.size;
        if (bytes > MAX_TOTAL || files.length >= MAX_FILES) fail('SKILL_TOO_LARGE', '技能文件数或总大小超过限制。');
        files.push({ path: path.relative(root, filename).split(path.sep).join('/'), bytes: stat.size, sha256: fileDigest(filename), script: scriptExtensions.has(path.extname(filename).toLowerCase()) });
      }
    }
  }; walk(root, 0); return files;
}
function parseMetadata(source, directoryName) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) fail('INVALID_SKILL', 'SKILL.md 缺少 YAML 元数据。');
  const end = normalized.indexOf('\n---\n', 4); if (end < 0 || end > 64 * 1024) fail('INVALID_SKILL', 'SKILL.md 元数据未正确结束或过大。');
  let meta; try { const document = YAML.parseDocument(normalized.slice(4, end), { uniqueKeys: true, maxAliasCount: 0, schema: 'core' }); if (document.errors.length) fail('INVALID_SKILL', '技能 YAML 元数据无效。'); meta = document.toJS({ maxAliasCount: 0 }); } catch { fail('INVALID_SKILL', '技能 YAML 元数据无效，不能使用别名。'); }
  object(meta, '技能元数据'); const name = extensionId(meta.name); if (name.length > 64 || name !== directoryName) fail('INVALID_SKILL', '技能名称必须与导入目录一致。');
  const description = text(meta.description, '技能说明', 1024); const compatibility = meta.compatibility === undefined ? '' : text(meta.compatibility, '兼容性', 500, true);
  const metadata = meta.metadata ?? {}; object(metadata, '技能扩展元数据'); if (Object.entries(metadata).some(([key, value]) => typeof value !== 'string' || key.length > 128 || value.length > 2048)) fail('INVALID_SKILL', '技能 metadata 必须是字符串映射。');
  const body = normalized.slice(end + 5).trim(); if (!body) fail('INVALID_SKILL', '技能正文不能为空。');
  return { name, description, compatibility, metadata, allowedTools: typeof meta['allowed-tools'] === 'string' ? text(meta['allowed-tools'], '工具声明', 2048, true) : '', body };
}
export function inspectSkillDirectory(directory) {
  if (!path.isAbsolute(directory)) fail('SKILL_UNSAFE_PATH', '请选择技能目录的完整路径。');
  const root = path.resolve(directory); const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SKILL_UNSAFE_PATH', '技能来源必须是普通本地目录。');
  const files = scanDirectory(root); const skillFile = files.find(file => file.path === 'SKILL.md'); if (!skillFile) fail('INVALID_SKILL', '目录中没有 SKILL.md。');
  if (skillFile.bytes > 256 * 1024) fail('SKILL_TOO_LARGE', '技能说明文件超过大小限制。');
  const parsed = parseMetadata(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8'), path.basename(root));
  let manifest = {};
  if (files.some(file => file.path === 'assistant.json')) { try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'assistant.json'), 'utf8')); } catch { fail('INVALID_SKILL', 'assistant.json 无效。'); } object(manifest, '小助手技能清单'); }
  const requiredCapabilities = strings(manifest.requiredCapabilities, '依赖能力'), permissions = strings(manifest.permissions, '权限需求');
  const executors = strings(manifest.executors, '支持执行器'); if (executors.some(value => !['harness-text', 'deterministic'].includes(value))) fail('INVALID_SKILL', '技能指定了未支持的执行器。');
  const diagnostics = [];
  if (/\b(?:[A-Za-z]:[\\/]|\\\\[^\s]+)|\/(?:Users|home|mnt|tmp|workspace)\//.test(parsed.body)) diagnostics.push({ code: 'ABSOLUTE_PATH', severity: 'error', message: '技能正文包含机器绝对路径，需要移植后再启用。' });
  if (/(?:\]\(|["'`\s])(?:\.\.\/|\.\.\\)/.test(parsed.body)) diagnostics.push({ code: 'PATH_TRAVERSAL', severity: 'error', message: '技能正文引用目录外资源，需要移植后再启用。' });
  if (/\b(?:mcp__|nodeRepl\.|cua\.|functions\.exec)|(?:plugin|app):\/\//.test(parsed.body + '\n' + parsed.compatibility)) diagnostics.push({ code: 'HOST_API_DEPENDENCY', severity: 'error', message: '技能依赖宿主专用 API，小助手尚未提供对应适配。' });
  const scripts = files.filter(file => file.script).map(file => file.path);
  if (scripts.length) diagnostics.push({ code: 'SCRIPTS_DATA_ONLY', severity: 'warning', message: '已导入脚本仅保存为资料；本管理器不执行脚本，也不由技能授予执行权。' });
  if (parsed.allowedTools) diagnostics.push({ code: 'ALLOWED_TOOLS_NOT_GRANTS', severity: 'info', message: 'allowed-tools 是依赖声明，不能替代用户授权。' });
  for (const match of parsed.body.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]; if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    let decoded; try { decoded = decodeURIComponent(target); } catch { diagnostics.push({ code: 'INVALID_REFERENCE', severity: 'error', message: '技能资源引用编码无效。' }); continue; }
    if (path.isAbsolute(decoded) || !within(root, path.resolve(root, decoded))) diagnostics.push({ code: 'PATH_TRAVERSAL', severity: 'error', message: '技能资源引用越界。' });
    else if (!fs.existsSync(path.resolve(root, decoded))) diagnostics.push({ code: 'MISSING_REFERENCE', severity: 'error', message: '技能引用了未包含的本地资料。' });
  }
  return { id: parsed.name, name: parsed.name, description: parsed.description, compatibility: parsed.compatibility, version: parsed.metadata.version ?? 'unversioned', requiredCapabilities, permissions, executors: executors.length ? executors : ['harness-text'], scripts, diagnostics, files, digest: digest(boundedJson(files)), body: parsed.body };
}
export function copySkillFiles(source, destination, inspected) {
  fs.mkdirSync(destination, { recursive: false });
  try {
    for (const file of inspected.files) {
      const filename = plainFile(path.join(source, file.path), MAX_FILE);
      if (!within(fs.realpathSync(source), fs.realpathSync(filename)) || fileDigest(filename) !== file.sha256) fail('SOURCE_CHANGED', '技能来源在导入期间发生变化。');
      const target = path.join(destination, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
      if (fileDigest(target) !== file.sha256) fail('SOURCE_CHANGED', '技能导入文件校验失败。');
    }
  } catch (error) { if (within(path.dirname(destination), destination)) fs.rmSync(destination, { recursive: true, force: true }); throw error; }
}
export function skillAvailability(skill, availableCapabilities = []) { const available = new Set(availableCapabilities); const missingCapabilities = skill.requiredCapabilities.filter(capability => !available.has(capability)); return { usable: skill.enabled && !missingCapabilities.length && !skill.diagnostics.some(item => item.severity === 'error'), missingCapabilities }; }
