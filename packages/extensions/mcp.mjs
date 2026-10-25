import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ExtensionError, fail, boundedJson, object, text } from './common.mjs';
import { validateSchema } from './schema.mjs';

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const MCP_LIMITS = Object.freeze({ messageBytes: 1024 * 1024, requestBytes: 256 * 1024, stderrBytes: 16 * 1024, tools: 256, pages: 16, pending: 32 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Product connection diagnostics/tool gateway only; does not replace Harness. */
export class StdioMcpClient extends EventEmitter {
  #process; #pending = new Map(); #nextId = 1; #decoder = new TextDecoder('utf-8', { fatal: true }); #buffer = ''; #bufferBytes = 0; #stderrBytes = 0; #closePromise; #tools = new Map(); #state = 'new';
  constructor({ command, args = [], cwd, env, timeoutMs = 10000, limits = {} }) { super(); this.config = { command, args, cwd, env }; this.timeoutMs = Math.min(120000, Math.max(100, timeoutMs)); this.limits = { ...MCP_LIMITS, ...limits }; }
  get state() { return this.#state; }
  get pid() { return this.#process?.pid; }
  get toolCount() { return this.#tools.size; }
  async connect() {
    if (this.#state !== 'new') fail('LIFECYCLE', 'MCP 连接不能重复启动。');
    this.#state = 'initializing';
    const child = spawn(this.config.command, this.config.args, { cwd: this.config.cwd, env: this.config.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.#process = child;
    child.once('error', () => this.#break(new ExtensionError('SPAWN_FAILED', '无法启动已配置的 MCP 程序。')));
    child.once('exit', (code, signal) => { this.exit = { code, signal }; if (this.#state !== 'closing' && this.#state !== 'closed') this.#break(new ExtensionError('CONNECTION_CLOSED', 'MCP 程序已退出，调用结果可能未知。')); });
    child.stdin.on('error', () => this.#break(new ExtensionError('CONNECTION_CLOSED', 'MCP 输入流已关闭。')));
    child.stdout.on('data', chunk => this.#receive(chunk));
    child.stdout.on('error', () => this.#break(new ExtensionError('CONNECTION_CLOSED', 'MCP 输出流已关闭。')));
    // Diagnostic byte counts only: stderr may contain credentials and is never persisted.
    child.stderr.on('data', chunk => { this.#stderrBytes = Math.min(this.limits.stderrBytes, this.#stderrBytes + chunk.length); });
    try {
      const result = await this.#request('initialize', { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'xiaozhushou-extension-gateway', version: '0.1.0' } });
      object(result, 'MCP 初始化结果');
      if (!MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion)) fail('UNSUPPORTED_PROTOCOL', 'MCP 服务器选择了尚未验收的协议版本。');
      object(result.capabilities, 'MCP 能力'); object(result.serverInfo, 'MCP 服务信息');
      this.protocolVersion = result.protocolVersion; this.serverInfo = { name: text(result.serverInfo.name, '服务名称', 200), version: text(result.serverInfo.version, '服务版本', 100) }; this.capabilities = result.capabilities;
      // Server instructions are untrusted and intentionally excluded from model context.
      this.#write({ jsonrpc: '2.0', method: 'notifications/initialized' }); this.#state = 'ready';
      const tools = await this.listTools();
      return { protocolVersion: this.protocolVersion, serverInfo: this.serverInfo, tools, stderrBytes: this.#stderrBytes, processIsolation: 'trusted-process-no-os-sandbox' };
    } catch (error) { await this.close(); throw error; }
  }
  #write(message) {
    if (!this.#process?.stdin.writable) fail('CONNECTION_CLOSED', 'MCP 输入流不可写。');
    const json = boundedJson(message, this.limits.requestBytes);
    if (this.#process.stdin.writableLength + Buffer.byteLength(json) > this.limits.requestBytes * 2) fail('BACKPRESSURE', 'MCP 程序读取请求过慢。');
    this.#process.stdin.write(json + '\n');
  }
  #receive(chunk) {
    if (['closing', 'closed', 'failed'].includes(this.#state)) return;
    this.#bufferBytes += chunk.length;
    if (this.#bufferBytes > this.limits.messageBytes && !chunk.includes(10)) { this.#break(new ExtensionError('MESSAGE_TOO_LARGE', 'MCP 返回消息超过大小限制。')); return; }
    try { this.#buffer += this.#decoder.decode(chunk, { stream: true }); } catch { this.#break(new ExtensionError('INVALID_PROTOCOL', 'MCP 返回了无效 UTF-8 消息。')); return; }
    for (;;) {
      const newline = this.#buffer.indexOf('\n'); if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, ''); this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.limits.messageBytes) { this.#break(new ExtensionError('MESSAGE_TOO_LARGE', 'MCP 返回消息超过大小限制。')); return; }
      if (!line.trim()) { this.#break(new ExtensionError('INVALID_PROTOCOL', 'MCP 标准输出包含空消息。')); return; }
      try { this.#dispatch(JSON.parse(line)); } catch (error) { this.#break(error instanceof ExtensionError ? error : new ExtensionError('INVALID_PROTOCOL', 'MCP 返回了无效 JSON 消息。')); return; }
      if (['failed', 'closing', 'closed'].includes(this.#state)) return;
    }
    this.#bufferBytes = Buffer.byteLength(this.#buffer);
    if (this.#bufferBytes > this.limits.messageBytes) this.#break(new ExtensionError('MESSAGE_TOO_LARGE', 'MCP 返回消息超过大小限制。'));
  }
  #dispatch(message) {
    object(message, 'MCP 消息'); if (message.jsonrpc !== '2.0' || Array.isArray(message)) fail('INVALID_PROTOCOL', 'MCP 消息协议无效。');
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id') && message.method === 'ping') this.#write({ jsonrpc: '2.0', id: message.id, result: {} });
      else if (Object.hasOwn(message, 'id')) this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability not supported' } });
      else if (this.#state === 'ready' && message.method === 'notifications/tools/list_changed') { this.#tools.clear(); this.emit('toolsChanged'); }
      return;
    }
    if (!Object.hasOwn(message, 'id') || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) fail('INVALID_PROTOCOL', 'MCP 响应缺少编号或结果。');
    const pending = this.#pending.get(message.id); if (!pending) return; // Late response after timeout/cancel.
    this.#pending.delete(message.id); pending.dispose();
    if (message.error !== undefined) pending.reject(new ExtensionError('MCP_PROTOCOL_ERROR', 'MCP 服务器拒绝了请求。', { rpcCode: typeof message.error?.code === 'number' ? message.error.code : undefined }));
    else pending.resolve(message.result);
  }
  #request(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (!['initializing', 'ready'].includes(this.#state)) return Promise.reject(new ExtensionError('CONNECTION_CLOSED', 'MCP 尚未连接。'));
    if (this.#pending.size >= this.limits.pending) return Promise.reject(new ExtensionError('TOO_MANY_REQUESTS', 'MCP 同时调用数量过多。'));
    if (signal?.aborted) return Promise.reject(new ExtensionError('CANCELLED', 'MCP 调用已取消。'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const stop = code => { if (!this.#pending.has(id)) return; this.#pending.delete(id); dispose(); try { this.#write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: code } }); } catch {} reject(new ExtensionError(code, code === 'CANCELLED' ? '已请求取消 MCP 调用；外部副作用可能无法撤回。' : 'MCP 调用超时；外部结果可能未知。')); };
      const timer = setTimeout(() => stop('TIMEOUT'), Math.min(120000, Math.max(100, timeoutMs)));
      const abort = () => stop('CANCELLED'); const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.#pending.set(id, { resolve, reject, dispose }); signal?.addEventListener('abort', abort, { once: true });
      try { this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }); } catch (error) { this.#pending.delete(id); dispose(); reject(error); }
    });
  }
  #break(error) {
    if (['closing', 'closed', 'failed'].includes(this.#state)) return;
    this.#state = 'failed'; for (const pending of this.#pending.values()) { pending.dispose(); pending.reject(error); } this.#pending.clear(); this.#tools.clear(); this.emit('diagnostic', { code: error.code ?? 'CONNECTION_FAILED' });
    void this.close();
  }
  async listTools(options = {}) {
    if (this.#state !== 'ready') fail('CONNECTION_CLOSED', 'MCP 尚未就绪。');
    if (!this.capabilities.tools) { this.#tools.clear(); return []; }
    const tools = new Map(); let cursor; const cursors = new Set();
    for (let page = 0; page < this.limits.pages; page++) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {}, options); object(result, '工具清单');
      if (!Array.isArray(result.tools) || result.tools.length + tools.size > this.limits.tools) fail('INVALID_TOOLS', 'MCP 工具清单数量无效。');
      for (const entry of result.tools) {
        object(entry, '工具'); const name = text(entry.name, '工具名称', 128); if (!/^[\w.-]+$/.test(name) || tools.has(name)) fail('INVALID_TOOLS', 'MCP 工具名称无效或重复。');
        const tool = { name, description: typeof entry.description === 'string' ? entry.description.slice(0, 4000) : '', inputSchema: entry.inputSchema, available: true };
        try { object(entry.inputSchema, '工具参数结构'); if (entry.inputSchema.type !== 'object') fail('SCHEMA_UNSUPPORTED', '工具顶层参数必须是对象。'); validateSchema(entry.inputSchema, undefined, { schemaOnly: true }); } catch (error) { tool.available = false; tool.reason = error.code ?? 'INVALID_SCHEMA'; }
        tools.set(name, tool);
      }
      if (!result.nextCursor) { this.#tools = tools; return [...tools.values()]; }
      cursor = text(result.nextCursor, '分页游标', 4096); if (cursors.has(cursor)) fail('INVALID_TOOLS', 'MCP 工具分页游标重复。'); cursors.add(cursor);
    }
    fail('TOO_MANY_PAGES', 'MCP 工具分页超过限制。');
  }
  async callTool(name, args = {}, options = {}) {
    if (!this.#tools.size && this.capabilities?.tools) await this.listTools(options);
    const tool = this.#tools.get(name); if (!tool) fail('TOOL_NOT_FOUND', '工具不在已验证清单中。');
    if (!tool.available) fail('SCHEMA_UNSUPPORTED', '工具参数规则尚未支持，不能跳过校验调用。');
    object(args, '工具参数'); boundedJson(args, this.limits.requestBytes - 1024); validateSchema(tool.inputSchema, args);
    try {
      const result = await this.#request('tools/call', { name, arguments: args }, options); object(result, '工具结果');
      const contentTypes = new Set(['text', 'image', 'audio', 'resource', 'resource_link']);
      if (!Array.isArray(result.content) || result.content.length > 256 || result.content.some(item => !item || typeof item !== 'object' || !contentTypes.has(item.type) || item.type === 'text' && typeof item.text !== 'string')) fail('INVALID_RESULT', 'MCP 工具返回的内容结构无效。');
      if (result.isError !== undefined && typeof result.isError !== 'boolean') fail('INVALID_RESULT', 'MCP 工具业务状态无效。');
      const ok = result.isError !== true;
      return { ok, errorCode: ok ? null : 'MCP_TOOL_ERROR', retryable: false, content: result.content, ...(result.structuredContent === undefined ? {} : { data: result.structuredContent }), sideEffects: 'unverified', source: { transport: 'stdio', server: this.serverInfo, tool: name } };
    } catch (error) { return { ok: false, errorCode: error.code ?? 'MCP_FAILED', retryable: false, summary: error instanceof ExtensionError ? error.message : 'MCP 调用失败。', sideEffects: ['TIMEOUT', 'CANCELLED', 'CONNECTION_CLOSED'].includes(error.code) ? 'unknown' : 'unverified' }; }
  }
  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#stop(); return this.#closePromise;
  }
  async #stop() {
    this.#state = 'closing'; for (const pending of this.#pending.values()) { pending.dispose(); pending.reject(new ExtensionError('CONNECTION_CLOSED', 'MCP 连接已停止；尚未回执的外部结果未知。')); } this.#pending.clear(); this.#tools.clear();
    const child = this.#process;
    if (!child || !child.pid) { this.#state = 'closed'; return { exited: true }; }
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (!exited()) { child.stdin.end(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(300)]); }
    if (!exited()) {
      if (process.platform === 'win32') {
        // Kill only the PID spawned and still retained by this connection.
        await new Promise(resolve => { const killer = spawn(process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : 'taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }); const timer = setTimeout(() => { killer.kill(); resolve(); }, 3000); killer.once('exit', () => { clearTimeout(timer); resolve(); }); killer.once('error', () => { clearTimeout(timer); resolve(); }); });
        // taskkill's process-tree query can stall when Windows management is
        // unavailable. The retained child handle still identifies our process.
        if (!exited()) child.kill('SIGKILL');
      } else child.kill('SIGKILL');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    this.#state = 'closed'; if (!exited()) fail('STOP_FAILED', '尚未确认 MCP 自有进程退出。'); return { exited: true };
  }
}
