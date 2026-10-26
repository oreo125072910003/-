import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureWechatClient } from './wechat-client.mjs';

const fault = message => Object.assign(Error(message), { code: 'WECHAT_RUNTIME_UNAVAILABLE' });
const read = filename => {
  if (fs.statSync(filename).size > 256 * 1024) throw fault('微信运行配置过大，请重新配置。');
  return JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
};
const portOpen = (url, signal) => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port: Number(url.port), signal });
  const finish = open => { socket.destroy(); resolve(open); };
  socket.setTimeout(700, () => finish(true)); // An occupied/unresponsive port is never ours to replace.
  socket.once('connect', () => finish(true));
  socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
});

/** Prepare the reviewed client and existing read service. Never launch a legacy
 * responder, install/inject components, alter credentials or replace a listener. */
export function createWechatRuntime({ dataDir, sources = [], fetchImpl = fetch, spawnImpl = spawn,
  portOpenImpl = portOpen, ensureClient = ensureWechatClient, startupMs = 20000, pollMs = 250 } = {}) {
  let pending, child;
  return {
    ensure(config, { signal } = {}) {
      if (pending) return pending;
      pending = (async () => {
        signal?.throwIfAborted();
        const url = new URL(config.readerBaseUrl);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fault('微信读取地址必须是本机地址。');
        const healthy = async () => {
          try {
            const response = await fetchImpl(new URL('/api/v1/reader/status', url), {
              headers: { authorization: 'Bearer ' + config.readerToken }, redirect: 'error',
              signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500),
            });
            if (!response.ok) return false;
            const state = await response.json();
            return state.success === true && state.backend === 'weflow-cli-nt' && state.selfEvents === 'account-conversation-v1';
          } catch { return false; }
        };
        const directory = config.sourceDirectory || (sources.length === 1 ? sources[0] : null);
        let root, project;
        // A healthy reader does not imply the sender/client is running. Always
        // verify the exact client first, including after a later client exit.
        if (directory) {
          root = fs.realpathSync(directory); project = read(path.join(root, 'config/wechatagent.json'));
          const io = read(path.join(root, 'state/wechat-io-config.json'));
          if (project.runtime?.sender !== 'wechat-hook' || project.runtime?.weflowMode !== 'nt' ||
              new URL(io.reader_base_url).origin !== url.origin || io.reader_token !== config.readerToken ||
              Number(project.ports?.weflow) !== Number(url.port)) throw fault('已导入的微信环境与当前连接不一致，请重新导入。');
          const client = await ensureClient({ ...config, sourceDirectory: root }, { dataDir, signal });
          if (client?.loginRequired) throw Object.assign(Error('HOOK_LOGIN_REQUIRED'), { code: 'HOOK_LOGIN_REQUIRED' });
        }
        if (await healthy()) return { ready: true, started: false, ...(directory ? { sourceDirectory: directory } : {}) };
        signal?.throwIfAborted();
        if (!directory) throw fault('未找到已配置的微信读取环境，请在微信页重新导入原连接。');
        const executable = project.runtime?.python, entry = path.join(root, 'scripts/reader-api.py');
        if (typeof executable !== 'string' || !path.isAbsolute(executable) || !fs.statSync(executable).isFile() || !fs.statSync(entry).isFile()) throw fault('原微信环境的读取组件不完整，请修复原环境。');
        if (!child || child.exitCode !== null || child.signalCode !== null) {
          if (await portOpenImpl(url, signal)) throw fault('微信读取端口已占用，但连接核验没有通过，请检查原微信环境。');
          signal?.throwIfAborted();
          const logs = path.join(dataDir, 'wechat/runtime'); fs.mkdirSync(logs, { recursive: true });
          const out = fs.openSync(path.join(logs, 'reader.stdout.log'), 'a'), err = fs.openSync(path.join(logs, 'reader.stderr.log'), 'a');
          try {
            child = spawnImpl(executable, ['-X', 'utf8', entry], { cwd: root, windowsHide: true, detached: true,
              env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' }, stdio: ['ignore', out, err] });
            try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
            catch { child = null; throw fault('微信读取组件无法启动，请检查原环境的 Python 运行程序。'); }
            child.unref();
          } finally { fs.closeSync(out); fs.closeSync(err); }
        }
        const deadline = Date.now() + startupMs;
        do {
          signal?.throwIfAborted();
          if (await healthy()) return { ready: true, started: true, sourceDirectory: root };
          if (child.exitCode !== null || child.signalCode !== null) throw fault('微信读取组件启动失败，详情已保存在微信运行日志。');
          await delay(pollMs, undefined, { signal });
        } while (Date.now() < deadline);
        throw fault('微信读取组件仍在启动，小助手会继续等待连接。');
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
