import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ensureWechatClient } from '../apps/service/wechat-client.mjs';

test('client diagnostics preserve the current process and isolate Windows PowerShell modules', { skip: process.platform !== 'win32' }, async t => {
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = 'C:\\synthetic-powershell-7-modules';
  t.after(() => { if (previous === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previous; });
  let killed = false, received = '';
  await assert.rejects(ensureWechatClient({ sourceDirectory: 'C:\\synthetic-source', expectedVersion: '4.1.10.27', hookBaseUrl: 'http://127.0.0.1:30001' },
    { dataDir: 'C:\\synthetic-product', spawnImpl(command, args, options) {
      assert.ok(command.endsWith('powershell.exe'));
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.PSModulePath, undefined);
      assert.equal(process.env.PSModulePath, 'C:\\synthetic-powershell-7-modules');
      assert.ok(args.includes('-NonInteractive'));
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; } });
      child.stdin = new Writable({ write(chunk, _encoding, callback) { received += chunk; callback(); }, final(callback) {
        queueMicrotask(() => { child.stdout.write(JSON.stringify({ ok: false, code: 'WECHAT_OTHER_CLIENT_RUNNING', currentVersion: '4.2.0.8' })); child.emit('close', 2); }); callback();
      } });
      return child;
    } }), { code: 'WECHAT_OTHER_CLIENT_RUNNING', currentVersion: '4.2.0.8' });
  assert.equal(killed, false);
  assert.equal(JSON.parse(received).expectedVersion, '4.1.10.27');
  assert.equal(JSON.parse(received).dataDir, 'C:\\synthetic-product');
});
