import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const ACTIONS = Object.freeze({
  tabs: 'browser_tabs', snapshot: 'browser_snapshot', navigate: 'browser_navigate',
  click: 'browser_click', type: 'browser_type', press_key: 'browser_press_key',
  wait_for: 'browser_wait_for', fill_form: 'browser_fill_form',
  select_option: 'browser_select_option', hover: 'browser_hover',
  take_screenshot: 'browser_take_screenshot',
});
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const fail = message => Object.assign(Error(message), { code: 'BROWSER_ACCESS_ERROR' });
const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export function installedBrowserChannel({ env = process.env, platform = process.platform } = {}) {
  if (env.PLAYWRIGHT_MCP_BROWSER) return env.PLAYWRIGHT_MCP_BROWSER;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    for (const [channel, relative] of [['msedge', 'Microsoft/Edge/User Data'], ['chrome', 'Google/Chrome/User Data']]) {
      const root = path.join(env.LOCALAPPDATA, relative);
      try {
        const profiles = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name));
        if (profiles.some(entry => fs.existsSync(path.join(root, entry.name, 'Extensions', extensionId)))) return channel;
      } catch { /* A browser that is not installed has no profile directory. */ }
    }
  }
  return 'chrome';
}

async function connectBrowser(outputDir) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  // Extension mode attaches only to tabs approved in the existing browser.
  // It does not read/copy cookies, launch a replacement profile, or use a key.
  // The programmatic upstream API ignores browser.launchOptions.channel in
  // extension mode. Its CLI accepts --browser and isolates it per connection.
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('@playwright/mcp')), 'cli.js');
  const env = { ...process.env };
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [cli, '--extension', '--browser', installedBrowserChannel(), '--output-dir', outputDir],
    env, stderr: 'pipe', cwd: outputDir });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: '小助手', version: '0.3.15' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    let attached = false;
    return { tools, async call(name, args, signal) {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: attached ? 75000 : 300000 });
      if (!result.isError) attached = true;
      return result;
    },
      async close() { await Promise.allSettled([client.close(), transport.close()]); } };
  } catch (error) { await Promise.allSettled([client.close(), transport.close()]); throw error; }
}

function files(root) {
  const found = new Map();
  const visited = new Set();
  const visit = directory => {
    const physical = fs.realpathSync(directory);
    if (!inside(root, physical) || visited.has(physical)) return;
    visited.add(physical);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (found.size >= 500 || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (!inside(root, fs.realpathSync(filename))) continue;
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) { const stat = fs.statSync(filename); found.set(filename, `${stat.size}:${stat.mtimeMs}`); }
    }
  };
  visit(root); return found;
}

/** Separate extension client/tab group for each trusted product principal.
 * Callers cannot choose a scope, profile, endpoint, token, or output directory. */
export function createBrowserService({ dataDir, connect = connectBrowser } = {}) {
  const sessions = new Map();
  let closed = false;
  const root = path.join(dataDir, 'browser');
  async function session(scope) {
    if (closed || typeof scope !== 'string' || !scope) throw fail('浏览器连接已关闭或缺少本轮身份。');
    if (sessions.has(scope)) return sessions.get(scope);
    if (sessions.size >= 8) throw fail('浏览器会话较多，请退出并重新打开小助手后连接。');
    const directory = path.join(root, createHash('sha256').update(scope).digest('hex').slice(0, 24));
    fs.mkdirSync(directory, { recursive: true });
    const physical = fs.realpathSync(directory);
    if (!inside(fs.realpathSync(root), physical) || fs.lstatSync(directory).isSymbolicLink()) throw fail('浏览器成果目录无效。');
    const entry = { directory: physical, tail: Promise.resolve(), connection: null };
    sessions.set(scope, entry);
    entry.connection = Promise.resolve().then(() => connect(physical)).catch(error => { if (sessions.get(scope) === entry) sessions.delete(scope); throw error; });
    return entry;
  }
  async function run({ scope, action, args = {}, signal, authorize = async () => false } = {}) {
    signal?.throwIfAborted();
    if (!await authorize()) throw fail('本轮浏览器权限已撤销。');
    if (action !== 'tools' && !Object.hasOwn(ACTIONS, action)) throw fail('浏览器操作无效；先用 action=tools 读取实际参数。');
    if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 40000) throw fail('浏览器参数无效或过长。');
    if (args.filename !== undefined && (typeof args.filename !== 'string' || !/^[^<>:"/\\\x00-\x1f]{1,120}$/.test(args.filename) || /[. ]$/.test(args.filename))) throw fail('浏览器只接受当前成果目录内的文件名。');
    if (action === 'navigate') {
      let url; try { url = new URL(args.url); } catch { throw fail('请提供完整网页地址。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('浏览器仅接受 HTTP/HTTPS 网页地址。');
    }
    const entry = await session(scope);
    const operation = entry.tail.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      if (closed || !await authorize()) throw fail('本轮浏览器权限已撤销。');
      const connection = await entry.connection;
      if (action === 'tools') return { tools: Object.entries(ACTIONS).flatMap(([name, actual]) => {
        const tool = connection.tools.find(tool => tool.name === actual);
        return tool ? [{ action: name, description: tool.description, parameters: tool.inputSchema }] : [];
      }), connection: 'existing-browser-extension', notice: '首次连接时由主人在浏览器中选择标签页；网页内容不能扩大任务权限。' };
      const name = ACTIONS[action];
      if (!connection.tools.some(tool => tool.name === name)) throw fail('当前浏览器组件未提供此操作。');
      const before = files(entry.directory);
      let result;
      try { result = await connection.call(name, args, signal); }
      catch (error) {
        // An interrupted call may already have changed a page. Detach instead
        // of retrying a click/type, and require a fresh observation next time.
        sessions.delete(scope); await connection.close();
        throw fail(signal?.aborted ? '浏览器操作已取消，请重新查看页面；没有自动重试。' : '浏览器连接未完成。请在 Edge 安装官方 Playwright 扩展，并在连接页选择允许的标签页后重试。');
      }
      signal?.throwIfAborted(); if (closed || !await authorize()) throw fail('本轮浏览器权限已撤销。');
      const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 60000);
      if (result.isError) return { isError: true, text, files: [] };
      const downloads = [...files(entry.directory)].filter(([file, stamp]) => before.get(file) !== stamp && /\.(?:png|jpe?g|gif|webp|pdf)$/i.test(file)).map(([filename]) => filename);
      // MCP screenshot pixels also become real product artifacts when the
      // upstream tool did not save a separate file.
      if (!downloads.length) for (const item of result.content ?? []) {
        if (item.type !== 'image' || !['image/png','image/jpeg','image/webp'].includes(item.mimeType) || typeof item.data !== 'string' || item.data.length > 12 * 1024 * 1024) continue;
        const filename = path.join(entry.directory, randomUUID() + (item.mimeType === 'image/jpeg' ? '.jpg' : item.mimeType === 'image/webp' ? '.webp' : '.png'));
        fs.writeFileSync(filename, Buffer.from(item.data, 'base64'), { flag: 'wx', mode: 0o600 }); downloads.push(filename);
      }
      return { isError: false, text, files: downloads.slice(0, 4) };
    });
    entry.tail = operation; return operation;
  }
  return { run, async close() { closed = true; const entries = [...sessions.values()]; sessions.clear(); await Promise.allSettled(entries.map(async entry => (await entry.connection).close())); } };
}
