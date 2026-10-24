import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAssistantService } from '../apps/service/index.mjs';
import { inspectRuntime, runTask } from '../packages/runtime-harness/index.mjs';

const fixture = fileURLToPath(new URL('../packages/runtime-harness/test-fixture.mjs', import.meta.url));
async function setup(t, { key = 'integration-fixture-key', scenario = 'success' } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'assistant-service-runtime-'));
  const values = new Map(key ? [['deepseek-api-key', key]] : []);
  const secretStore = { async get(name) { return values.get(name); }, async set(name, value) { values.set(name, value); }, async delete(name) { values.delete(name); } };
  let calls = 0;
  const adapt = settings => ({ ...settings, executable: process.execPath, args: [fixture], env: { ...settings.env, FIXTURE_CASE: scenario } });
  const runtime = {
    inspectRuntime(settings) { return inspectRuntime(adapt(settings)); },
    runTask(input) { calls++; return runTask({ ...input, settings: adapt(input.settings) }); },
  };
  const service = await createAssistantService({ dataDir, runtime, secretStore });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, service, calls: () => calls };
}
async function until(service, id, status) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const detail = service.getTask(id);
    if (status.includes(detail.task.status)) return detail;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Fixture service task did not reach expected state');
}

test('service and actual adapter turn persisted task into a verified text artifact with configured persona', async t => {
  const { service, dataDir } = await setup(t);
  await service.saveSettings({ assistantName: '星星', persona: '我会认真记住主人交办的事情。' });
  const task = await service.createTask({ kind: 'agent', prompt: '拟一份工作安排', attachmentPaths: [] });
  const detail = await until(service, task.id, ['succeeded', 'failed']);
  assert.equal(detail.task.status, 'succeeded', detail.task.error);
  assert.equal(detail.artifacts.length, 1); assert.ok(detail.task.sessionId);
  const artifact = await readFile(service.resolveArtifact(detail.artifacts[0].id), 'utf8');
  assert.match(artifact, /真实协议夹具回答/);
  const tracePath = path.join(dataDir, 'harness-home', 'fixture-trace.jsonl');
  const launch = (await readFile(tracePath, 'utf8')).trim().split('\n').map(JSON.parse).find(entry => entry.type === 'start');
  const patch = await readFile(launch.args.at(-1), 'utf8');
  assert.match(patch, /星星/); assert.match(patch, /认真记住/);
  const dbBytes = await readFile(path.join(dataDir, 'db', 'assistant.sqlite'));
  assert.equal(dbBytes.includes(Buffer.from('integration-fixture-key')), false);
  assert.equal(JSON.stringify(await service.getSettings()).includes('integration-fixture-key'), false);
});

test('missing account is saved as waiting dependency without submitting a model prompt', async t => {
  const { service, calls } = await setup(t, { key: null });
  const task = await service.createTask({ kind: 'agent', prompt: '写一个草稿' });
  const detail = await until(service, task.id, ['waiting_dependency', 'failed']);
  assert.equal(detail.task.status, 'waiting_dependency'); assert.equal(calls(), 0);
  assert.equal(detail.artifacts.length, 0);
  assert.match(detail.task.error, /API Key/);
});

test('unexpected tool call propagates as failed task and never creates a successful artifact', async t => {
  const { service } = await setup(t, { scenario: 'tool-call' });
  const task = await service.createTask({ kind: 'agent', prompt: '写一个草稿' });
  const detail = await until(service, task.id, ['failed', 'succeeded']);
  assert.equal(detail.task.status, 'failed'); assert.equal(detail.artifacts.length, 0);
  assert.match(detail.task.error, /未开放的工具/);
});

test('service cancellation propagates to adapter process and persists cancellation', async t => {
  const { service } = await setup(t, { scenario: 'hang' });
  const task = await service.createTask({ kind: 'agent', prompt: '等待完成' });
  await until(service, task.id, ['running']);
  await new Promise(resolve => setTimeout(resolve, 250));
  await service.cancelTask(task.id);
  const detail = await until(service, task.id, ['cancelled', 'failed']);
  assert.equal(detail.task.status, 'cancelled'); assert.equal(detail.artifacts.length, 0);
});
