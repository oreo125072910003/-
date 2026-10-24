import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const SUPPORTED_VERSION = '0.2.1-rc.2';
const activeSessions = new Set();
const OS_ENV = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;
const BLOCKED_PLUGINS = [
  'tool-plugin-manager', 'plugin-manager', 'config-editor', 'settings', 'tool-working-directory',
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'agent-instructions',
  'skill-filesystem', 'tool-skill', 'skill-office', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent', 'tool-subagent-fork', 'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web',
  'workspace-dependencies', 'persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'plan-mode',
];
const DEFAULT_PERSONA = '你是小助手，是主人电脑上持续陪伴的个人助手。用自然、清楚的中文交流；准确区分计划、正在执行与已验证完成。当前只开放对话，不能声称已操作微信、邮件、文件或其他程序。';

function coded(code, message) { return Object.assign(new Error(message), { code }); }
function optionsFor(value = {}) {
  return {
    ...value,
    executable: value.executable ?? value.runtimeCommand,
    home: value.home ?? value.runtimeHome,
    profile: value.profile ?? value.runtimeProfile ?? 'sdk',
    persona: value.persona ?? value.personaPrefix,
    args: value.args ?? [],
  };
}
function cleanEnvironment(settings, home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => OS_ENV.test(key)));
  // Only explicit product settings may provide secrets; never inherit the host agent's credentials.
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (typeof value !== 'string' || key.includes('=') || /[\0\r\n]/.test(key + value)) throw coded('INVALID_ENV', '运行时环境变量无效。');
    env[key] = value;
  }
  env.DSH_HOME = home;
  env.DSH_TELEMETRY_MODE = 'OFF';
  env.DSH_PERMISSION_MODE = 'read-only';
  env.DSH_MAX_TOKENS_AS_SUCCESS = 'false';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}
