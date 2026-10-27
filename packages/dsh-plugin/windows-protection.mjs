import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Send values through stdin; credentials never become command-line arguments.
export function windowsOperation(operation, value, { spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return Promise.reject(Error('此插件目前支持 Windows。'));
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.PSModulePath;
    const child = spawnImpl(executable, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-native.ps1', import.meta.url))], { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const parts = []; let bytes = 0, settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(Error('Windows 操作超时，请重试。')); }, operation === 'dialog' ? 300000 : 15000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { child.kill(); finish(Error('Windows 返回内容过大。')); } else parts.push(chunk); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.once('error', () => finish(Error('无法启动 Windows 本机组件。')));
    child.once('close', code => {
      if (code !== 0) return finish(Error('Windows 凭据保护或文件选择未完成，原数据保留。'));
      try { finish(null, JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, ''))); }
      catch { finish(Error('Windows 本机组件没有返回有效结果。')); }
    });
    child.stdin.end(JSON.stringify({ operation, value }));
  });
}

export function createWindowsProtection({ dataDir, operate = windowsOperation } = {}) {
  let keyPromise;
  async function chromiumKey() {
    if (!keyPromise) keyPromise = (async () => {
      const filename = path.join(dataDir, 'desktop', 'Local State');
      if (fs.statSync(filename).size > 4 * 1024 * 1024) throw Error('原桌面凭据配置过大。');
      const encoded = JSON.parse(fs.readFileSync(filename, 'utf8')).os_crypt?.encrypted_key;
      if (typeof encoded !== 'string') throw Error('缺少原桌面的 Windows 凭据配置。');
      const wrapped = Buffer.from(encoded, 'base64');
      if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw Error('原桌面凭据保护格式暂不支持。');
      const key = Buffer.from(await operate('unprotect', wrapped.subarray(5).toString('base64')), 'base64');
      if (key.length !== 32) throw Error('原桌面凭据密钥无效。');
      return key;
    })().catch(error => { keyPromise = null; throw error; });
    return keyPromise;
  }
  return {
    isAsyncEncryptionAvailable: async () => process.platform === 'win32',
    encryptStringAsync: async value => Buffer.from(await operate('protect', Buffer.from(value, 'utf8').toString('base64')), 'base64'),
    async decryptStringAsync(value) {
      const data = Buffer.from(value);
      if (data.subarray(0, 3).toString() === 'v10') {
        if (data.length < 31) throw Error('原桌面凭据不完整。');
        const decipher = createDecipheriv('aes-256-gcm', await chromiumKey(), data.subarray(3, 15));
        decipher.setAuthTag(data.subarray(-16));
        return { result: Buffer.concat([decipher.update(data.subarray(15, -16)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
      }
      return { result: Buffer.from(await operate('unprotect', data.toString('base64')), 'base64').toString('utf8'), shouldReEncrypt: false };
    }
  };
}
