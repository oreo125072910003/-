import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindowsProtection, windowsOperation } from './windows-protection.mjs';
import { createPortableWechat } from './portable-wechat.mjs';

export const PREFIX = '/xiaozhushou';
export const SERVICE_METHODS = Object.freeze([
  'getBootstrap','listTasks','getTask','getTaskReplyText','createTask','cancelTask','getSettings','saveSettings','getWorkflowsState','exportTaskDocument',
  'getWechatState','saveWechatSettings','connectWechat','disconnectWechat','draftWechatReply','sendWechatReply','searchWechatContacts','refreshWechatProfile',
  'getWechatSessions','getWechatHistory','resolveWechatImage','getWechatStickers','sendWechatMessage','sendWechatSticker','sendWechatAttachment','importLegacyExtensions','refreshDshCatalog',
  'getMailState','saveMailNotifications','importMailAccounts','syncMail','getMailMessage','createMailDraft','sendMailDraft','resolveMailAttachment','draftMailReply',
  'getDshAccessState','refreshDshAccessCatalog','saveDshOwnerGrants','setDesktopComputerAccess','restoreProductFeatures',
  'getWechatDshAccess','saveWechatDshGrants','importWechatDshGrants','saveWechatComputerAccess',
  'getExtensionsState','configureSelfImprovement','proposeSelfImprovement','installBuiltinMcp','enableMcp','disableMcp','testMcp','setMcpTools','importBundledSkill','enableSkill','disableSkill'
]);
export const NATIVE_METHODS = Object.freeze(['pickAttachments','pickWechatAttachments','importWechatConnection','importMailAccountsFile','importMcpManifest','importSkill','openArtifact','openWorkspace','openContract','saveMailAttachment',
  'getPortableWechatState','preparePortableWechat','openPortableWechat','discoverPortableWechat','bindPortableWechat']);
