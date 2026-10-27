import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
const write = (filename, value) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); const temporary = filename + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, filename); };
const inside = (root, relative) => { const target = path.resolve(root, relative), diff = path.relative(root, target); if (!diff || diff.startsWith('..') || path.isAbsolute(diff)) throw Error('组件文件路径无效。'); return target; };
async function unusedPort() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function setupFailure(error) {
  const text = String(error?.message || '');
  if (/[\u3400-\u9fff]/.test(text)) return text.slice(0, 600);
  return ({
    WECHAT_OTHER_CLIENT_RUNNING: '检测到另一个版本的微信。请从微信托盘正常退出，再点击打开微信。',
    WECHAT_CLIENT_VERSION_MISMATCH: '专用微信版本不匹配，请重新准备完整包中的微信组件。',
    WECHAT_CLIENT_SIGNATURE_INVALID: '微信程序签名核验未通过，请重新复制完整包。',
    WECHAT_CLIENT_HEALTH_TIMEOUT: '专用微信仍未就绪，请检查微信窗口后重试。',
    HOOK_ACCOUNT_MISMATCH: '所选账号与专用微信当前登录的账号不一致，原配置已保留。请重新选择账号。',
    HOOK_MULTIPLE_ACCOUNT_DATABASES: '专用微信同时打开了多个账号，请正常退出微信，再只登录需要连接的账号。',
    HOOK_LOGIN_REQUIRED: '请先在专用微信完成登录，等待同步后重试。',
    HOOK_NOT_LISTENING: '专用微信连接组件尚未就绪，请先打开专用微信。'
  })[error?.code || text] || '微信准备未完成，请检查专用微信的登录和同步状态，再重试。';
}

