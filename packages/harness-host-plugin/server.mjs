import http from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { TEXT_POLICY, apply as installTextPolicy } from './text-policy.mjs';
import { bindOwnerAccess, normalizeOwnerGrants, grantableTool } from './owner-access.mjs';

export const HOST_PROTOCOL = 'xiaozhushou-harness-host-v1';
const SESSION = /^xzs-[a-f0-9]{32}$/;
const TASK = /^[a-f0-9-]{36}$/;
const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const numeric = (value, fallback, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;

function equalToken(received, expected) {
  const a = Buffer.from(received || ''), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function messageText(message, access) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) throw fault('INVALID_ASSISTANT_MESSAGE', 'Harness 返回了无效的回复。');
  const toolCalls = [...(Array.isArray(message.toolCalls) ? message.toolCalls : []), ...blocks.filter(block => ['tool-call', 'tool_call', 'tool_use'].includes(block?.type))];
  if (toolCalls.length) {
    if (toolCalls.some(call => !access?.policy.allows(call.name))) throw fault('TOOL_POLICY_VIOLATION', '会话出现本轮未授权的工具调用。');
    return '';
  }
  return blocks.filter(block => block?.type === 'text').map(block => {
    if (typeof block.text !== 'string') throw fault('INVALID_ASSISTANT_MESSAGE', 'Harness 文本块格式无效。');
    return block.text;
  }).join('');
}
function addUsage(total, value) {
  if (!value || !Number.isFinite(value.inputTokens) || !Number.isFinite(value.outputTokens)) return total;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (keys.some(key => value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 0))) return total;
  const next = { ...(total || { source: 'provider-reported-assistant-events' }) };
  for (const key of keys) next[key] = (next[key] || 0) + (value[key] || 0);
  return next;
}
function visible(task) {
  return { taskId: task.id, sessionId: task.sessionId, status: task.status, nativeTerminal: task.nativeTerminal,
    ...(task.result ? { result: task.result } : {}),
    cancellation: { requested: Boolean(task.cancelReason), confirmed: task.nativeTerminal && Boolean(task.cancelReason) },
    createdAt: task.createdAt, updatedAt: task.updatedAt };
}
async function readJson(req, maxBytes) {
  let size = 0; const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw fault('BODY_LIMIT', '任务内容过大。', 413);
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw fault('INVALID_JSON', '请求格式无效。'); }
}