async function exists(filename) { try { await access(filename); return true; } catch { return false; } }
function defaultHome() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), '小助手', 'harness-home');
}
async function physicalPath(filename) {
  try { return await realpath(filename); } catch {
    const parent = path.dirname(filename);
    return parent === filename ? filename : path.join(await physicalPath(parent), path.basename(filename));
  }
}
async function safeHome(home, { create = false } = {}) {
  const resolved = path.resolve(home || defaultHome());
  const physical = await physicalPath(resolved);
  const personal = await physicalPath(path.join(os.homedir(), '.dsh'));
  const relative = path.relative(personal, physical);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw coded('PERSONAL_HOME_REFUSED', '小助手必须使用自己的 Harness 数据目录，不能使用个人 .dsh 或它的子目录。');
  }
  if (physical === path.parse(physical).root || physical === os.homedir()) throw coded('INVALID_HOME', '请选择小助手专用的 Harness 数据目录。');
  if (create) {
    await mkdir(resolved, { recursive: true });
    const marker = path.join(resolved, '.xiaozhushou-runtime.json');
    if (!await exists(marker)) await writeFile(marker, JSON.stringify({ owner: 'xiaozhushou', schemaVersion: 1 }) + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  return resolved;
}

async function discover(settings) {
  if (!Array.isArray(settings.args) || settings.args.length > 1 || settings.args.some(arg => typeof arg !== 'string' || !path.isAbsolute(arg) || !/\.(?:mjs|cjs|js)$/i.test(arg))) {
    throw coded('EXTRA_ARGS_REFUSED', 'args 只允许一个受信任的绝对 JS 启动模块路径，不能包含 profile、任务或模型参数。');
  }
  if (settings.executable && path.isAbsolute(settings.executable)) return { executable: path.resolve(settings.executable), args: settings.args, source: 'explicit-setting' };
  if (settings.executable && !/^dsh(?:\.cmd|\.exe)?$/i.test(settings.executable)) throw coded('INVALID_EXECUTABLE', '请提供 dsh 命令或程序绝对路径。');
  const candidates = [];
  if (process.env.XIAOZHUSHOU_DSH_COMMAND) candidates.push([process.env.XIAOZHUSHOU_DSH_COMMAND, 'product-environment']);
  try {
    const locations = JSON.parse(await readFile(path.join(projectRoot, 'config', 'runtime-locations.json'), 'utf8'));
    if (typeof locations.harnessCommand === 'string' && locations.harnessCommand.trim()) candidates.push([locations.harnessCommand, 'machine-local-runtime-location']);
  } catch {}
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']) candidates.push([path.join(directory, name), 'PATH']);
  }
  if (settings.executable) {
    for (const [executable, source] of candidates.filter(([, source]) => source === 'PATH')) if (await exists(executable)) return { executable: path.resolve(executable), args: settings.args, source };
    return null;
  }
  // Read only the public program-location field from the historical project config.
  try {
    const config = JSON.parse(await readFile(path.join(projectRoot, '代码', '项目', 'config', 'wechatagent.json'), 'utf8'));
    if (typeof config.runtime?.dshDesktop === 'string') candidates.push([path.join(path.dirname(config.runtime.dshDesktop), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), 'desktop-installed-command']);
  } catch {}
  if (process.platform === 'win32') {
    for (const base of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.PROGRAMFILES].filter(Boolean)) {
      candidates.push([path.join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'), 'desktop-installed-command']);
    }
  }
  for (const [executable, source] of candidates) if (await exists(executable)) return { executable: path.resolve(executable), args: settings.args, source };
  return null;
}

function launch(executable, args, options) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw coded('INVALID_ARGS', 'Harness 启动参数无效。');
  if (/app\.asar/i.test(executable)) throw coded('INTERNAL_ENTRY_REFUSED', '请使用受支持的 dsh CLI，不能使用 app.asar 内部入口。');
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // SDK prompts use stdin. Shell arguments are trusted launch settings and reject cmd expansion.
    for (const value of [executable, ...args]) if (/["%\r\n&|<>^!]/.test(value)) throw coded('UNSAFE_COMMAND_ARGUMENT', 'Windows CLI 路径或参数包含不支持的命令行字符。');
    const commandLine = '"' + [executable, ...args].map(value => '"' + value + '"').join(' ') + '"';
    return spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', commandLine], { ...options, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(executable, args, { ...options, windowsHide: true });
}

async function terminateOwned(child, graceMs = 800) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return true;
  child.stdin?.end();
  const exited = new Promise(resolve => child.once('close', resolve));
  let timer;
  const grace = new Promise(resolve => { timer = setTimeout(resolve, graceMs); });
  await Promise.race([exited, grace]); clearTimeout(timer);
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === 'win32') {
    // PID belongs to the still-live child handle created above, never a process name/global search.
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else { try { child.kill('SIGKILL'); } catch {} }
  let finalTimer;
  await Promise.race([exited, new Promise(resolve => { finalTimer = setTimeout(resolve, 1500); })]);
  clearTimeout(finalTimer);
  return child.exitCode !== null || child.signalCode !== null;
}

async function inspectionWorkingDirectory(requested) {
  // Electron's fs can read app.asar as a virtual directory; the OS cannot chdir into it.
  // Version inspection must also remain usable when a configured workspace was moved.
  for (const candidate of [requested, os.tmpdir(), path.dirname(process.execPath)]) {
    if (typeof candidate !== 'string' || /\.asar(?:[\\/]|$)/i.test(candidate)) continue;
    try {
      const absolute = path.resolve(candidate);
      if ((await stat(absolute)).isDirectory()) return absolute;
    } catch {}
  }
  throw coded('INSPECTION_CWD_UNAVAILABLE', '没有可用于检测 Harness 的真实工作目录。');
}

async function capture(command, args, settings, home) {
  let child, output = '', diagnostic = '', failure;
  try {
    const cwd = await inspectionWorkingDirectory(settings.workspace);
    child = launch(command, args, { cwd, env: cleanEnvironment(settings, home), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { output = (output + data).slice(-32000); });
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-8000); });
    const completed = new Promise(resolve => { child.once('close', code => resolve(code)); child.once('error', error => { failure = error; resolve(-1); }); });
    let timer;
    const code = await Promise.race([completed, new Promise(resolve => { timer = setTimeout(() => resolve(-2), settings.inspectTimeoutMs ?? 8000); })]);
    clearTimeout(timer);
    return { code, output: output.trim(), diagnostic: diagnostic.trim(), failure, cwd };
  } finally {
    if (!await terminateOwned(child)) throw coded('RUNTIME_CLEANUP_FAILED', '无法确认本任务的 Harness 进程已退出，请在体检中检查。');
  }
}