export function createPortableWechat({ packageRoot, payloadRoot, dataDir, onChange = () => {}, dependencies = {} }) {
  const bundle = path.join(packageRoot, 'companions'), manifestFile = path.join(bundle, 'manifest.json');
  const root = path.join(dataDir, 'wechat-environment'), marker = path.join(root, '.xiaozhushou-portable-wechat');
  const available = fs.existsSync(manifestFile), controller = new AbortController();
  let job, pending, accounts = [], closed = false;
  const status = () => ({ available, prepared: fs.existsSync(marker), accountConfigured: fs.existsSync(path.join(root, 'state/weflow/WeFlow-config.json')),
    ...(job ? { job: { ...job } } : {}), accounts: accounts.map(({ id, myWxid, ready }) => ({ id, name: myWxid, ready })) });
  function startJob(kind, operation) {
    if (!available) throw Error('这个轻量包没有专用微信组件，请安装完整版，或导入已有微信连接。');
    if (closed) throw Error('插件正在退出。');
    if (pending) throw Error('上一步仍在处理，请等待完成。');
    job = { id: randomUUID(), kind, state: 'running', message: '正在处理…' }; onChange();
    const progress = message => { job.message = String(message).slice(0, 600); onChange(); };
    pending = Promise.resolve().then(() => operation(progress)).then(() => { job.state = 'succeeded'; }, error => { job.state = 'failed'; job.message = setupFailure(error); const code = error?.code || error?.message; if (/^[A-Z][A-Z0-9_]+$/.test(code || '')) job.code = code; }).finally(() => { pending = null; onChange(); });
    return status();
  }
  async function setupRunner(request, progress) {
    const config = read(path.join(root, 'config/wechatagent.json'));
    const { runReaderSetup } = dependencies.runReaderSetup ? dependencies : await import(pathToFileURL(path.join(payloadRoot, '代码/项目/scripts/reader-setup.mjs')).href);
    const result = await runReaderSetup({ root, python: config.runtime.python, request, onProgress: progress, signal: controller.signal });
    if (!result?.ok) {
      const { readerSetupMessage } = await import(pathToFileURL(path.join(payloadRoot, '代码/项目/scripts/reader-setup.mjs')).href);
      throw Error(readerSetupMessage(result?.code));
    }
    return result;
  }
  async function prepare(progress) {
    if (fs.existsSync(marker)) { progress('专用微信已准备好，可继续打开和登录。'); return; }
    if (fs.existsSync(root)) throw Error('微信组件目录已存在但未完成核验，原目录保留。请检查后重试。');
    const manifest = read(manifestFile);
    if (manifest.schemaVersion !== 1 || manifest.clientVersion !== '4.1.10.27' || !Array.isArray(manifest.files)) throw Error('微信组件清单无效。');
    const temporary = path.join(dataDir, 'wechat-environment.setup-' + randomUUID()); fs.mkdirSync(temporary);
    try {
      let index = 0;
      for (const item of manifest.files) {
        controller.signal.throwIfAborted();
        if (!/^(wechat-client|python|reader)\//.test(item.path) || /(?:^|\/)(?:state|config|logs|__pycache__)(?:\/|$)|\.token$|wechatagent-hook\.token/.test(item.path)) throw Error('微信组件清单包含运行数据。');
        const source = inside(bundle, item.path), stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== item.sha256) throw Error('微信组件校验失败，请重新复制完整版。');
        const relative = item.path.startsWith('wechat-client/') ? 'state/hook/wechat-4.1.10.27/' + item.path.slice(14) : item.path.startsWith('reader/') ? item.path.slice(7) : item.path;
        const destination = inside(temporary, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(source, destination);
        if (++index % 100 === 0) { progress('正在准备专用微信组件 ' + index + '/' + manifest.files.length); await new Promise(resolve => setImmediate(resolve)); }
      }
      const ports = []; while (ports.length < 5) { const port = await unusedPort(); if (!ports.includes(port)) ports.push(port); }
      const nativeToken = randomBytes(32).toString('hex');
      write(path.join(temporary, 'config/wechatagent.json'), {
        version: 1, runtime: { sender: 'wechat-hook', weflowMode: 'nt', replyOwner: 'desktop', python: path.join(root, 'python/python.exe') },
        ports: { weflow: ports[0], onebot: ports[1], adapter: ports[2], dshPlugin: ports[3] },
        hook: { baseUrl: 'http://127.0.0.1:' + ports[4], expectedVersion: '4.1.10.27', wechatExecutable: 'state/hook/wechat-4.1.10.27/Weixin.exe', requestTimeoutMs: 5000, receiptTimeoutMs: 18000, maxConcurrentSends: 1 },
        wechat: { whitelist: { private: [], groups: [] }, wake_mode: 'mention', wake_words: ['小助手'], chatModes: {} },
        account: { nicknames: ['小助手'] }, persona: { default: '小助手', chats: {} }, dsh: { provider: 'deepseek-account', model: 'deepseek-flash' }
      });
      write(path.join(temporary, 'state/wechat-io-config.json'), { reader_base_url: 'http://127.0.0.1:' + ports[0], reader_token: randomBytes(32).toString('hex'), self_wxid: '', onebot_ws_url: 'ws://127.0.0.1:' + ports[1] + '/ws' });
      fs.writeFileSync(path.join(temporary, 'state/hook/native-token.txt'), nativeToken, { mode: 0o600 });
      fs.writeFileSync(path.join(temporary, 'state/hook/wechat-4.1.10.27/wechatagent-hook.token'), nativeToken, { mode: 0o600 });
      write(path.join(temporary, 'state/hook/native/build.json'), { targetVersion: '4.1.10.27', sha256: manifest.hookSha256 });
      write(path.join(temporary, 'state/hook/wechat-4.1.10.27/xiaozhushou-media-root.json'), { version: 1, dataRoot: dataDir });
      fs.writeFileSync(path.join(temporary, '.xiaozhushou-portable-wechat'), 'xiaozhushou-portable-wechat-v1\n');
      fs.renameSync(temporary, root); progress('专用微信已准备好。下一步打开微信，由你完成登录。');
    } finally {
      if (fs.existsSync(temporary)) { if (path.dirname(temporary) !== path.resolve(dataDir) || !path.basename(temporary).startsWith('wechat-environment.setup-')) throw Error('Unexpected setup cleanup path'); fs.rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  async function verifyAccount(config, settings, wait) {
    const verify = dependencies.verifyWeChatAccount || (await import(pathToFileURL(path.join(payloadRoot, '代码/项目/scripts/wechat-account-check.mjs')).href)).verifyWeChatAccount;
    return verify({ root, config, settings, wait, timeoutMs: 30000 });
  }
  return {
    status,
    prepare: () => startJob('prepare', prepare),
    open: () => startJob('open', async progress => {
      if (!fs.existsSync(marker)) throw Error('请先准备专用微信。');
      const config = read(path.join(root, 'config/wechatagent.json'));
      const ensure = dependencies.ensureWechatClient || (await import(pathToFileURL(path.join(payloadRoot, 'apps/service/wechat-client.mjs')).href)).ensureWechatClient;
      await ensure({ sourceDirectory: root, hookBaseUrl: config.hook.baseUrl, expectedVersion: '4.1.10.27' }, { dataDir, signal: controller.signal });
      progress('专用微信已打开。请在微信窗口中登录，并等待聊天同步。');
    }),
    discover: () => startJob('discover', async progress => {
      const result = await setupRunner({ operation: 'discover' }, progress);
      accounts = result.accounts.map(account => ({ ...account, id: createHash('sha256').update(account.dbPath).digest('hex') }));
      progress(accounts.length ? '请选择当前专用微信登录的账号，再点击验证连接。' : '未发现已同步账号。请先登录专用微信，等待同步后再识别。');
    }),
    bind: (input, service) => startJob('bind', async progress => {
      const account = accounts.find(item => item.id === input?.accountId);
      if (!account?.ready) throw Error('请选择已完成同步的账号。');
      const existing = await service.getWechatState();
      if (existing.settings.connectionImported || existing.connection.state !== 'offline') throw Error('已有微信连接。请继续使用原连接；此向导用于新电脑的首次连接。');
      const config = read(path.join(root, 'config/wechatagent.json')), settings = { dbPath: account.dbPath, myWxid: account.myWxid };
      await verifyAccount(config, settings, false);
      progress('正在验证账号。若提示等待，请在专用微信中退出账号再登录。');
      const result = await setupRunner({ operation: 'connect', ...settings, autoKey: true, wechatExecutable: path.join(root, config.hook.wechatExecutable) }, progress);
      if (result.dbPath !== account.dbPath || result.myWxid !== account.myWxid || !/^userdpapi:[A-Za-z0-9+/=]+$/.test(result.protectedKey || '')) throw Error('账号验证结果不一致，未保存连接。');
      await verifyAccount(config, settings, true);
      const apply = dependencies.applyReaderAccount || (await import(pathToFileURL(path.join(payloadRoot, '代码/项目/scripts/reader-account-state.mjs')).href)).applyReaderAccount;
      apply(root, {}, { ...settings, decryptKey: result.protectedKey }, config);
      await service.importWechatConnection(root);
      await service.saveWechatSettings({ autoConnect: true, autoReply: false });
      const state = await service.connectWechat();
      if (!state.connection.accountVerified) throw Error('连接已保存，账号核验尚未完成。请到微信页查看状态后重试。');
      progress('微信已连接。请到微信页选择允许回复的聊天，再开启自动回复。');
    }),
    async close() { closed = true; controller.abort(Error('微信准备已取消。')); await pending; }
  };
}
