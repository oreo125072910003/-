import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkerCoordinator, createHarnessWorkerAdapter } from '../packages/workers/index.mjs';

const owner = Object.freeze({ owner: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, options = {}) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-workers-test-')); const coordinator = createWorkerCoordinator({ runWorker: async work => ({ ok: true, finalText: `${work.role}的实际测试成果。` }), authorize: async context => context === owner, ...options }); t.after(async () => { await coordinator.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('assistant-workers-test-')); fs.rmSync(directory, { recursive: true, force: true }); }); return { coordinator, directory }; }
async function plan(coordinator, input = {}) { return coordinator.createPlan({ parentTaskId: 'task_test-parent', workflow: 'writing-review', goal: '起草一份工作安排。', inputs: [{ id: 'facts', name: '确认资料', text: '甲方完成资料核对，日期待确认。' }], ...input }, owner); }

test('writing, review and revision use independent workspaces and hash-linked original output', async t => {
  const received = [], events = []; const { coordinator, directory } = await setup(t, { onEvent: event => events.push(event), runWorker: async work => { received.push(work); return { ok: true, finalText: `${work.role}:测试正文`, usage: { inputTokens: 12, outputTokens: 8 } }; } });
  const proposal = await plan(coordinator, { revise: true }); const result = await coordinator.run(proposal, { workspace: directory, context: owner });
  assert.equal(result.ok, true); assert.equal(result.status, 'succeeded'); assert.equal(result.steps.length, 3); assert.deepEqual(received.map(work => work.role), ['writer', 'reviewer', 'reviser']); assert.equal(new Set(received.map(work => work.workspace)).size, 3);
  assert.ok(received.every(work => work.workspace.startsWith(directory) && work.allowedActions.length === 1 && work.allowedActions[0] === 'text.generate'));
  assert.equal(received[0].dependencies.length, 0); assert.equal(received[1].dependencies[0].id, 'write'); assert.deepEqual(result.steps[1].reviewOf, [{ stepId: 'write', sha256: result.steps[0].sha256 }]); assert.equal(result.review.assurance, 'model-opinion-only');
  assert.ok(result.artifacts.every(artifact => createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex') === artifact.sha256)); assert.match(result.finalText, /reviser:测试正文/); assert.equal(result.budget.callsUsed, 3); assert.equal(result.budget.actualCost, null); assert.ok(events.some(event => event.type === 'plan.finished'));
});
test('two analysts run concurrently and their reviewer receives both outputs', async t => {
  let active = 0, peak = 0; const seen = []; const { coordinator, directory } = await setup(t, { runWorker: async work => { active++; peak = Math.max(peak, active); seen.push(work); await wait(40); active--; return { ok: true, finalText: work.role + '基于资料分析。' }; } }); const proposal = await plan(coordinator, { workflow: 'research-compare' }); const result = await coordinator.run(proposal, { workspace: directory, context: owner });
  assert.equal(peak, 2); assert.equal(result.ok, true); assert.equal(seen[2].role, 'reviewer'); assert.deepEqual(seen[2].dependencies.map(item => item.id), ['analyze-a', 'analyze-b']); assert.match(result.finalText, /仅基于提供资料/); assert.equal(coordinator.listWorkflows()[1].liveResearch, false);
});
test('unauthorized, tampered and repeated plans cannot launch workers', async t => {
  let calls = 0; const { coordinator, directory } = await setup(t, { runWorker: async () => { calls++; return { ok: true, finalText: '文字成果' }; } });
  await assert.rejects(coordinator.createPlan({ parentTaskId: 'p', goal: '工作' }, { owner: true }), error => error.code === 'NOT_AUTHORIZED');
  const proposal = await plan(coordinator); await assert.rejects(coordinator.run({ ...proposal, budget: { ...proposal.budget, maxCalls: 8 } }, { workspace: directory, context: owner }), error => error.code === 'PLAN_CHANGED');
  await assert.rejects(coordinator.run(proposal, { workspace: directory, context: {} }), error => error.code === 'NOT_AUTHORIZED'); assert.equal(calls, 0);
  await coordinator.run(proposal, { workspace: directory, context: owner }); await assert.rejects(coordinator.run(proposal, { workspace: directory, context: owner }), error => error.code === 'PLAN_ALREADY_RUN');
});
test('workers get selected text only and known credentials are redacted', async t => {
  let received; const { coordinator, directory } = await setup(t, { runWorker: async work => { received = work; return { ok: true, finalText: '文本'}; } });
  await assert.rejects(plan(coordinator, { inputs: [{ id: 'mail', name: '邮件', text: '正文', credentials: 'private' }] }), error => error.code === 'INVALID_INPUT');
  const proposal = await plan(coordinator, { goal: '写说明 token并非密钥 sk-private-value-123456', inputs: [{ id: 'facts', name: '选定资料', text: 'password=private-value Bearer private-token' }] }); await coordinator.run(proposal, { workspace: directory, context: owner });
  assert.equal(JSON.stringify(received).includes('private-value'), false); assert.equal(JSON.stringify(received).includes('private-token'), false); assert.deepEqual(Object.keys(received.task).sort(), ['depth', 'parentTaskId', 'planId', 'stepId']); assert.equal(received.settings, undefined); assert.equal(received.env, undefined);
});
test('call, output count and depth budgets stop new work and preserve partial results', async t => {
  const { coordinator, directory } = await setup(t); const limited = await plan(coordinator, { budget: { maxCalls: 1 } }); const partial = await coordinator.run(limited, { workspace: directory, context: owner }); assert.equal(partial.ok, false); assert.equal(partial.status, 'partial'); assert.equal(partial.budget.callsUsed, 1); assert.equal(partial.steps[1].error.code, 'CALL_BUDGET_EXCEEDED'); assert.equal(partial.artifacts.length, 1);
  const outputLimit = await plan(coordinator, { budget: { maxOutputs: 1 } }); const limitedResult = await coordinator.run(outputLimit, { workspace: directory, context: owner }); assert.equal(limitedResult.steps[1].error.code, 'OUTPUT_BUDGET_EXCEEDED');
  const deep = await plan(coordinator, { depth: 1, budget: { maxDepth: 1 } }); const blocked = await coordinator.run(deep, { workspace: directory, context: owner }); assert.equal(blocked.ok, false); assert.equal(blocked.budget.callsUsed, 0); assert.equal(blocked.steps[0].error.code, 'DEPTH_EXCEEDED'); assert.equal(blocked.steps[1].status, 'skipped');
});
test('oversized input and combined review context fail explicitly', async t => {
  let calls = 0; const { coordinator, directory } = await setup(t, { runWorker: async () => { calls++; return { ok: true, finalText: '很长的前序成果。'.repeat(1000) }; } });
  await assert.rejects(plan(coordinator, { budget: { maxInputBytes: 100 }, inputs: [{ id: 'large', text: 'x'.repeat(101) }] }), error => error.code === 'INPUT_BUDGET_EXCEEDED');
  const proposal = await plan(coordinator, { budget: { maxInputBytes: 4096 } }); const result = await coordinator.run(proposal, { workspace: directory, context: owner }); assert.equal(result.status, 'partial'); assert.equal(calls, 1); assert.equal(result.steps[1].error.code, 'INPUT_BUDGET_EXCEEDED');
});
test('output byte budget and malformed success cannot pretend to deliver results', async t => {
  const { coordinator, directory } = await setup(t, { runWorker: async () => ({ ok: true, finalText: 'x'.repeat(101) }) }); const result = await coordinator.run(await plan(coordinator, { budget: { maxOutputBytes: 100 } }), { workspace: directory, context: owner }); assert.equal(result.ok, false); assert.equal(result.artifacts.length, 0); assert.equal(result.steps[0].error.code, 'OUTPUT_BUDGET_EXCEEDED');
  const invalid = createWorkerCoordinator({ authorize: async () => true, runWorker: async () => ({ ok: true, finalText: '' }) }); t.after(() => invalid.close()); const invalidResult = await invalid.run(await plan(invalid), { workspace: directory, context: owner }); assert.equal(invalidResult.ok, false); assert.equal(invalidResult.artifacts.length, 0);
});
test('claimed files outside the controlled text output are rejected', async t => { const { coordinator, directory } = await setup(t, { runWorker: async () => ({ ok: true, finalText: '已生成合同', artifacts: [{ path: 'C:\\private\\contract.docx' }] }) }); const result = await coordinator.run(await plan(coordinator), { workspace: directory, context: owner }); assert.equal(result.ok, false); assert.equal(result.steps[0].error.code, 'UNVERIFIED_ARTIFACTS'); assert.equal(result.artifacts.length, 0); });
test('one failed analyst preserves the other output and skips dependent review', async t => { const { coordinator, directory } = await setup(t, { runWorker: async work => work.role === 'analyst-a' ? { ok: false, error: { code: 'ENGINE_FAILURE', message: 'secret=value' } } : { ok: true, finalText: '乙的完整分析。' } }); const result = await coordinator.run(await plan(coordinator, { workflow: 'research-compare' }), { workspace: directory, context: owner }); assert.equal(result.ok, false); assert.equal(result.status, 'partial'); assert.equal(result.steps[0].status, 'failed'); assert.equal(result.steps[1].status, 'succeeded'); assert.equal(result.steps[2].status, 'skipped'); assert.equal(result.artifacts.length, 1); assert.equal(JSON.stringify(result).includes('secret=value'), false); });
test('cancelling one analyst does not stop an unrelated analyst', async t => {
  let ready; const started = new Promise(resolve => { ready = resolve; }); let running = 0;
  const { coordinator, directory } = await setup(t, { runWorker: async work => { running++; if (running === 2) ready(); if (work.role === 'analyst-a') await new Promise((resolve, reject) => work.signal.addEventListener('abort', () => reject(Error('stopped')), { once: true })); else await wait(80); return { ok: true, finalText: '乙正常完成。' }; } }); const proposal = await plan(coordinator, { workflow: 'research-compare' }); const pending = coordinator.run(proposal, { workspace: directory, context: owner }); await started; await coordinator.cancelWorker(proposal.id, 'analyze-a', owner); const result = await pending; assert.equal(result.steps[0].status, 'cancelled'); assert.equal(result.steps[1].status, 'succeeded'); assert.equal(result.status, 'partial'); assert.equal(result.cancellation.stopped, true);
});
test('cancelling one plan leaves another plan running', async t => {
  let starts = 0, ready; const started = new Promise(resolve => { ready = resolve; });
  const { coordinator, directory } = await setup(t, { runWorker: async work => { starts++; if (starts === 2) ready(); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 90); work.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('stopped')); }, { once: true }); }); return { ok: true, finalText: '正常成果' }; } }); const first = await plan(coordinator), second = await plan(coordinator); const a = coordinator.run(first, { workspace: directory, context: owner }), b = coordinator.run(second, { workspace: directory, context: owner }); await started; await coordinator.cancel(first.id, owner); const [cancelled, complete] = await Promise.all([a, b]); assert.equal(cancelled.status, 'cancelled'); assert.equal(complete.ok, true);
});
test('deadline aborts workers and never accepts late success', async t => { const { coordinator, directory } = await setup(t, { runWorker: async work => { await new Promise(resolve => work.signal.addEventListener('abort', resolve, { once: true })); return { ok: true, finalText: '迟到的文字' }; } }); const result = await coordinator.run(await plan(coordinator, { budget: { deadlineMs: 25 } }), { workspace: directory, context: owner }); assert.equal(result.status, 'deadline_exceeded'); assert.equal(result.ok, false); assert.equal(result.artifacts.length, 0); });
test('uncooperative adapter is reported stop-unconfirmed and does not release concurrency early', async t => { let settle; let calls = 0; const { coordinator, directory } = await setup(t, { concurrency: 1, abortGraceMs: 50, runWorker: async () => { calls++; await new Promise(resolve => { settle = resolve; }); return { ok: true, finalText: '迟到结果' }; } }); const result = await coordinator.run(await plan(coordinator, { budget: { deadlineMs: 15 } }), { workspace: directory, context: owner }); assert.equal(result.cancellation.stopped, false); assert.equal(result.steps[0].status, 'stop_unconfirmed'); const blocked = await coordinator.run(await plan(coordinator, { budget: { deadlineMs: 15 } }), { workspace: directory, context: owner }); assert.equal(blocked.budget.callsUsed, 0); assert.equal(calls, 1); settle(); });

