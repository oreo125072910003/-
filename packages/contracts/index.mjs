export const APP_VERSION = '0.3.12';
export const TASK_STATUSES = new Set(['queued', 'running', 'validating', 'succeeded', 'partial', 'failed', 'cancelled', 'interrupted', 'waiting_dependency']);
export const TERMINAL_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted']);

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
  if (!['agent', 'organize','literature'].includes(kind)) throw new Error('不支持这种任务类型。');
  if(kind==='literature'&&prompt.length>500)throw Error('文献检索词最多 500 字符。');
  const workflowId=value.workflowId??'single';
  if(!['single','writing-review','research-compare'].includes(workflowId))throw Error('不支持这个协作流程。');
  if(kind==='organize'&&workflowId!=='single')throw Error('资料整理不能同时运行 AI 协作。');
  const skillIds=value.skillIds??[];
  if(!Array.isArray(skillIds)||skillIds.length>32||skillIds.some(id=>typeof id!=='string'||!/[a-z0-9]/.test(id)||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))throw Error('每次最多选择 32 个有效技能。');
  if(kind==='organize'&&skillIds.length)throw Error('本地资料整理使用固定流程，请在 AI 工作中选择技能。');
  const attachmentPaths = value.attachmentPaths ?? [];
  if(kind==='literature'&&(workflowId!=='single'||skillIds.length||attachmentPaths.length))throw Error('文献检索使用独立来源接口，请单独提交检索词。');
  if (!Array.isArray(attachmentPaths) || attachmentPaths.length > 20 || attachmentPaths.some(p => typeof p !== 'string' || p.length > 4096 || p.includes('\0'))) {
    throw new Error('每次最多添加 20 个有效文件。');
  }
  return { prompt, kind, workflowId, attachmentPaths: [...new Set(attachmentPaths)], skillIds:[...new Set(skillIds)] };
}

export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-z]+_[a-f0-9-]{8,40}$/.test(value)) throw new Error('记录编号无效。');
  return value;
}

export function publicError(error) {
  const message = String(error?.message ?? error ?? '操作失败。');
  return message.replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[^\s"']+|(?:api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+)/gi, '[已隐藏凭据]').slice(0, 1500);
}
