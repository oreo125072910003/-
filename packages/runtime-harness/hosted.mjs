import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateTaskImages } from '../contracts/image-input.mjs';

const PROTOCOL = 'xiaozhushou-harness-host-v1';
const SESSION = /^xzs-[a-f0-9]{32}$/;
const fault = (code, message) => Object.assign(new Error(message), { code });
const final = value => ['completed', 'failed', 'cancelled', 'stop_unconfirmed'].includes(value?.status);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connection(settings = {}) {
  let stored = {};
  if (settings.hostedConfigFile) {
    if (!path.isAbsolute(settings.hostedConfigFile)) throw fault('HOST_CONFIG_INVALID', 'Harness 宿主配置路径须为绝对路径。');
    const text = await readFile(settings.hostedConfigFile, 'utf8');
    if (Buffer.byteLength(text) > 16384) throw fault('HOST_CONFIG_INVALID', 'Harness 宿主配置无效。');
    stored = JSON.parse(text);
  }
  const endpoint = settings.hostedEndpoint || stored.endpoint || 'http://127.0.0.1:11234';
  if (!/^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})\/?$/.test(endpoint)) throw fault('HOST_ENDPOINT_REFUSED', 'Harness 宿主只允许本机 127.0.0.1 端口。');
  const url = new URL(endpoint);
  if (Number(url.port) > 65535 || Number(url.port) < 1) throw fault('HOST_ENDPOINT_REFUSED', 'Harness 宿主端口无效。');
  const tokenFile = settings.hostedTokenFile || stored.tokenFile;
  if (!path.isAbsolute(tokenFile || '')) throw fault('HOST_TOKEN_MISSING', '尚未准备小助手的 Harness 本地桥接令牌。');
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw fault('HOST_TOKEN_INVALID', 'Harness 本地桥接令牌无效。');
  return { endpoint: url.origin, token, timeoutMs: settings.hostedRequestTimeoutMs ?? 12000 };
}
async function request(config, route, { method = 'GET', body, maxBytes = 2 * 1024 * 1024, timeoutMs = config.timeoutMs } = {}) {
  const url = new URL(route, config.endpoint);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, { method, headers: { authorization: 'Bearer ' + config.token, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      const parts = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { req.destroy(fault('HOST_RESPONSE_LIMIT', 'Harness 宿主返回内容过大。')); return; } parts.push(chunk); });
      res.on('error', () => reject(fault('HOST_CONNECTION_LOST', 'Harness 宿主连接已断开。')));
      res.on('end', () => {
        let value;
        try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { reject(fault('HOST_PROTOCOL_INVALID', 'Harness 宿主没有返回有效 JSON。')); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(Object.assign(fault(value?.error?.code || 'HOST_HTTP_FAILED', ['UNAUTHORIZED', 'HOST_BUSY', 'SESSION_BUSY', 'SESSION_REFUSED', 'WORKSPACE_REFUSED', 'TASK_NOT_FOUND'].includes(value?.error?.code) ? String(value.error.message).slice(0, 500) : 'Harness 宿主拒绝了请求。'), { hostRejected: true })); return; }
        resolve(value);
      });
    });
    const timer = setTimeout(() => req.destroy(fault('HOST_REQUEST_TIMEOUT', '连接现有 Harness 超时，请检查它是否已启动。')), timeoutMs);
    req.once('error', error => reject(error.code?.startsWith('HOST_') ? error : fault('HOST_UNAVAILABLE', '尚未连接现有 Harness；请启用小助手宿主插件。')));
    req.once('close', () => clearTimeout(timer));
    req.end(payload);
  });
}
function verifyHealth(health) {
  if (health?.ok !== true || health.protocol !== PROTOCOL || health.project !== 'xiaozhushou' || !['product-text-only-v1', 'product-owner-task-grants-v1'].includes(health.toolPolicy) || health.credentialsSource !== 'harness-existing-login') throw fault('HOST_IDENTITY_INVALID', '该本地服务不是受支持的小助手 Harness 插件。');
  return health;
}
function verifyTask(value, taskId) {
  if (value?.taskId !== taskId || !SESSION.test(value.sessionId || '') || !['queued', 'running', 'saving', 'cancel_requested', 'completed', 'failed', 'cancelled', 'stop_unconfirmed'].includes(value.status)) throw fault('HOST_PROTOCOL_INVALID', 'Harness 任务回执无效。');
  if (final(value) && (!value.result || typeof value.result.ok !== 'boolean' || typeof value.result.finalText !== 'string' || value.result.sessionId !== value.sessionId)) throw fault('HOST_PROTOCOL_INVALID', 'Harness 最终任务结果无效。');
  if (value.status === 'completed' && (value.nativeTerminal !== true || value.result?.ok !== true || !value.result.finalText.trim())) throw fault('HOST_PROTOCOL_INVALID', 'Harness 未确认有效完成结果。');
  return value;
}

