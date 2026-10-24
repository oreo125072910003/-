import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const native = path.join(project, '代码', '项目', 'scripts', 'native-hook');
const upstream = path.join(project, '代码', '项目', 'components', 'WeChat-Hook', 'include');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('native image guards and durable one-shot delivery use the real C++ routes with synthetic submission only',
  { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const locator = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (!fs.existsSync(locator)) { t.skip('Visual Studio C++ Build Tools are required for the native probe'); return; }
    const devCmd = execFileSync(locator, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'Common7/Tools/VsDevCmd.bat'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    if (!devCmd) { t.skip('Visual Studio C++ compiler is unavailable'); return; }
    const build = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-native-image-'));
    const children = new Set();
    const quote = value => { assert.doesNotMatch(value, /[%!"\r\n]/); return '"' + value + '"'; };
    async function stop(child) {
      if (child.exitCode === null && child.signalCode === null) {
        const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done;
      }
      children.delete(child);
    }
    try {
      for (const synthetic of [true, false]) {
        const output = path.join(build, synthetic ? 'synthetic' : 'production'); fs.mkdirSync(output);
        const batch = path.join(output, 'compile.cmd');
        fs.writeFileSync(batch, '@echo off\r\nchcp 65001 >nul\r\ncall ' + quote(devCmd) + ' -no_logo -arch=x64\r\nif errorlevel 1 exit /b %errorlevel%\r\n' +
          'cl /nologo /std:c++20 /utf-8 /EHsc /W3 /O1 ' + (synthetic ? '/DWECHATAGENT_IMAGE_PROBE ' : '') +
          '/I' + quote(upstream) + ' /I' + quote(native) + ' ' + quote(path.join(native, 'wechatagent_hook.cpp')) + ' ' + quote(path.join(native, 'probe.cpp')) +
          ' /Fe:' + quote(path.join(output, 'probe.exe')) + ' /link version.lib bcrypt.lib\r\nexit /b %errorlevel%\r\n');
        try { execFileSync('cmd.exe', ['/d', '/s', '/c', batch], { cwd: output, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }); }
        catch (error) { throw Error('Native image probe compilation failed:\n' + String(error.stdout || '') + String(error.stderr || '')); }
        fs.writeFileSync(path.join(output, 'wechatagent-hook.token'), 'b'.repeat(64));
      }
      function fixture() {
        const root = fs.mkdtempSync(path.join(build, '中文资料-'));
        const outgoing = path.join(root, 'wechat', 'outgoing', 'wxatt_' + 'a'.repeat(32)); fs.mkdirSync(outgoing, { recursive: true });
        const image = path.join(outgoing, '测试图片😀.png');
        // A synthetic PNG signature; no decoder, client or native ABI is invoked.
        const bytes = Buffer.from('89504e470d0a1a0a0000000000000000', 'hex'); fs.writeFileSync(image, bytes);
        const control = path.join(root, 'control.json'), audit = path.join(root, 'submissions.jsonl');
        const settings = { ready: true, version: '4.1.10.27', accounts: ['synthetic_account'], outcome: 'accepted' };
        const configure = patch => fs.writeFileSync(control, JSON.stringify({ ...settings, ...patch })); configure({});
        const request = { wxidorgid: 'wxid_synthetic', path: image, name: path.basename(image), size: bytes.length, sha256: hash(bytes), mime: 'image/png', deliveryId: '1'.repeat(64) };
        return { root, outgoing, image, bytes, control, audit, configure, request,
          auditRows: () => fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
          ledgerFiles: () => { const directory = path.join(root, 'wechat', 'native-image-deliveries'); return fs.existsSync(directory) ? fs.readdirSync(directory).map(name => path.join(directory, name)) : []; } };
      }
      async function start(f, production = false) {
        let args;
        if (production) {
          const database = path.join(f.root, 'synthetic_account', 'db_storage', 'contact', 'contact.db'); fs.mkdirSync(path.dirname(database), { recursive: true }); fs.writeFileSync(database, 'synthetic'); args = [database];
        } else args = ['--image-probe', f.root, f.control, f.audit];
        const child = spawn(path.join(build, production ? 'production' : 'synthetic', 'probe.exe'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
        let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
        const port = await new Promise((resolve, reject) => {
          let output = ''; const timer = setTimeout(() => reject(Error('Probe startup timed out: ' + diagnostics)), 10000);
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('exit', code => { clearTimeout(timer); reject(Error('Probe exited before listening: ' + code + ' ' + diagnostics)); });
          child.stdout.on('data', chunk => { output += chunk; const value = output.match(/^(\d+)\r?\n/); if (value) { clearTimeout(timer); resolve(Number(value[1])); } });
        });
        async function raw(body = f.request, { token = 'b'.repeat(64), account = 'synthetic_account', route = '/SendImgMsg', method = 'POST' } = {}) {
          return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, method, path: route, headers: { authorization: 'Bearer ' + token, 'X-WeChatAgent-Account': account } }, response => {
              let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => { try { resolve({ status: response.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
            }); request.on('error', reject); request.setTimeout(5000, () => request.destroy(Error('Probe request timed out'))); request.end(method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
          });
        }
        return { child, raw, stop: () => stop(child) };
      }

      await t.test('production build advertises unsupported ABI and never writes image state or calls an upstream sender', async () => {
        const f = fixture(), p = await start(f, true);
        const health = await p.raw(undefined, { route: '/WeChatAgent/health', method: 'GET' });
        assert.equal(health.body.nativeImageSend, false); assert.equal(health.body.imageSendStatus, 'IMAGE_NATIVE_ABI_UNVERIFIED');
        const result = await p.raw(); assert.equal(result.status, 503); assert.equal(result.body.error, 'IMAGE_NATIVE_ABI_UNVERIFIED'); assert.equal(result.body.attempted, false);
        assert.deepEqual(f.ledgerFiles(), []); assert.deepEqual(f.auditRows(), []); await p.stop();
      });
      await t.test('token, exact version, unique account, strict schema and target guards refuse before submission', async () => {
        const f = fixture(), p = await start(f);
        assert.equal((await p.raw(undefined, { token: 'wrong' })).status, 401);
        assert.equal((await p.raw(undefined, { account: 'another' })).body.error, 'IMAGE_ACCOUNT_OR_VERSION_MISMATCH');
        f.configure({ version: '4.1.10.28' }); assert.equal((await p.raw()).status, 409);
        f.configure({ accounts: ['synthetic_account', 'other'] }); assert.equal((await p.raw()).status, 409);
        f.configure({ ready: false }); assert.equal((await p.raw()).body.error, 'IMAGE_NATIVE_ABI_UNVERIFIED'); f.configure({});
        for (const body of ['{', {}, [], { ...f.request, deliveryId: 'invalid' }, { ...f.request, wxidorgid: 'wxid\nattack' }, { ...f.request, ready: true }, { ...f.request, sha256: 'invalid' }]) assert.equal((await p.raw(body)).status, 400);
        assert.deepEqual(f.auditRows(), []); assert.deepEqual(f.ledgerFiles(), []); await p.stop();
      });
      await t.test('Unicode snapshot uses UTF-16 length and exact SHA256; one accepted delivery is never resubmitted', async () => {
        const f = fixture(), p = await start(f);
        const first = await p.raw(); assert.equal(first.status, 200); assert.equal(first.body.ret, 0); assert.equal(first.body.delivered, false); assert.equal(first.body.reused, false); assert.equal(first.body.message_id, undefined);
        const second = await p.raw(); assert.equal(second.body.reused, true); assert.equal(f.auditRows().length, 1);
        assert.equal(f.auditRows()[0].path, f.image); assert.equal(f.auditRows()[0].utf16Length, f.image.length); assert.notEqual(f.image.length, Buffer.byteLength(f.image));
        assert.throws(() => fs.writeFileSync(f.image, 'changed'), /EBUSY|EACCES|EPERM/); assert.throws(() => fs.unlinkSync(f.image), /EBUSY|EACCES|EPERM/);
        assert.equal((await p.raw({ ...f.request, wxidorgid: 'other_target' })).body.error, 'IMAGE_DELIVERY_CONFLICT'); assert.equal(f.auditRows().length, 1);
        const record = fs.readFileSync(f.ledgerFiles()[0], 'utf8'); assert.doesNotMatch(record, /测试图片|wxid_synthetic|中文资料/); await p.stop();
        const restarted = await start(f); assert.equal((await restarted.raw()).body.reused, true); assert.equal(f.auditRows().length, 1); await restarted.stop();
      });
      await t.test('unknown outcome and process crash retain the one-shot reservation across restart', async () => {
        for (const outcome of ['unknown', 'crash']) {
          const f = fixture(); f.configure({ outcome }); let p = await start(f);
          if (outcome === 'crash') { await assert.rejects(p.raw()); while (p.child.exitCode === null) await pause(10); assert.equal(p.child.exitCode, 8); }
          else { const result = await p.raw(); assert.equal(result.status, 502); assert.equal(result.body.attempted, true); assert.equal((await p.raw()).body.error, 'IMAGE_DELIVERY_UNCONFIRMED'); }
          assert.equal(f.auditRows().length, 1); await p.stop(); f.configure({}); p = await start(f);
          assert.equal((await p.raw()).body.error, 'IMAGE_DELIVERY_UNCONFIRMED'); assert.equal(f.auditRows().length, 1); await p.stop();
        }
      });
      await t.test('size, digest, file signature, filename and staging boundary mismatches never reserve or submit', async () => {
        const f = fixture(), p = await start(f);
        for (const body of [{ ...f.request, size: 0 }, { ...f.request, size: 8 * 1024 * 1024 + 1 }, { ...f.request, size: f.bytes.length + 1 },
          { ...f.request, sha256: '0'.repeat(64) }, { ...f.request, name: 'other.png' }, { ...f.request, mime: 'image/jpeg' },
          { ...f.request, path: f.image + ':stream' }, { ...f.request, path: '\\\\server\\share\\image.png' }, { ...f.request, path: path.join(f.root, 'outside.png') },
          { ...f.request, path: path.join(f.outgoing, '..', 'outside.png') }]) assert.notEqual((await p.raw(body)).status, 200);
        const invalid = Buffer.from('invalid image'); fs.writeFileSync(f.image, invalid);
        assert.equal((await p.raw({ ...f.request, size: invalid.length, sha256: hash(invalid) })).body.error, 'IMAGE_FORMAT_UNSUPPORTED');
        assert.deepEqual(f.ledgerFiles(), []); assert.deepEqual(f.auditRows(), []); await p.stop();
      });
      await t.test('junction substitutions in the snapshot and the durable ledger are refused', async () => {
        const f = fixture(), outside = path.join(f.root, 'elsewhere'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, f.request.name), f.bytes);
        const alias = path.join(f.root, 'wechat', 'outgoing', 'wxatt_' + 'c'.repeat(32)); fs.symlinkSync(outside, alias, 'junction');
        const p = await start(f); assert.equal((await p.raw({ ...f.request, path: path.join(alias, f.request.name) })).body.error, 'IMAGE_PATH_REFUSED');
        await p.stop(); fs.rmSync(path.join(f.root, 'wechat', 'native-image-deliveries'), { recursive: true });
        fs.symlinkSync(outside, path.join(f.root, 'wechat', 'native-image-deliveries'), 'junction');
        const q = await start(f); assert.equal((await q.raw()).body.error, 'IMAGE_PATH_REFUSED'); assert.deepEqual(f.auditRows(), []); await q.stop();
      });
      await t.test('global send mutex serializes concurrent identical requests and permits one submission', async () => {
        const f = fixture(); f.configure({ delayMs: 150 }); const p = await start(f);
        const results = await Promise.all([p.raw(), p.raw(), p.raw()]); assert.ok(results.every(result => result.status === 200));
        assert.equal(results.filter(result => result.body.reused === false).length, 1); assert.equal(f.auditRows().length, 1); await p.stop();
      });
      await t.test('last account check and damaged delivery state never permit a new or repeated submission', async () => {
        const f = fixture(); f.configure({ accountsAfterChecks: ['changed_account'], changeAfterChecks: 2 }); const p = await start(f);
        assert.equal((await p.raw()).body.error, 'IMAGE_ACCOUNT_OR_VERSION_MISMATCH'); assert.deepEqual(f.auditRows(), []); assert.deepEqual(f.ledgerFiles(), []); await p.stop();
        f.configure({}); const q = await start(f); assert.equal((await q.raw()).status, 200); fs.writeFileSync(f.ledgerFiles()[0], '{');
        const result = await q.raw(); assert.equal(result.status, 409); assert.equal(result.body.attempted, true); assert.equal(result.body.retryable, false); assert.equal(f.auditRows().length, 1); await q.stop();
      });
    } finally {
      for (const child of children) await stop(child);
      assert.equal(path.dirname(build), path.resolve(os.tmpdir())); assert.ok(path.basename(build).startsWith('xzs-native-image-'));
      fs.rmSync(build, { recursive: true, force: true });
    }
  });
