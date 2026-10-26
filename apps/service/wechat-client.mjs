import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const script = fileURLToPath(new URL('./start-wechat-client.ps1', import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
const fault = (code, details = {}) => Object.assign(Error(code), { code, ...details });

/** Launch only the already prepared, reviewed client. No installation, process
 * termination, credential extraction, ACL change or legacy responder startup. */
export async function ensureWechatClient(config, { dataDir, signal, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== 'win32' || !fs.existsSync(script)) throw fault('WECHAT_CLIENT_LAUNCH_UNAVAILABLE');
  const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const input = JSON.stringify({ sourceDirectory: config.sourceDirectory, dataDir, hookBaseUrl: config.hookBaseUrl, expectedVersion: config.expectedVersion });
  const env = { ...process.env };
  // PowerShell 7's module path is incompatible with the Windows PowerShell
  // signature checker. Let the child discover its own built-in modules.
  delete env.PSModulePath; delete env.PSModuleAnalysisCachePath;
  return new Promise((resolve, reject) => {
    let output = '', settled = false;
    const child = spawnImpl(command, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => { child.kill(); finish(signal.reason || fault('WECHAT_START_CANCELLED')); };
    const timer = setTimeout(() => { child.kill(); finish(fault('WECHAT_CLIENT_HEALTH_TIMEOUT')); }, 45000);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(fault('WECHAT_CLIENT_LAUNCH_UNAVAILABLE')));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) { child.kill(); finish(fault('WECHAT_CLIENT_LAUNCH_UNAVAILABLE')); } });
    child.stderr.on('data', () => {}); // Never persist raw helper diagnostics.
    child.once('close', code => {
      if (settled) return;
      let result; try { result = JSON.parse(output.trim().replace(/^\uFEFF/, '')); } catch { return finish(fault('WECHAT_CLIENT_LAUNCH_UNAVAILABLE')); }
      if (code !== 0 || result?.ok !== true) {
        const code = /^(?:WECHAT_CLIENT_[A-Z_]+|WECHAT_OTHER_CLIENT_RUNNING|HOOK_MULTIPLE_ACCOUNT_DATABASES)$/.test(result?.code || '') ? result.code : 'WECHAT_CLIENT_LAUNCH_UNAVAILABLE';
        return finish(fault(code, /^\d+\.\d+\.\d+\.\d+$/.test(result?.currentVersion || '') ? { currentVersion: result.currentVersion } : {}));
      }
      finish(null, { ready: true, started: result.started === true, loginRequired: result.loginRequired === true });
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