test('an ordinary hosted receipt with cancellation requested false and confirmed false succeeds and releases its slot', async t => {
  let calls = 0;
  const { coordinator, directory } = await setup(t, { concurrency: 1, runWorker: async () => {
    calls++; return { ok: true, finalText: '宿主已正常完成的文字成果。', cancellation: { requested: false, confirmed: false } };
  } });
  for (let index = 0; index < 2; index++) {
    const result = await coordinator.run(await plan(coordinator), { workspace: directory, context: owner });
    assert.equal(result.ok, true); assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.cancellation, { requested: false, stopped: true });
    assert.equal(result.artifacts.length, 2);
  }
  assert.equal(calls, 4, 'confirmed false without a cancellation request cannot reserve the slot forever');
});

test('a hosted unresolved stop remains unconfirmed and keeps its concurrency slot after the adapter returns', async t => {
  for (const receipt of [
    { cancellation: { requested: true, confirmed: false }, error: { code: 'HOST_RUNTIME_FAILED' } },
    { error: { code: 'CANCEL_UNCONFIRMED' } },
  ]) await t.test(receipt.error.code, async child => {
    let calls = 0;
    const { coordinator, directory } = await setup(child, { concurrency: 1, runWorker: async () => {
      calls++; return { ok: false, finalText: '', ...receipt };
    } });
    const result = await coordinator.run(await plan(coordinator), { workspace: directory, context: owner });
    assert.equal(result.ok, false); assert.equal(result.steps[0].status, 'stop_unconfirmed');
    assert.equal(result.steps[0].error.code, 'STOP_UNCONFIRMED');
    assert.deepEqual(result.cancellation, { requested: true, stopped: false });
    assert.equal(result.artifacts.length, 0);
    const blocked = await coordinator.run(await plan(coordinator, { budget: { deadlineMs: 25 } }), { workspace: directory, context: owner });
    assert.equal(blocked.budget.callsUsed, 0, 'an unresolved host may still be running after its adapter returns');
    assert.equal(calls, 1);
  });
});