/** Read-only executable/version discovery. It never copies account data or runs a model turn. */
export async function inspectRuntime(input = {}) {
  const settings = optionsFor(input);
  let home;
  try {
    home = await safeHome(settings.home);
    const found = await discover(settings);
    if (!found || !await exists(found.executable)) return { available: false, version: null, command: found?.executable ?? null, source: found?.source ?? 'not-found', detail: '尚未找到受支持的 Harness CLI，请选择已安装的 dsh 命令。', capabilities: {} };
    const result = await capture(found.executable, [...found.args, '--version'], settings, home);
    const version = result.output.match(/(?:^|\n)(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\r?\n|$)/)?.[1] ?? null;
    const compatible = result.code === 0 && version === SUPPORTED_VERSION;
    const credentialsConfigured = Boolean(settings.env?.DEEPSEEK_API_KEY) || await exists(path.join(home, '.credentials.yaml')) || await exists(path.join(home, 'credentials.yaml'));
    return {
      available: result.code === 0 && Boolean(version), version, command: found.executable, source: found.source,
      detail: compatible ? `已检测 Harness ${version}；仅对话适配可用，账号及模型仍需单独验证。` : `检测到 ${version ?? '未知版本'}，尚未通过本适配器兼容验证。`,
      home, profile: settings.profile, credentialsConfigured, ready: false, inspectionWorkingDirectory: result.cwd,
      capabilities: { compatible, protocol: 'sdk-jsonrpc-lines', text: compatible, streaming: compatible, resume: compatible, images: false, artifacts: false, mcp: false, skills: false, approval: false, cancel: 'owned-runtime-process', toolPolicy: 'conversation-only', usage: 'reported-events-only', modelVerified: false },
    };
  } catch (error) {
    return { available: false, version: null, command: settings.executable ?? null, source: 'configuration-error', detail: error.message, error: { code: error.code ?? 'INSPECTION_FAILED', message: error.message }, capabilities: {} };
  }
}

async function createPatch(home, persona) {
  const content = BLOCKED_PLUGINS.map(id => `- id: ${id}\n  disabled: true\n`).join('')
    + `- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(persona)}\n`
    + '- id: sdk-jsonrpc-server\n  config:\n    maxTokensAsSuccess: false\n';
  const directory = path.join(home, 'assistant-adapter');
  await mkdir(directory, { recursive: true });
  const relative = path.relative(await realpath(home), await realpath(directory));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw coded('PATCH_DIRECTORY_REFUSED', '运行时补丁目录不能指向产品目录外。');
  const filename = path.join(directory, `conversation-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.yml`);
  await writeFile(filename, content, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (await readFile(filename, 'utf8') !== content) throw coded('PATCH_TAMPERED', '运行时安全补丁已被修改，当前任务没有启动。');
  return filename;
}

async function verifyConversationProfile(home) {
  for (const filename of [path.join(home, 'cordis.patch.yml'), path.join(home, 'profiles', 'sdk', 'cordis.patch.yml')]) {
    if (await exists(filename)) {
      const content = (await readFile(filename, 'utf8')).replace(/^\s*#.*$/gm, '').trim();
      if (content && content !== '[]') throw coded('UNREVIEWED_PROFILE', '仅对话模式暂不加载自定义 Harness 配置；请选择新的小助手专用目录。');
    }
  }
  const manifest = path.join(home, 'profiles', 'sdk', 'package.json');
  if (await exists(manifest)) {
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    const bundles = pkg['dsh.profile']?.bundles ?? pkg.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || bundles.join(',') !== '@deepseek-ai/dsh-base,@deepseek-ai/dsh-sdk-app') {
      throw coded('UNREVIEWED_PROFILE', '此 sdk profile 含未审查的插件组合，当前只开放标准仅对话配置。');
    }
  }
}

class RuntimeWire {
  constructor(child, onNotification) {
    this.child = child; this.pending = new Map(); this.serial = 0; this.buffer = ''; this.stderr = ''; this.failure = null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      this.buffer += data;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) { this.fail(coded('PROTOCOL_LIMIT', 'Harness 返回的数据超过允许大小。')); return; }
      for (;;) {
        const index = this.buffer.indexOf('\n'); if (index < 0) break;
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.jsonrpc !== '2.0') continue;
        if (message.id !== undefined && message.method) {
          // 0.2.1 does not expose product-owned approvals: reject all unexpected requests.
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Product UI request handler unavailable' } }) + '\n');
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(coded('RUNTIME_RPC_ERROR', String(message.error.message || 'Harness 请求失败。')));
          else pending.resolve(message.result);
        } else if (message.method) {
          try { onNotification(message.method, message.params); } catch (error) { this.fail(error); }
        }
      }
    });
    child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-12000); });
    child.once('error', error => this.fail(coded('RUNTIME_START_FAILED', error.message)));
    child.once('close', code => this.fail(coded('RUNTIME_EXITED', `Harness 进程已退出（${code}）。${this.stderr ? '请检查独立运行时账号和配置。' : ''}`)));
  }
  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(method, params, timeoutMs = 15000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(coded('RUNTIME_TIMEOUT', `Harness ${method} 等待超时。`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n', error => { if (error) this.fail(coded('RUNTIME_WRITE_FAILED', '无法向 Harness 写入请求。')); });
    });
  }
}