const fault = (message, status = 400) => Object.assign(Error(message), { status });
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const baseURL = new URL('./', import.meta.url);
export const payloadRoot = fileURLToPath(fs.existsSync(new URL('./payload/', baseURL)) ? new URL('./payload/', baseURL) : new URL('../../', baseURL));
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function authorize(req, port) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) throw fault('小助手仅接受本机连接。', 403);
  const host = req.headers.host;
  if (!['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port].includes(host)) throw fault('访问地址未通过核验。', 403);
  const origin = req.headers.origin;
  const origins = new Set(['http://' + host, 'https://' + host, 'dsh-app://app']);
  if (origin && !origins.has(origin)) throw fault('此页面无权访问小助手。', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw fault('不接受其他网站发起的请求。', 403);
  if (req.method === 'POST' && (req.headers['x-xiaozhushou-ui'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json')) throw fault('请求未通过界面核验。', 403);
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw fault('请求内容过大。', 413); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('请求格式无效。'); }
  if (!Array.isArray(value) || value.length > 8) throw fault('请求参数无效。');
  return value;
}
function readJsonFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw fault('请选择 64 KB 以内的普通 JSON 文件。');
  return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
}
async function openLocal(filename, spawnImpl) {
  if (!path.isAbsolute(filename) || !fs.existsSync(filename)) throw fault('目标文件或目录不存在。');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
  await new Promise((resolve, reject) => { const child = spawnImpl(executable, [filename], { windowsHide: true, stdio: 'ignore' }); child.once('spawn', () => { child.unref(); resolve(); }); child.once('error', reject); });
  return { opened: true };
}

/** Run the existing product service inside DSH. No second assistant process. */
export async function createNativeAssistant(ctx, config, overrides = {}) {
  const dataDir = fs.realpathSync(config.productDataRoot);
  const runtime = overrides.runtime || await import(new URL('./payload/packages/runtime-harness/index.mjs', baseURL).href);
  const createService = overrides.createService || (await import(new URL('./payload/apps/service/index.mjs', baseURL).href)).createAssistantService;
  const createSecretStore = overrides.createSecretStore || (await import(new URL('./payload/apps/desktop/secret-store.cjs', baseURL).href)).default.createSecretStore;
  const secretStore = overrides.secretStore || createSecretStore({ dataDir, safeStorage: createWindowsProtection({ dataDir }) });
  const operate = overrides.operate || windowsOperation, spawnImpl = overrides.spawnImpl || spawn;
  const source = config.wechatSourceDirectory;
  if (source && (!path.isAbsolute(source) || !fs.statSync(source).isDirectory())) throw fault('微信环境目录不存在。');
  const contract = path.join(fileURLToPath(baseURL), 'contract-resource/合同填写小助手.exe');
  const contractMcp = path.join(path.dirname(contract), '合同助手MCP.exe');
  const hasContract = fs.existsSync(contract) && fs.existsSync(contractMcp);
  const legacySources = [...(source ? [{ id: 'wechatagent', name: '原有微信环境', kind: 'wechatagent', path: source }] : []),
    { id: 'portable-wechat', name: '插件内置微信', kind: 'wechatagent', path: path.join(dataDir, 'wechat-environment') },
    { id: 'personal-skills', name: '个人技能', kind: 'skills', path: path.join(os.homedir(), '.codex/skills') },
    { id: 'agents-skills', name: '共享技能', kind: 'skills', path: path.join(os.homedir(), '.agents/skills') },
    { id: 'dsh-profile', name: 'DSH 插件', kind: 'dsh-profile', path: path.join(os.homedir(), '.dsh/profiles/desktop') }];
  let service, starting, closed = false, revision = 0, state = 'waiting', lastError = '', offChange;
  const portable = createPortableWechat({ packageRoot: fileURLToPath(baseURL), payloadRoot, dataDir, onChange: () => { revision++; } });
  async function start() {
    if (closed) throw fault('小助手插件正在关闭。', 503);
    if (service) return service;
    if (starting) return starting;
    state = 'starting';
    starting = (async () => {
      const created = await createService({ dataDir, runtime, secretStore, legacySources, contractAvailable: hasContract,
        builtinMcp: hasContract ? [{ id: 'contract-helper', name: '合同助手', version: '2.3.0-preview.0.2.0', source: 'bundled-synthetic-contract', transport: 'stdio', command: contractMcp,
          args: ['--data-dir', path.join(dataDir, 'contract'), '--output-dir', path.join(dataDir, 'contract/成果')], allowedTools: ['get_contract_schema','preview_contract','generate_contract'], permissions: ['contract.read','contract.generate'] }] : [] });
      if (closed) { await created.close(); throw fault('小助手插件已经关闭。', 503); }
      service = created; state = 'running'; lastError = ''; revision++;
      offChange = service.onChange(() => { revision++; });
      // Only previously enabled connections resume. Never broaden reply scope.
      void service.resumeWechatOnStartup().catch(() => { revision++; });
      return service;
    })().catch(error => { state = 'waiting'; lastError = error.message; revision++; throw error; }).finally(() => { starting = null; });
    return starting;
  }
  async function picker(kind, title, extra = {}) { return operate('dialog', { kind, title, ...extra }); }
  async function nativeCall(name, args, current) {
    if (name === 'getPortableWechatState') return { ...portable.status(), connectionImported: (await current.getWechatState()).settings.connectionImported };
    if (name === 'preparePortableWechat') return portable.prepare();
    if (name === 'openPortableWechat') return portable.open();
    if (name === 'discoverPortableWechat') return portable.discover();
    if (name === 'bindPortableWechat') return portable.bind(args[0], current);
    if (name === 'pickAttachments' || name === 'pickWechatAttachments') {
      const wechat = name === 'pickWechatAttachments', mediaType = args[0]?.mediaType;
      if (wechat && !['image','file'].includes(mediaType)) throw fault('请选择图片或文件。');
      const chosen = await picker('files', wechat ? '选择要发到微信的附件' : '添加任务资料', { multiple: !wechat });
      if (!chosen) return [];
      const files = Array.isArray(chosen) ? chosen : [chosen];
      if (!files.length || files.length > (wechat ? 1 : 20)) throw fault('选择的附件数量超出限制。');
      const selected = files.map(filename => { const stat = fs.lstatSync(filename); if (!path.isAbsolute(filename) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw fault('请选择 16 MB 以内的普通文件。'); return { name: path.basename(filename), path: filename, size: stat.size }; });
      if (wechat) { current.grantWechatAttachments(files); return [await current.stageWechatAttachment({ path: files[0], mediaType })]; }
      current.grantAttachments(files); return selected;
    }
    if (name === 'importWechatConnection') {
      const directory = await picker('directory', '选择原微信环境（包含 config 和 state）', { initial: source });
      return directory ? current.importWechatConnection(directory, { automatic: true }) : null;
    }
    if (name === 'importSkill') { const directory = await picker('directory', '选择包含 SKILL.md 的技能文件夹'); return directory ? current.importSkill(directory) : null; }
    if (name === 'importMailAccountsFile' || name === 'importMcpManifest') {
      const chosen = await picker('files', name === 'importMailAccountsFile' ? '导入邮箱账号 JSON' : '导入 MCP 插件 JSON');
      if (!chosen) return null;
      const text = readJsonFile(Array.isArray(chosen) ? chosen[0] : chosen);
      return name === 'importMailAccountsFile' ? current.importMailAccounts(text) : current.installMcp(JSON.parse(text));
    }
    if (name === 'openArtifact') return openLocal(current.resolveArtifact(args[0]), spawnImpl);
    if (name === 'openWorkspace') return openLocal(current.resolveWorkspace(args[0]), spawnImpl);
    if (name === 'openContract') {
      if (!hasContract) throw fault('当前插件包未包含合同工具。');
      await new Promise((resolve, reject) => { const child = spawnImpl(contract, ['--data-dir', path.join(dataDir, 'contract')], { cwd: path.dirname(contract), windowsHide: false, stdio: 'ignore' }); child.once('spawn', () => { child.unref(); resolve(); }); child.once('error', reject); });
      return { opened: true };
    }
    if (name === 'saveMailAttachment') {
      const item = current.resolveMailAttachment(args[0]);
      const filename = await picker('save', '另存邮件附件', { filename: path.basename(item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')) || '附件' });
      if (!filename) return null;
      const content = fs.readFileSync(item.path);
      if (content.length !== item.size || createHash('sha256').update(content).digest('hex') !== item.sha256) throw fault('附件已变化，请重新读取。');
      fs.writeFileSync(filename, content); return { saved: true, path: filename, name: path.basename(filename), size: content.length };
    }
    throw fault('没有这个界面操作。', 404);
  }
  const assets = {
    '/': ['text/html; charset=utf-8', () => fs.readFileSync(path.join(payloadRoot, 'apps/desktop/renderer/index.html'), 'utf8').replace("connect-src 'none'", "connect-src 'self'").replace('</head>', '<link rel="stylesheet" href="./setup.css" /></head>').replace('</body>', '<script type="module" src="./setup-ui.js"></script></body>').replace('<script type="module" src="./app.js">', '<script src="./browser.js"></script><script type="module" src="./app.js">')],
    '/setup-ui.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(new URL('./setup-ui.js', baseURL))],
    '/setup.css': ['text/css; charset=utf-8', () => fs.readFileSync(new URL('./setup.css', baseURL))],
    '/browser.js': ['text/javascript; charset=utf-8', () => fs.readFileSync(new URL('./browser.js', baseURL), 'utf8').replace('METHODS_PLACEHOLDER', JSON.stringify([...SERVICE_METHODS, ...NATIVE_METHODS]))],
    ...Object.fromEntries(['app.js','styles.css','workspace-theme.css'].map(name => ['/' + name, [name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', () => fs.readFileSync(path.join(payloadRoot, 'apps/desktop/renderer', name))]]))
  };
  async function handler(req, res) {
    try {
      authorize(req, ctx.webServer.port);
      const route = (req.url || '').split('?')[0].slice(PREFIX.length);
      if (route === '' && req.method === 'GET') { res.writeHead(302, { Location: PREFIX + '/' }); return res.end(); }
      if (route === '/state' && req.method === 'GET') return json(res, 200, { state, revision, error: lastError, core: 'dsh', standaloneAssistant: false });
      if (req.method === 'GET' && Object.hasOwn(assets, route)) {
        const [contentType, read] = assets[route];
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); return res.end(read());
      }
      if (req.method !== 'POST' || !route.startsWith('/rpc/')) throw fault('没有这个小助手入口。', 404);
      const method = route.slice(5);
      if (![...SERVICE_METHODS, ...NATIVE_METHODS].includes(method)) throw fault('这个操作未向界面开放。', 404);
      const args = await body(req), current = await start();
      const value = NATIVE_METHODS.includes(method) ? await nativeCall(method, args, current) : await current[method](...args);
      return json(res, 200, { ok: true, value: value ?? null });
    } catch (error) { if (!res.headersSent) json(res, error.status || 400, { ok: false, error: error.message }); else res.end(); }
  }
  const unregister = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler });
  return {
    start, handler,
    async close() { closed = true; unregister?.(); await portable.close(); await starting?.catch(() => {}); offChange?.(); await service?.close(); },
    status: () => ({ state, revision, error: lastError })
  };
}