test('an aborted worker that returns an unresolved host stop is not reported as confirmed cancelled', async t => {
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const { coordinator, directory } = await setup(t, { concurrency: 1, runWorker: async work => {
    calls++; started();
    await new Promise(resolve => work.signal.addEventListener('abort', resolve, { once: true }));
    return { ok: false, finalText: '', error: { code: 'CANCEL_UNCONFIRMED' }, cancellation: { requested: true, confirmed: false } };
  } });
  const proposal = await plan(coordinator), pending = coordinator.run(proposal, { workspace: directory, context: owner });
  await running; await coordinator.cancel(proposal.id, owner);
  const result = await pending;
  assert.equal(result.steps[0].status, 'stop_unconfirmed');
  assert.deepEqual(result.cancellation, { requested: true, stopped: false });
  assert.equal(result.artifacts.length, 0);
  const blocked = await coordinator.run(await plan(coordinator, { budget: { deadlineMs: 25 } }), { workspace: directory, context: owner });
  assert.equal(blocked.budget.callsUsed, 0); assert.equal(calls, 1);
});
test('worker cannot raise plan limits or create new tasks by returning extra fields', async t => { const { coordinator, directory } = await setup(t, { runWorker: async () => ({ ok: true, finalText: '实际文字', allowedActions: ['mail.read', 'shell.exec'], budget: { maxCalls: 999 }, nextTasks: [{ command: 'do anything' }] }) }); const result = await coordinator.run(await plan(coordinator, { budget: { maxCalls: 1 } }), { workspace: directory, context: owner }); assert.equal(result.budget.callsUsed, 1); assert.equal(result.status, 'partial'); assert.equal(result.steps[0].allowedActions, undefined); });
test('Harness adapter keeps credentials in trusted closure and passes separate workspaces', async () => { const calls = []; const settings = { env: { DEEPSEEK_API_KEY: 'fake-secret-test' }, profile: 'sdk' }; const adapter = createHarnessWorkerAdapter({ runtime: { runTask: async value => { calls.push(value); return { ok: true, finalText: '真实适配调用的替身' }; } }, settingsProvider: async value => ({ ...settings, home: path.join(value.workspace, 'harness-home') }) }); const work = { role: 'writer', prompt: '写作', workspace: 'G:\\fake-test-workspace', signal: new AbortController().signal, task: { parentTaskId: 'p' }, onEvent: () => {} }; const result = await adapter(work); assert.equal(result.ok, true); assert.equal(calls[0].settings.env.DEEPSEEK_API_KEY, 'fake-secret-test'); assert.equal(work.settings, undefined); assert.equal(calls[0].workspace, work.workspace); assert.match(calls[0].settings.home, /harness-home$/); });
test('store receives plans, step transitions and final result without a worker gaining store access', async t => { const recorded = { plans: [], steps: [], events: [], results: [] }; const { coordinator, directory } = await setup(t, { store: { savePlan: async value => recorded.plans.push(value), saveStep: async value => recorded.steps.push(value), saveEvent: async value => recorded.events.push(value), saveResult: async value => recorded.results.push(value) } }); const result = await coordinator.run(await plan(coordinator), { workspace: directory, context: owner }); assert.equal(recorded.plans.length, 1); assert.equal(recorded.results[0].planId, result.planId); assert.equal(recorded.steps.length, 4); assert.equal(recorded.events.at(-1).type, 'plan.finished'); });