function assistantText(event) {
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) throw coded('PROTOCOL_INVALID', 'Harness assistant/message 缺少 content。');
  return blocks.filter(block => block?.type === 'text').map(block => {
    if (typeof block.text !== 'string') throw coded('PROTOCOL_INVALID', 'Harness 返回了无效的文本块。');
    return block.text;
  }).join('');
}

function addUsage(total, sample) {
  if (!sample || typeof sample !== 'object') return total;
  const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (!Number.isFinite(sample.inputTokens) || !Number.isFinite(sample.outputTokens)) return total;
  const next = { ...(total || { source: 'provider-reported-assistant-events' }) };
  for (const key of keys) {
    if (sample[key] !== undefined && (!Number.isFinite(sample[key]) || sample[key] < 0)) return total;
    next[key] = (next[key] || 0) + (sample[key] || 0);
  }
  return next;
}

function safeDiagnostic(error, settings) {
  let message = String(error?.message || 'Harness 运行失败。').slice(0, 4000);
  for (const [key, value] of Object.entries(settings.env || {})) {
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof value === 'string' && value.length >= 3) message = message.split(value).join('[已隐藏凭据]');
  }
  return message;
}

/** One owned SDK runtime per task. A provided sessionId resumes exactly that stored session. */
export async function runTask({ prompt, workspace, sessionId, signal, onEvent, settings: input = {} } = {}) {
  const settings = optionsFor(input);
  const emit = (type, message) => { try { onEvent?.({ type, message }); } catch {} };
  const resume = Boolean(sessionId);
  let child, wire, lockKey, ownsLock = false, aborted = false, timer;
  const onAbort = () => { aborted = true; wire?.fail(coded('CANCELLED', '任务已取消。')); };
  try {
    if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 256 * 1024) throw coded('INVALID_PROMPT', '请输入有效的任务内容（不超过 256 KiB）。');
    const cwd = path.resolve(workspace || projectRoot);
    if (!(await stat(cwd)).isDirectory()) throw coded('INVALID_WORKSPACE', '工作目录不存在。');
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !/^[\w.-]{1,160}$/.test(sessionId))) throw coded('INVALID_SESSION', 'Harness 会话标识无效。');
    if (settings.profile !== 'sdk') throw coded('PROFILE_NOT_VERIFIED', '首版只允许经过验证的 sdk profile；其他 profile 需先完成工具权限适配。');
    if (signal?.aborted) throw coded('CANCELLED', '任务已取消。');
    const inspection = await inspectRuntime(settings);
    if (!inspection.available) throw coded('RUNTIME_UNAVAILABLE', inspection.detail);
    if (!inspection.capabilities.compatible) throw coded('VERSION_NOT_VERIFIED', inspection.detail);
    const home = await safeHome(settings.home, { create: true });
    await verifyConversationProfile(home);
    sessionId ||= `session-${randomUUID().replaceAll('-', '')}`;
    lockKey = `${home.toLowerCase()}:${sessionId}`;
    if (activeSessions.has(lockKey)) throw coded('SESSION_BUSY', '同一 Harness 会话已有任务正在运行。');
    activeSessions.add(lockKey);
    ownsLock = true;
    const patch = await createPatch(home, settings.persona || DEFAULT_PERSONA);
    emit('status', '正在连接小助手专用的 Harness 核心（仅对话模式）…');
    child = launch(inspection.command, [...settings.args, '--profile', settings.profile, '--patch', patch], { cwd, env: cleanEnvironment(settings, home), stdio: ['pipe', 'pipe', 'pipe'] });
    let finalText = '', usage, terminalReason, acceptingEvents = false;
    wire = new RuntimeWire(child, (method, params) => {
      if (method === 'subagent.started' && params?.parentSessionId === sessionId) throw coded('TOOL_POLICY_VIOLATION', '仅对话运行时出现未开放的子 agent，已停止本任务。');
      if (params?.sessionId !== sessionId) return;
      if (!acceptingEvents) return;
      if (method === 'session.status') emit('status', params.status === 'running' ? '小助手正在思考…' : 'Harness 已完成本轮处理。');
      if (method !== 'session.event') return;
      const event = params.event;
      if (typeof event?.type !== 'string') throw coded('PROTOCOL_INVALID', 'Harness 返回了无效事件。');
      if (event.type.startsWith('tool/')) throw coded('TOOL_POLICY_VIOLATION', '仅对话运行时出现未开放的工具事件，已停止本任务。');
      if (event.type === 'assistant/message') {
        finalText = assistantText(event); usage = addUsage(usage, event.data?.usage); emit('text', finalText);
      }
      if (event.type === 'turn/end') terminalReason = event.data?.reason;
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => wire.fail(coded('RUNTIME_TIMEOUT', '本轮 Harness 任务达到最长运行时间。')), settings.timeoutMs ?? 10 * 60 * 1000);
    const initialized = await wire.request('initialize', { cwd, provider: settings.provider || 'deepseek-official', model: settings.model || 'deepseek-flash', ...(settings.maxTokens ? { maxTokens: settings.maxTokens } : {}) }, settings.initializeTimeoutMs ?? 15000);
    if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime' || typeof initialized.serverInfo.version !== 'string') throw coded('PROTOCOL_INVALID', '运行时没有返回受支持的 SDK 身份。');
    if (resume) await wire.request('session/resume', { sessionId });
    acceptingEvents = true;
    const queued = await wire.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] });
    if (typeof queued?.messageId !== 'string') throw coded('PROTOCOL_INVALID', 'Harness 没有返回持久入队回执。');
    // session/wait includes managed descendants and orders prior events before its response.
    await wire.request('session/wait', { sessionId }, settings.timeoutMs ?? 10 * 60 * 1000);
    if (aborted) throw coded('CANCELLED', '任务已取消。');
    if (terminalReason?.kind !== 'completed') throw coded('MODEL_TURN_FAILED', `Harness 未确认本轮完成（${terminalReason?.kind || '缺少结束事件'}）。`);
    if (!finalText.trim()) throw coded('EMPTY_RESULT', 'Harness 已结束，但没有返回可交付的回答。请检查账号或模型配置。');
    emit('status', '回答已完成。');
    return { ok: true, finalText, sessionId, ...(usage ? { usage } : {}), artifacts: [] };
  } catch (error) {
    const message = safeDiagnostic(error, settings);
    emit('diagnostic', message);
    return { ok: false, finalText: '', ...(sessionId ? { sessionId } : {}), error: { code: error.code || 'RUNTIME_FAILED', message } };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if (wire && !wire.failure) await wire.request('shutdown', undefined, 700).catch(() => {});
    wire?.fail(coded('RUNTIME_CLOSED', '本任务的 Harness 已关闭。'));
    const closed = await terminateOwned(child);
    if (ownsLock) activeSessions.delete(lockKey);
    if (!closed) return { ok: false, finalText: '', ...(sessionId ? { sessionId } : {}), error: { code: 'RUNTIME_CLEANUP_FAILED', message: '无法确认本任务的 Harness 进程已退出，请检查运行时状态。' } };
  }
}

