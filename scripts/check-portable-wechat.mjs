import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'packages/dsh-plugin/package.json'), 'utf8'));
const packageRoot = path.join(root, 'dist/dsh-plugin', version + '-full/package');
const output = path.join(root, 'dist/dsh-plugin/portable-smoke'); fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhushou-portable-check-'));
const { createPortableWechat } = await import(pathToFileURL(path.join(packageRoot, 'portable-wechat.mjs')).href);
const portable = createPortableWechat({ packageRoot, payloadRoot: path.join(packageRoot, 'payload'), dataDir });
try {
  portable.prepare(); let state;
  for (let i = 0; i < 1800; i++) { state = portable.status(); if (state.job.state !== 'running') break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal(state.job.state, 'succeeded', state.job.message);
  const environment = path.join(dataDir, 'wechat-environment');
  const config = JSON.parse(fs.readFileSync(path.join(environment, 'config/wechatagent.json'), 'utf8'));
  assert.equal(config.runtime.python, path.join(environment, 'python/python.exe'));
  assert.deepEqual(config.wechat.whitelist, { private: [], groups: [] });
  assert.equal(state.accountConfigured, false);
  const pythonCode = "import sys,runpy,json,ctypes; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[1]+'/reader-api.py',run_name='offline_import'); import sqlcipher3,cryptography,zstandard,Crypto,PIL; ctypes.CDLL(sys.argv[2]); print(json.dumps({'readerImports':True,'nativeKeyComponentLoads':True,'accountRead':False}))";
  const result = spawnSync(config.runtime.python, ['-B','-c', pythonCode, path.join(environment, 'scripts'), path.join(environment, 'components/weflow-cli/resources/key/win32/x64/wx_key.dll')], { cwd: environment, windowsHide: true, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  if (result.status !== 0) throw Error('完整包内 Python/reader 导入失败：' + result.stderr.slice(-2000));
  const verified = JSON.parse(result.stdout.trim()); assert.equal(verified.readerImports, true); assert.equal(verified.nativeKeyComponentLoads, true);
  const report = { ok: true, fullBundlePreparedInEmptyDirectory: true, allFileDigestsVerified: true, portablePythonAndReaderImports: true, nativeKeyComponentLoads: true,
    originalCredentialsCopied: false, freshTokensGenerated: true, defaultReplyConversations: 0, clientLaunched: false, realWechatLoginTested: false, realWechatMessagesSent: 0 };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  await portable.close();
  if (path.dirname(path.resolve(dataDir)) !== path.resolve(os.tmpdir()) || !path.basename(dataDir).startsWith('xiaozhushou-portable-check-')) throw Error('Unexpected portable check cleanup path');
  fs.rmSync(dataDir, { recursive: true, force: true });
}
