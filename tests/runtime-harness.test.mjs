import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectRuntime, runTask, probeRuntimeConnection } from '../packages/runtime-harness/index.mjs';
const fixture = fileURLToPath(new URL('../packages/runtime-harness/test-fixture.mjs', import.meta.url));

async function setup(t, scenario = 'success') {
  const home = await mkdtemp(path.join(os.tmpdir(), 'assistant-runtime-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { executable: process.execPath, args: [fixture], home, timeoutMs: 2000, initializeTimeoutMs: 1500, env: { FIXTURE_CASE: scenario } };
}
async function trace(home) { return (await readFile(path.join(home, 'fixture-trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }

test('version detection is not a claim that an account/model works', async t => {
  const settings = await setup(t);
  const result = await inspectRuntime(settings);
  assert.equal(result.available, true); assert.equal(result.version, '0.2.1-rc.2');
  assert.equal(result.ready, false); assert.equal(result.capabilities.modelVerified, false);
  assert.equal(result.credentialsConfigured, false); assert.equal(result.capabilities.mcp, false);
});

test('initialize-only probe performs no prompt/model call', async t => {
  const settings = await setup(t);
  const result = await probeRuntimeConnection(settings);
  assert.equal(result.ok, true); assert.equal(result.modelCalled, false);
  const entries = await trace(settings.home);
  assert.deepEqual(entries.filter(x => x.type === 'request').map(x => x.method), ['initialize', 'shutdown']);
});

test('version inspection uses a real OS cwd when packaged virtual root or configured workspace is unavailable', async t => {
  const settings = await setup(t);
  for (const workspace of [path.join(settings.home, 'resources', 'app.asar'), path.join(settings.home, 'moved-workspace')]) {
    const result = await inspectRuntime({ ...settings, workspace });
    assert.equal(result.available, true, result.detail);
    assert.equal(result.inspectionWorkingDirectory, path.resolve(os.tmpdir()));
    assert.equal(result.inspectionWorkingDirectory.includes('app.asar'), false);
  }
});

test('run maps committed assistant output, waits for completion and ignores other sessions', async t => {
  const settings = await setup(t), events = [];
  const result = await runTask({ prompt: '你好', workspace: settings.home, settings, onEvent: event => events.push(event) });
  assert.equal(result.ok, true); assert.equal(result.finalText, '真实协议夹具回答');
  assert.equal(result.usage.inputTokens, 7); assert.equal(result.usage.outputTokens, 9);
  assert.equal(events.some(event => event.message.includes('OTHER SESSION')), false);
  assert.deepEqual(result.artifacts, []);
  const args = (await trace(settings.home))[0].args;
  const patch = await readFile(args[args.indexOf('--patch') + 1], 'utf8');
  assert.match(patch, /id: tool-pwsh\n  disabled: true/);
  assert.match(patch, /id: agent-instructions\n  disabled: true/);
  assert.match(patch, /personaPrefix:/);
});

test('resuming restores exactly the existing session and rejects missing history', async t => {
  const settings = await setup(t);
  const first = await runTask({ prompt: 'one', workspace: settings.home, settings });
  const second = await runTask({ prompt: 'two', workspace: settings.home, sessionId: first.sessionId, settings });
  assert.equal(second.ok, true); assert.equal(second.sessionId, first.sessionId);
  const missing = await runTask({ prompt: 'three', workspace: settings.home, sessionId: 'missing-session', settings });
  assert.equal(missing.ok, false); assert.equal(missing.error.code, 'RUNTIME_RPC_ERROR');
});

test('restored historical text cannot become this task final result', async t => {
  const settings = await setup(t);
  const first = await runTask({ prompt: 'one', workspace: settings.home, settings });
  settings.env.FIXTURE_CASE = 'resume-stale';
  const events = [];
  const second = await runTask({ prompt: 'two', workspace: settings.home, sessionId: first.sessionId, settings, onEvent: event => events.push(event) });
  assert.equal(second.error.code, 'EMPTY_RESULT');
  assert.equal(events.some(entry => entry.message.includes('STALE')), false);
});

for (const [scenario, code] of [['malformed', 'PROTOCOL_INVALID'], ['model-error', 'MODEL_TURN_FAILED'], ['empty', 'EMPTY_RESULT'], ['crash', 'RUNTIME_EXITED'], ['tool-call', 'TOOL_POLICY_VIOLATION'], ['truncated', 'MODEL_TURN_FAILED']]) {
  test(`${scenario} is not reported as successful completion`, async t => {
    const settings = await setup(t, scenario);
    const result = await runTask({ prompt: 'test', workspace: settings.home, settings });
    assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.equal(result.finalText, '');
  });
}

test('aborting one task stops its owned runtime and leaves a concurrent runtime intact', async t => {
  const slow = await setup(t, 'hang'), normal = await setup(t), controller = new AbortController();
  const pending = runTask({ prompt: 'slow', workspace: slow.home, signal: controller.signal, settings: slow });
  await new Promise(resolve => setTimeout(resolve, 300)); controller.abort();
  const sibling = await runTask({ prompt: 'normal', workspace: normal.home, settings: normal });
  const cancelled = await pending;
  assert.equal(cancelled.error.code, 'CANCELLED'); assert.equal(sibling.ok, true);
  const pid = (await trace(slow.home))[0].pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process|not found/i);
});

test('timeout fails and cleans up a runtime with no reply', async t => {
  const settings = await setup(t, 'initialize-hang'); settings.initializeTimeoutMs = 100;
  const result = await runTask({ prompt: 'test', workspace: settings.home, settings });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'RUNTIME_TIMEOUT');
});

test('personal home and unreviewed profile overlays are refused before boot', async t => {
  const settings = await setup(t);
  const personal = await inspectRuntime({ ...settings, home: path.join(os.homedir(), '.dsh') });
  assert.equal(personal.error.code, 'PERSONAL_HOME_REFUSED');
  await writeFile(path.join(settings.home, 'cordis.patch.yml'), '- id: unsafe-tool\n  name: custom-execution\n');
  const result = await runTask({ prompt: 'test', workspace: settings.home, settings });
  assert.equal(result.error.code, 'UNREVIEWED_PROFILE');
});

test('host credentials are scrubbed, only explicit key is injected, no key is written to adapter files', async t => {
  const settings = await setup(t);
  const previous = process.env.RUNTIME_PARENT_SECRET;
  process.env.RUNTIME_PARENT_SECRET = 'host-secret-must-not-cross';
  settings.env.DEEPSEEK_API_KEY = 'explicit-fixture-key';
  try {
    const result = await runTask({ prompt: 'test', workspace: settings.home, settings });
    assert.equal(result.ok, true);
    const launch = (await trace(settings.home))[0];
    assert.equal(launch.parentSecret, false); assert.equal(launch.explicitKey, 'explicit-fixture-key');
    const marker = await readFile(path.join(settings.home, '.xiaozhushou-runtime.json'), 'utf8');
    const patch = await readFile(launch.args.at(-1), 'utf8');
    assert.equal((marker + patch).includes('explicit-fixture-key'), false);
  } finally { if (previous === undefined) delete process.env.RUNTIME_PARENT_SECRET; else process.env.RUNTIME_PARENT_SECRET = previous; }
});

test('unsupported runtime versions cannot execute task prompts', async t => {
  const settings = await setup(t); settings.env.FIXTURE_VERSION = '0.9.0';
  const result = await runTask({ prompt: 'test', workspace: settings.home, settings });
  assert.equal(result.error.code, 'VERSION_NOT_VERIFIED');
});

test('inspection cannot turn configured args into a headless model call', async t => {
  const settings = await setup(t); settings.args = ['--profile', 'headless', 'unexpected paid prompt'];
  const result = await inspectRuntime(settings);
  assert.equal(result.available, false); assert.equal(result.error.code, 'EXTRA_ARGS_REFUSED');
});

test('service personaPrefix maps into system prompt and existing safety patches cannot be replaced silently', async t => {
  const settings = await setup(t); settings.personaPrefix = '你是长久陪伴的星星。';
  const first = await runTask({ prompt: 'test', workspace: settings.home, settings });
  assert.equal(first.ok, true);
  const filename = (await trace(settings.home))[0].args.at(-1);
  assert.match(await readFile(filename, 'utf8'), /你是长久陪伴的星星/);
  await writeFile(filename, '- id: tool-pwsh\n  disabled: false\n');
  const second = await runTask({ prompt: 'test', workspace: settings.home, settings });
  assert.equal(second.error.code, 'PATCH_TAMPERED');
});

test('Windows cmd wrapper preserves Chinese/spaces and does not evaluate prompt metacharacters', { skip: process.platform !== 'win32' }, async t => {
  const settings = await setup(t);
  const wrapper = path.join(settings.home, 'CLI with 空格.cmd');
  await writeFile(wrapper, '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_SCRIPT%" %*\r\n');
  settings.env.FIXTURE_NODE = process.execPath; settings.env.FIXTURE_SCRIPT = fixture;
  settings.executable = wrapper; settings.args = [];
  const prompt = '你好 %PATH% & echo INJECTION | 其他 ! $() `';
  const result = await runTask({ prompt, workspace: settings.home, settings });
  assert.equal(result.ok, true);
  const entry = (await trace(settings.home)).find(entry => entry.type === 'prompt');
  assert.equal(entry.text, prompt);
});

test('Windows owned cmd process tree is forcibly reaped when child ignores EOF', { skip: process.platform !== 'win32' }, async t => {
  const settings = await setup(t, 'ignore-eof');
  const wrapper = path.join(settings.home, 'Owned CLI.cmd');
  await writeFile(wrapper, '@echo off\r\n"%FIXTURE_NODE%" "%FIXTURE_SCRIPT%" %*\r\n');
  settings.env.FIXTURE_NODE = process.execPath; settings.env.FIXTURE_SCRIPT = fixture;
  settings.executable = wrapper; settings.args = [];
  const controller = new AbortController();
  const running = runTask({ prompt: 'wait', workspace: settings.home, settings, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 300)); controller.abort();
  const result = await running;
  assert.equal(result.error.code, 'CANCELLED');
  const childPid = (await trace(settings.home))[0].pid;
  assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process|not found/i);
});