/** Start/initialize/shutdown only. No prompt is submitted and no model completion is requested. */
export async function probeRuntimeConnection(input = {}) {
  const settings = optionsFor(input);
  let child, wire;
  try {
    const inspection = await inspectRuntime(settings);
    if (!inspection.capabilities.compatible) return { ok: false, inspection, error: { code: 'RUNTIME_NOT_COMPATIBLE', message: inspection.detail } };
    if (settings.profile !== 'sdk') throw coded('PROFILE_NOT_VERIFIED', '仅验证标准 sdk profile。');
    const home = await safeHome(settings.home, { create: true });
    await verifyConversationProfile(home);
    const patch = await createPatch(home, settings.persona || DEFAULT_PERSONA);
    child = launch(inspection.command, [...settings.args, '--profile', 'sdk', '--patch', patch], { cwd: settings.workspace || projectRoot, env: cleanEnvironment(settings, home), stdio: ['pipe', 'pipe', 'pipe'] });
    wire = new RuntimeWire(child, () => {});
    const result = await wire.request('initialize', { cwd: path.resolve(settings.workspace || projectRoot), provider: settings.provider || 'deepseek-official', model: settings.model || 'deepseek-flash' }, settings.initializeTimeoutMs ?? 15000);
    if (result?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw coded('PROTOCOL_INVALID', 'Harness SDK 身份不符。');
    return { ok: true, serverInfo: result.serverInfo, version: inspection.version, home, modelCalled: false, credentialsVerified: false };
  } catch (error) {
    return { ok: false, modelCalled: false, error: { code: error.code || 'PROBE_FAILED', message: safeDiagnostic(error, settings) } };
  } finally {
    if (wire && !wire.failure) await wire.request('shutdown', undefined, 700).catch(() => {});
    wire?.fail(coded('RUNTIME_CLOSED', '协议体检完成。'));
    if (!await terminateOwned(child)) return { ok: false, modelCalled: false, error: { code: 'RUNTIME_CLEANUP_FAILED', message: '无法确认协议体检进程已退出。' } };
  }
}