/** Native Harness bridge. It never reads, copies or exports model credentials. */
export async function createHostedBridge(ctx, config = {}, { createUserMessage } = {}) {
  if (typeof createUserMessage !== 'function' || !ctx.agents?.create || !ctx.agents?.resume || !ctx.agentPresets?.mount || !ctx.sessions?.flush) throw fault('HOST_SERVICES_UNAVAILABLE', 'Harness 核心服务不可用。');
  if (!path.isAbsolute(config.productDataRoot || '') || !path.isAbsolute(config.workspacesRoot || '') || !path.isAbsolute(config.tokenFile || '')) throw fault('HOST_CONFIG_INVALID', '请配置产品专用数据和工作目录。');
  const dataRoot = await realpath(config.productDataRoot), workspacesRoot = await realpath(config.workspacesRoot);
  const tokenFile = await realpath(config.tokenFile);
  if (!inside(dataRoot, tokenFile) || !inside(dataRoot, workspacesRoot) || !(await stat(dataRoot)).isDirectory() || !(await stat(workspacesRoot)).isDirectory()) throw fault('HOST_CONFIG_INVALID', '桥接令牌和工作区须保存在小助手产品数据目录内。');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw fault('HOST_TOKEN_INVALID', '产品桥接令牌无效。');
  const port = config.port === 0 ? 0 : numeric(config.port, 11234, 1024, 65535);
  const provider = config.provider || 'deepseek', model = config.model || 'deepseek-flash';
  const preset = config.agentPreset || 'xiaozhushou-desktop-text-v1';
  if (![provider, model, preset].every(value => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value))) throw fault('HOST_CONFIG_INVALID', 'Harness 模型或会话预设无效。');
  const turnTimeoutMs = numeric(config.turnTimeoutMs, 600000, 50, 3600000);
  const cancelConfirmMs = numeric(config.cancelConfirmMs, 5000, 20, 30000);
  const maxOutputBytes = numeric(config.maxOutputBytes, 1048576, 1024, 4194304);
  const maxConcurrent = numeric(config.maxConcurrent, 3, 1, 8);
  const stateDir = path.join(dataRoot, 'harness-host');
  await mkdir(stateDir, { recursive: true });
  if (!inside(dataRoot, await realpath(stateDir))) throw fault('HOST_STATE_PATH_REFUSED', '产品会话记录目录无效。');
  const statePath = path.join(stateDir, 'sessions.json');
  let sessions = {};
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    if (saved.version !== 1 || !saved.sessions || Array.isArray(saved.sessions)) throw fault('HOST_STATE_INVALID', '产品会话记录格式无效。');
    for (const [sid, record] of Object.entries(saved.sessions)) {
      if (!SESSION.test(sid) || !path.isAbsolute(record?.workspace || '') || !inside(workspacesRoot, record.workspace)) throw fault('HOST_STATE_INVALID', '产品会话记录格式无效。');
    }
    sessions = saved.sessions;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tasks = new Map(), active = new Map(), handles = new Map();
  let modelVerified = false, closed = false, stateQueue = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify({ version: 1, sessions });
    const job = stateQueue.catch(() => {}).then(async () => {
      const temporary = statePath + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' }); await rename(temporary, statePath);
    });
    stateQueue = job; return job;
  };
  const update = (task, status) => { task.status = status; task.updatedAt = new Date().toISOString(); };
  function finish(task, status, result) {
    if (task.nativeTerminal) return;
    task.nativeTerminal = true; clearTimeout(task.timeout); clearTimeout(task.cancelTimer);
    task.controller.abort(); task.access?.dispose();
    update(task, status); task.result = result; active.delete(task.sessionId);
  }
  function requestCancel(task, code = 'CANCELLED') {
    if (task.nativeTerminal || task.cancelReason) return;
    task.cancelReason = code; update(task, 'cancel_requested'); clearTimeout(task.timeout);
    task.controller.abort();
    if (!task.submitted || task.turnEnded) {
      finish(task, code === 'CANCELLED' ? 'cancelled' : 'failed', { ok: false, finalText: '', sessionId: task.sessionId, artifacts: [], error: { code, message: code === 'CANCELLED' ? '任务已取消。' : '本轮 Harness 任务已超时。' }, cancellation: { requested: true, confirmed: true } });
      return;
    }
    try { task.agent?.cancel({ kind: 'user' }); } catch { /* A missing turn/end remains unconfirmed. */ }
    if (task.nativeTerminal) return;
    task.cancelTimer = setTimeout(() => {
      if (task.nativeTerminal) return;
      update(task, 'stop_unconfirmed');
      task.result = { ok: false, finalText: '', sessionId: task.sessionId, artifacts: [], error: { code: 'CANCEL_UNCONFIRMED', message: '已请求 Harness 停止，但尚未确认本轮已结束。' }, cancellation: { requested: true, confirmed: false } };
    }, cancelConfirmMs);
    task.cancelTimer.unref?.();
  }
  const onSessionEvent = (session, event) => {
    const task = active.get(String(session?.id));
    if (!task || task.nativeTerminal || !task.submitted) return;
    if (event?.type === 'turn/start' && task.turnId === undefined) { task.turnId = event.data?.turn; update(task, task.cancelReason ? 'cancel_requested' : 'running'); }
    if (typeof event?.type === 'string' && event.type.startsWith('tool/')) {
      if (event.data?.turn !== undefined && task.turnId !== undefined && event.data.turn !== task.turnId) return;
      if (event.type === 'tool/call' && task.access?.policy.allows(event.data?.name)) { task.toolCallIds.add(event.data.callId); return; }
      if (event.type === 'tool/result' && task.toolCallIds.has(event.data?.message?.source?.callId)) return;
      task.failureCode = 'TOOL_POLICY_VIOLATION'; requestCancel(task, task.failureCode); return;
    }
    if (task.turnId === undefined || event?.data?.turn !== task.turnId) return;
    if (event.type === 'assistant/message') {
      try {
        task.text = messageText(event.data?.message, task.access);
        if (Buffer.byteLength(task.text) > maxOutputBytes) throw fault('OUTPUT_LIMIT', 'Harness 回复超过允许的大小。');
        task.usage = addUsage(task.usage, event.data?.usage);
      } catch (error) { task.failureCode = error.code || 'INVALID_ASSISTANT_MESSAGE'; requestCancel(task, task.failureCode); }
    }
    if (event.type !== 'turn/end') return;
    const reason = event.data?.reason?.kind;
    task.turnEnded = true;
    if (task.cancelReason) {
      const cancelled = task.cancelReason === 'CANCELLED';
      finish(task, cancelled ? 'cancelled' : 'failed', { ok: false, finalText: '', sessionId: task.sessionId, artifacts: [], error: { code: task.cancelReason, message: cancelled ? '任务已取消。' : task.cancelReason === 'RUNTIME_TIMEOUT' ? '本轮任务已超时并停止。' : 'Harness 本轮未通过文本会话检查，已停止。' }, cancellation: { requested: true, confirmed: true } });
    } else if (reason !== 'completed' || !task.text?.trim()) {
      finish(task, 'failed', { ok: false, finalText: '', sessionId: task.sessionId, artifacts: [], error: { code: reason === 'completed' ? 'EMPTY_RESULT' : 'MODEL_TURN_FAILED', message: reason === 'completed' ? 'Harness 没有返回可交付的文字回答。' : 'Harness 未确认本轮正常完成，请检查现有账号或模型状态。' } });
    } else {
      // Flush outside the synchronous native append observer before releasing this session.
      update(task, 'saving'); clearTimeout(task.timeout);
      Promise.resolve().then(() => ctx.sessions.flush(task.agent.session)).then(() => {
        modelVerified = true;
        finish(task, 'completed', { ok: true, finalText: task.text, sessionId: task.sessionId, artifacts: [], ...(task.usage ? { usage: task.usage } : {}) });
      }).catch(() => finish(task, 'failed', { ok: false, finalText: '', sessionId: task.sessionId, artifacts: [], error: { code: 'SESSION_SAVE_FAILED', message: '回复已产生，但 Harness 会话未能确认保存。' } }));
    }
  };
  const offEvents = ctx.on('session/event', onSessionEvent, { global: true });
  async function submit(body) {
    if (closed) throw fault('HOST_CLOSED', 'Harness 桥接已关闭。', 503);
    if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 256 * 1024) throw fault('INVALID_PROMPT', '请输入有效任务文字（不超过 256 KiB）。');
    if (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace)) throw fault('INVALID_WORKSPACE', '工作目录无效。');
    if (body.taskId !== undefined && (typeof body.taskId !== 'string' || !TASK.test(body.taskId))) throw fault('INVALID_TASK', '任务标识无效。');
    if (body.personaPrefix !== undefined && (typeof body.personaPrefix !== 'string' || Buffer.byteLength(body.personaPrefix) > 16384 || body.personaPrefix.includes('\0'))) throw fault('INVALID_PERSONA', '小助手个性设置须为不超过 16 KiB 的文字。');
    let grants;
    try { grants = normalizeOwnerGrants(body); } catch (error) { throw fault(error.code, '主人能力授权格式无效，当前任务未启动。', 403); }
    const digest = createHash('sha256').update(JSON.stringify([body.prompt, body.workspace, body.sessionId ?? null, grants, body.personaPrefix ?? null])).digest('hex');
    if (body.taskId && tasks.has(body.taskId)) {
      const existing = tasks.get(body.taskId);
      if (existing.digest !== digest) throw fault('TASK_CONFLICT', '任务标识已被不同请求使用。', 409);
      return visible(existing);
    }
    const workspace = await realpath(body.workspace);
    if (!inside(workspacesRoot, workspace) || !(await stat(workspace)).isDirectory()) throw fault('WORKSPACE_REFUSED', '只能在小助手产品工作区中创建会话。', 403);
    // realpath/stat yield. Recheck idempotency after them so concurrent duplicate HTTP
    // requests cannot each start a model turn before either record becomes visible.
    if (body.taskId && tasks.has(body.taskId)) {
      const existing = tasks.get(body.taskId);
      if (existing.digest !== digest) throw fault('TASK_CONFLICT', '任务标识已被不同请求使用。', 409);
      return visible(existing);
    }
    const resumed = body.sessionId !== undefined;
    const sid = resumed ? body.sessionId : 'xzs-' + randomUUID().replaceAll('-', '');
    if (!SESSION.test(sid) || (resumed && (!sessions[sid] || sessions[sid].workspace !== workspace))) throw fault('SESSION_REFUSED', '只能继续由小助手创建的同一工作区会话。', 403);
    if (active.has(sid)) throw fault('SESSION_BUSY', '该小助手会话仍在运行或等待停止确认。', 409);
    if (active.size >= maxConcurrent) throw fault('HOST_BUSY', '小助手 Harness 任务已达到并行上限。', 429);
    for (const [id, old] of tasks) if (old.nativeTerminal && Date.now() - Date.parse(old.updatedAt) > 15 * 60 * 1000) tasks.delete(id);
    if (tasks.size >= 512) throw fault('HOST_TASK_LIMIT', '任务记录暂满，请稍后重试。', 429);
    const task = { id: body.taskId || randomUUID(), digest, grants, controller: new AbortController(), toolCallIds: new Set(), sessionId: sid, status: 'queued', nativeTerminal: false, createdAt: new Date().toISOString(), text: '' };
    task.updatedAt = task.createdAt; tasks.set(task.id, task); active.set(sid, task);
    task.timeout = setTimeout(() => requestCancel(task, 'RUNTIME_TIMEOUT'), turnTimeoutMs); task.timeout.unref?.();
    void start(task, body, workspace, sid, resumed);
    return visible(task);
  }
  async function start(task, body, workspace, sid, resumed) {
    try {
      const setup = async agentCtx => {
        const mounted = await ctx.agentPresets.mount(agentCtx, preset);
        if (mounted?.id !== preset) throw fault('SAFE_PRESET_UNAVAILABLE', '小助手独立文本安全预设尚未正确挂载。');
        // Preset plugins run in their own Cordis contexts. Install the final execution guard
        // directly on this unpublished Agent, rather than assuming JS property inheritance.
        installTextPolicy(agentCtx);
      };
      let agent = ctx.agents.get(sid);
      if (!agent) {
        const handle = resumed
          ? await ctx.agents.resume({ resumeSessionId: sid, agentOptions: { provider, model }, setup })
          : await ctx.agents.create({ sessionId: sid, meta: { cwd: workspace, agentPreset: preset, product: 'xiaozhushou' }, agentOptions: { provider, model }, setup });
        handles.set(sid, handle); agent = ctx.agents.get(sid);
      }
      if (!agent || agent.status === 'running') throw fault('SESSION_BUSY', 'Harness 会话尚未空闲。', 409);
      if (agent.ctx?.[TEXT_POLICY] !== true) throw fault('SAFE_PRESET_UNAVAILABLE', '小助手会话没有经过独立文本权限检查。');
      task.agent = agent;
      if (task.nativeTerminal) { if (closed) { await handles.get(sid)?.dispose?.(); handles.delete(sid); } return; }
      task.access = await bindOwnerAccess(agent.ctx, ctx, agent, { grants: task.grants, personaPrefix: body.personaPrefix, active: () => active.get(sid) === task && !task.nativeTerminal && !task.cancelReason && !task.turnEnded, signal: task.controller.signal });
      if (task.nativeTerminal) { task.access.dispose(); return; }
      if (!resumed) { sessions[sid] = { workspace, createdAt: task.createdAt }; await persist(); }
      if (task.nativeTerminal) return;
      task.submitted = true;
      agent.followup(createUserMessage({ content: [{ type: 'text', text: task.access.instructions + body.prompt }], source: { kind: 'xiaozhushou-desktop-host', form: 'direct', taskId: task.id, authority: task.grants.skills.length || task.grants.tools.length ? 'product-owner' : 'text-only' } }));
    } catch (error) {
      if (task.submitted) { task.failureCode = error.code || 'PROMPT_QUEUE_FAILED'; requestCancel(task, task.failureCode); }
      else finish(task, 'failed', { ok: false, finalText: '', sessionId: sid, artifacts: [], error: { code: error.code || 'HOST_SESSION_FAILED', message: '无法建立小助手 Harness 会话，请检查插件预设和当前 Harness 状态。' } });
    }
  }
  async function catalog() {
    const service = ctx.get?.('skills'), tools = ctx.get?.('tools') ?? ctx.tools;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const skills = service?.list ? await service.list({ cwd: workspacesRoot, signal: controller.signal }) : [];
      const schemas = tools?.schemas ? tools.schemas() : [];
      return { ok: true, protocol: HOST_PROTOCOL, source: 'harness-host', metadataOnly: true,
        skills: (Array.isArray(skills) ? skills : []).slice(0, 300).map(item => ({ name: String(item.name || '').slice(0, 160), description: String(item.description || '').slice(0, 1000), provider: String(item.provider || 'dsh').slice(0, 160), modelInvocable: item.invocation?.modelInvocable !== false, executableInProduct: false })),
        tools: (Array.isArray(schemas) ? schemas : []).slice(0, 500).map(item => ({ name: String(item.name || '').slice(0, 160), description: String(item.description || '').slice(0, 1000), grantable: grantableTool(item.name), executableInProduct: false })),
        executionPolicy: 'explicit-product-owner-task-allowlist', grantSchema: { authority: 'product-owner', ownerGrants: { skills: ['exact-skill-name'], tools: ['exact-tool-name'] } }, externalContentInheritsOwner: false };
    } finally { clearTimeout(timer); }
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (!res.destroyed) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(body)); };
    try {
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      if (req.headers.host !== expectedHost || req.headers.origin || req.headers['sec-fetch-site']) throw fault('LOCAL_REQUEST_REQUIRED', '仅允许产品本地服务访问。', 403);
      if (!equalToken(req.headers.authorization, 'Bearer ' + token)) throw fault('UNAUTHORIZED', '产品桥接授权无效。', 401);
      const url = new URL(req.url, 'http://' + expectedHost);
      if (url.search || url.hash) throw fault('INVALID_ROUTE', '请求路径无效。', 404);
      if (req.method === 'GET' && url.pathname === '/health') {
        reply(200, { ok: true, protocol: HOST_PROTOCOL, project: 'xiaozhushou', provider, model, preset, productDataRoot: dataRoot, workspacesRoot, modelVerified, credentialsSource: 'harness-existing-login', activeTasks: active.size, toolPolicy: 'product-owner-task-grants-v1', capabilities: { text: true, resume: true, streaming: false, mcp: true, skills: true, ownerTaskGrants: true, defaultToolAccess: 'none', images: false, artifacts: false, cancel: 'native-owned-session' } }); return;
      }
      if (req.method === 'GET' && url.pathname === '/catalog') { reply(200, await catalog()); return; }
      if (req.method === 'POST' && url.pathname === '/tasks') { reply(202, await submit(await readJson(req, 300 * 1024))); return; }
      const id = url.pathname.match(/^\/tasks\/([^/]+)$/)?.[1];
      if (!id || !TASK.test(id) || !['GET', 'DELETE'].includes(req.method)) throw fault('NOT_FOUND', '请求不存在。', 404);
      const task = tasks.get(id); if (!task) throw fault('TASK_NOT_FOUND', '任务记录不存在或已过期。', 404);
      if (req.method === 'DELETE') requestCancel(task);
      reply(200, visible(task));
    } catch (error) { reply(error.status || 500, { ok: false, error: { code: error.code || 'HOST_REQUEST_FAILED', message: error.status ? error.message : 'Harness 本地桥接处理失败。' } }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  return {
    server,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); }); return `http://127.0.0.1:${server.address().port}`; },
    async close() {
      closed = true;
      for (const task of active.values()) requestCancel(task);
      if (typeof offEvents === 'function') offEvents();
      server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
      for (const task of tasks.values()) { clearTimeout(task.timeout); clearTimeout(task.cancelTimer); }
      for (const handle of handles.values()) { try { await handle?.dispose?.(); } catch {} }
      await stateQueue.catch(() => {});
    },
  };
}
