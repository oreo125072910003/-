export const APP_VERSION = '0.1.0';
export const TASK_STATUSES = new Set(['queued', 'running', 'validating', 'succeeded', 'failed', 'cancelled', 'interrupted', 'waiting_dependency']);
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

export function boundedText(value, label, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || (!empty && !value.trim())) {
    throw new Error(`${label}无效${max ? `，最多 ${max} 字符` : ''}。`);
  }
  return value.trim();
}

export function taskInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写任务内容。');
  const prompt = boundedText(value.prompt, '任务内容', 18000);
  const kind = value.kind ?? 'agent';
  if (!['agent', 'organize'].includes(kind)) throw new Error('不支持这种任务类型。');
  const attachmentPaths = value.attachmentPaths ?? [];
  if (!Array.isArray(attachmentPaths) || attachmentPaths.length > 20 || attachmentPaths.some(p => typeof p !== 'string' || p.length > 4096 || p.includes('\0'))) {
    throw new Error('每次最多添加 20 个有效文件。');
  }
  return { prompt, kind, attachmentPaths: [...new Set(attachmentPaths)] };
}

export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z]+_[a-f0-9-]{8,40}$/.test(value)) throw new Error('记录编号无效。');
  return value;
}

export function publicError(error) {
  const message = String(error?.message ?? error ?? '操作失败。');
  return message.replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[^\s"']+|(?:api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+)/gi, '[已隐藏凭据]').slice(0, 1500);
}
