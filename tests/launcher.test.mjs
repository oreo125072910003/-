import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { knownModelFailure } from '../packages/contracts/model-failure.mjs';

test('model failures retain fixed actionable text through task storage without leaking provider details', () => {
  for (const status of [401, 402, 404, 429]) {
    const failure = knownModelFailure({ status, message: 'secret-provider-request-data' });
    assert.ok(failure); assert.doesNotMatch(failure.message, /secret-provider/);
    assert.deepEqual(knownModelFailure({ message: failure.message }), failure);
  }
  assert.equal(knownModelFailure({ status: 500, message: 'private raw failure' }), null);
});

test('Windows launcher clears inherited Node mode and passes a Chinese data path intact', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-launcher-')), data = path.join(root, '资料 空格'); fs.mkdirSync(data);
  const helper = fileURLToPath(new URL('../scripts/electron-process.ps1', import.meta.url));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const script = path.join(root, 'verify.ps1');
  fs.writeFileSync(script, '\uFEFF' + `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
class Entry {
  static void Main(string[] args) {
    File.WriteAllLines(Path.Combine(args[1],"launch.txt"),new string[]{
      Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE")??"cleared",
      Environment.GetEnvironmentVariable("NODE_OPTIONS")??"cleared",
      Environment.GetEnvironmentVariable("NODE_PATH")??"cleared",
      args[0],args[1],args[2]});
  }
}
'@ -OutputAssembly ${quote(path.join(root, 'test.exe'))} -OutputType ConsoleApplication
. ${quote(helper)}
$p=Start-AssistantElectron -Executable ${quote(path.join(root, 'test.exe'))} -DataHome ${quote(data)} -Quit
if(-not $p.WaitForExit(5000)){throw 'Child did not exit'}
if($p.ExitCode -ne 0){throw 'Child failed'}
`, 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings', NODE_PATH: 'synthetic-unwanted-module-path' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(path.join(data, 'launch.txt'), 'utf8').trim().split(/\r?\n/), ['cleared', 'cleared', 'cleared', '--data-home', data, '--quit']);
});