/** Read-only health. It does not submit a model request or inspect provider credentials. */
export async function inspectHostedRuntime(settings = {}) {
  try {
    const config = await connection(settings), health = verifyHealth(await request(config, '/health', { maxBytes: 65536 }));
    return { available: true, ready: health.modelVerified === true, source: 'existing-harness-host', version: null, protocol: PROTOCOL, endpoint: config.endpoint, provider: health.provider, model: health.model, credentialsConfigured: true, credentialsVerified: false, credentialsSource: 'harness-existing-login', modelVerified: health.modelVerified === true,
      detail: health.modelVerified ? '已连接现有 Harness，并完成过真实模型回复。' : '已连接现有 Harness，复用已有登录；尚未验证真实模型回复。', capabilities: { ...health.capabilities, compatible: true, modelVerified: health.modelVerified === true, protocol: PROTOCOL, toolPolicy: health.toolPolicy === 'product-owner-task-grants-v1' ? 'explicit-owner-task-grants' : 'conversation-only' } };
  } catch (error) { return { available: false, ready: false, source: 'existing-harness-host', detail: error.message, error: { code: error.code || 'HOST_INSPECTION_FAILED', message: error.message }, capabilities: { compatible: false, modelVerified: false } }; }
}
export async function probeHostedRuntimeConnection(settings = {}) {
  const inspection = await inspectHostedRuntime(settings);
  return { ok: inspection.available, inspection, modelCalled: false, credentialsVerified: false, ...(inspection.error ? { error: inspection.error } : {}) };
}
export async function readHostedCatalog(settings = {}) {
  try {
    const config = await connection(settings); verifyHealth(await request(config, '/health', { maxBytes: 65536 }));
    const result = await request(config, '/catalog');
    if (result?.protocol !== PROTOCOL || result.metadataOnly !== true || !Array.isArray(result.skills) || !Array.isArray(result.tools)) throw fault('HOST_PROTOCOL_INVALID', 'Harness 能力清单格式无效。');
    return result;
  } catch (error) { return { ok: false, skills: [], tools: [], error: { code: error.code || 'HOST_CATALOG_FAILED', message: error.message } }; }
}

/** Product-owned native session, using the account already logged into Harness. */
export async function runHostedTask({ prompt, workspace, sessionId, conversation, images, signal, onEvent, settings = {} } = {}) {
  const emit = (type, message) => { try { onEvent?.({ type, message }); } catch {} };
  const taskId = randomUUID(); let config, submitted = false, cancelled = signal?.aborted === true, lastStatus, lastSession = sessionId;
  const onAbort = () => { cancelled = true; };
  async function stopAndConfirm() {
    const deadline = Date.now() + (settings.hostedCancelWaitMs ?? 8000); let value;
    do {
      try { value = verifyTask(await request(config, '/tasks/' + taskId, { method: 'DELETE', timeoutMs: Math.min(config.timeoutMs, 3000) }), taskId); if (final(value)) return value; }
      catch (error) { if (error.code !== 'TASK_NOT_FOUND') break; }
      await delay(100);
    } while (Date.now() < deadline);
    return { status: 'stop_unconfirmed', result: { ok: false, finalText: '', ...(lastSession ? { sessionId: lastSession } : {}), artifacts: [], error: { code: 'CANCEL_UNCONFIRMED', message: '已请求 Harness 停止，暂时无法确认本轮是否已结束。' }, cancellation: { requested: true, confirmed: false } } };
  }
  try {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw fault('INVALID_PROMPT', '请输入有效任务内容（不超过 256 KiB）。');
    if (!path.isAbsolute(workspace || '')) throw fault('INVALID_WORKSPACE', '请选择小助手工作区。');
    if (sessionId !== undefined && !SESSION.test(sessionId)) throw fault('SESSION_REFUSED', '该会话不是小助手宿主创建的会话。');
    const taskImages = validateTaskImages(images);
    if (cancelled) throw fault('CANCELLED', '任务已取消。');
    config = await connection(settings); const health = verifyHealth(await request(config, '/health', { maxBytes: 65536 }));
    if (taskImages.length && health.capabilities?.images !== true) throw fault('HOST_IMAGES_UNSUPPORTED', '当前 Harness 宿主尚未支持图片输入，请更新并启用图片能力后重试；本轮没有提交。');
    signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
    if (cancelled) throw fault('CANCELLED', '任务已取消。');
    emit('status', '正在使用现有 Harness 登录建立小助手会话…');
    submitted = true;
    const personaPrefix = settings.personaPrefix ?? settings.persona;
    let value = verifyTask(await request(config, '/tasks', { method: 'POST', body: { taskId, prompt, workspace, ...(taskImages.length ? { images: taskImages } : {}), ...(sessionId ? { sessionId } : {}), ...(conversation ? { conversation } : {}), ...(personaPrefix ? { personaPrefix } : {}), ...(settings.hostedOwnerGrants ? { authority: 'product-owner', ownerGrants: settings.hostedOwnerGrants } : {}) } }), taskId);
    lastSession = value.sessionId;
    const deadline = Date.now() + (settings.timeoutMs ?? 10 * 60 * 1000);
    while (!final(value)) {
      if (cancelled || Date.now() >= deadline) { value = await stopAndConfirm(); break; }
      if (value.status !== lastStatus) { lastStatus = value.status; emit('status', value.status === 'running' ? '小助手正在思考…' : value.status === 'saving' ? '正在保存 Harness 会话…' : 'Harness 正在处理任务…'); }
      await delay(Math.min(500, Math.max(20, settings.hostedPollMs ?? 150)));
      value = verifyTask(await request(config, '/tasks/' + taskId), taskId);
    }
    const result = value.result;
    if (result.ok) { emit('text', result.finalText); emit('status', '回答已完成。'); }
    else emit('diagnostic', result.error?.message || 'Harness 本轮没有完成。');
    return { ...result, runtime: { source: 'existing-harness-host', protocol: PROTOCOL, taskId }, cancellation: value.cancellation || result.cancellation };
  } catch (error) {
    if (submitted && config && !error.hostRejected) { const stopped = await stopAndConfirm(); if (stopped.status === 'stop_unconfirmed') return stopped.result; }
    emit('diagnostic', error.message);
    return { ok: false, finalText: '', ...(lastSession ? { sessionId: lastSession } : {}), artifacts: [], error: { code: error.code || 'HOST_RUNTIME_FAILED', message: error.message } };
  } finally { signal?.removeEventListener('abort', onAbort); }
}
