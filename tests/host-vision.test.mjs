import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostedBridge } from '../packages/harness-host-plugin/server.mjs';
import { prepareHostedPluginInstall } from '../packages/harness-host-plugin/prepare-install.mjs';
import { inspectHostedRuntime, runHostedTask } from '../packages/runtime-harness/hosted.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function image(index = 0, size = 32) {
  const bytes = Buffer.alloc(size, index);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  return { id: String(index).padStart(64, 'a'), mime: 'image/png', b64: bytes.toString('base64'), sha256: hash(bytes), bytes: bytes.length, name: `合成图片${index}.png` };
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(5); }
  throw Error('synthetic native image condition did not settle');
}

// Real HTTP host/client, isolated native service doubles. No model or WeChat send.
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xzs-native-vision-'));
  const workspaces = path.join(root, 'workspaces'), workspace = path.join(workspaces, 'owner');
  const tokenFile = path.join(root, 'token.txt'), token = 'synthetic-native-vision-local-token-12345678';
  await mkdir(workspace, { recursive: true }); await writeFile(tokenFile, token);
  const subscribers = new Set(), agents = new Map(), calls = [], saved = new Map();
  const emit = (session, event) => { for (const callback of subscribers) callback(session, event); };
  const llm = { async resolveModelInfo(provider, model, signal) {
    calls.push({ type: 'metadata', provider, model, signal });
    if (options.resolve) return options.resolve(signal);
    return { inputModalities: options.textModel ? ['text'] : ['text', 'image'] };
  } };
  const save = async inputs => {
    calls.push({ type: 'save-images', inputs });
    if (options.saveDelay) await options.saveDelay.promise;
    if (options.saveError) throw Error('synthetic-private-native-image-error');
    return inputs.map((input, index) => ({ attachmentId: 'sha256:' + hash(Buffer.from('normalized-' + index)), mediaType: 'image/webp', width: 1, height: 1, bytes: 24 }));
  };
  const attachments = options.saveSingle ? { saveImage: async input => (await save([input]))[0] } : { saveImages: save };
  const ctx = {
    on(name, fn) { if (name === 'session/event') subscribers.add(fn); return () => subscribers.delete(fn); },
    get(name) { return options.propertyServices ? undefined : name === 'llm' && !options.noLlm ? llm : name === 'attachments' && !options.noAttachments ? attachments : undefined; },
    agentPresets: { mount: async (_ctx, id) => ({ id }) },
    sessions: { async flush(session) {
      calls.push({ type: 'flush', sid: session.id, events: session.log.slice() });
      if (options.flushDelay) await options.flushDelay.promise;
      if (options.flushFalse) return false;
      saved.set(session.id, structuredClone(session.log)); return true;
    } },
    agents: { get: sid => agents.get(sid), create: input => makeAgent(input.sessionId, input), resume: input => makeAgent(input.resumeSessionId, input) },
  };
  if (options.propertyServices) { if (!options.noLlm) ctx.llm = llm; if (!options.noAttachments) ctx.attachments = attachments; }
  Object.defineProperty(ctx, 'credentials', { get() { throw Error('never inspect provider credentials'); } });
  async function makeAgent(sid, input) {
    const log = structuredClone(saved.get(sid) || []);
    const hidden = new Set();
    const session = { id: sid, header: { cwd: input.meta?.cwd || workspace }, log, hidden,
      get surface() { return { nodes: log.filter(event => event.type === 'user/message' && !hidden.has(event.seq)).map(event => event.seq) }; },
      eventAt: seq => log[seq],
      deriveEventMessage(event) { return this.projectedMessages().find(item => item.seq === event.seq)?.message; },
      append(type, data) {
        if (type === 'image/offload' && options.offloadError) throw Error('synthetic-private-offload-error');
        if (type === 'image/offload') for (const target of data.targets) {
          const blocks = this.deriveEventMessage(log[target.seq]).content.filter(block => block.type === 'image');
          for (const index of target.imageIndexes) if (blocks[index]?.offloaded) throw Error('native image already offloaded');
        }
        const event = { seq: log.length, type, data }; log.push(event); calls.push({ type, sid, data }); emit(session, event); return event;
      },
      projectedMessages() {
        const messages = log.filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, message: structuredClone(event.data) }));
        for (const event of log.filter(event => event.type === 'image/offload')) for (const target of event.data.targets) {
          const message = messages.find(item => item.seq === target.seq)?.message; let index = 0;
          for (const block of message?.content || []) if (block.type === 'image') { if (target.imageIndexes.includes(index)) block.offloaded = true; index++; }
        }
        return messages;
      },
      history() { return this.projectedMessages().filter(item => !hidden.has(item.seq)).map(item => item.message); },
    };
    const agentCtx = { tools: { guard(fn) { this.check = fn; }, presentAs() {}, register: () => () => {} }, on() {} };
    await input.setup(agentCtx);
    const agent = { ctx: agentCtx, session, turn: 0, status: 'idle',
      followup(message) {
        calls.push({ type: 'prompt', message, sid, priorHistory: session.history() });
        this.status = 'running'; this.turn++;
        session.append('turn/start', { turn: this.turn });
        if (!options.skipAdmission) session.append('user/message', message);
        if (options.behaviour) options.behaviour(agent);
        else queueMicrotask(() => {
          session.append('assistant/message', { turn: this.turn, message: { content: [{ type: 'text', text: '合成图片协议回复' }] } });
          this.status = 'idle'; session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } });
        });
      },
      cancel() { calls.push({ type: 'cancel', sid }); if (!options.ignoreCancel) queueMicrotask(() => { this.status = 'idle'; session.append('turn/end', { turn: this.turn, reason: { kind: 'cancelled' } }); }); },
    };
    agents.set(sid, agent); return { dispose() { agents.delete(sid); } };
  }
  let bridge, endpoint, settings, closed = false;
  async function start() {
    bridge = await createHostedBridge(ctx, { productDataRoot: root, workspacesRoot: workspaces, tokenFile, port: 0, cancelConfirmMs: 30, ...options.config }, { createUserMessage: value => ({ ...value, role: 'user', id: randomUUID() }) });
    endpoint = await bridge.listen(); closed = false;
    settings = { hostedEndpoint: endpoint, hostedTokenFile: tokenFile, hostedPollMs: 20, hostedCancelWaitMs: 500 };
  }
  await start();
  async function close() { if (!closed) { closed = true; await bridge.close(); } }
  t.after(async () => {
    await close();
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('xzs-native-vision-'));
    await rm(root, { recursive: true, force: true });
  });
  function raw(route, value, method = value === undefined ? 'GET' : 'POST') {
    return new Promise((resolve, reject) => {
      const request = http.request(endpoint + route, { method, headers: { authorization: 'Bearer ' + token } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      request.on('error', reject); request.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }
  const submit = value => raw('/tasks', { taskId: randomUUID(), prompt: '查看合成图片', workspace, ...value });
  const wait = id => until(async () => { const value = (await raw('/tasks/' + id)).body; return ['completed', 'failed', 'cancelled', 'stop_unconfirmed'].includes(value.status) && value; });
  return { root, workspace, workspaces, raw, submit, wait, calls, agents, ctx, close, start, get settings() { return settings; } };
}

test('real HTTP host and client admit native images then continue two text turns without live images', async t => {
  const f = await fixture(t, { propertyServices: true });
  const health = await inspectHostedRuntime(f.settings);
  assert.equal(health.capabilities.images, true); assert.equal(f.calls.some(call => call.type === 'prompt'), false);
  const supplied = image();
  const first = await runHostedTask({ prompt: '看这张图', images: [supplied], workspace: f.workspace, settings: f.settings });
  assert.equal(first.ok, true);
  const prompt = f.calls.find(call => call.type === 'prompt');
  assert.deepEqual(prompt.message.content.map(block => block.type), ['text', 'image']);
  assert.notEqual(prompt.message.content[1].attachment.attachmentId, 'sha256:' + supplied.sha256, 'normalization may change the digest');
  assert.equal(prompt.message.source.authority, 'text-only');
  assert.deepEqual(f.calls.find(call => call.type === 'save-images').inputs[0].data, Buffer.from(supplied.b64, 'base64'));
  for (let n = 0; n < 2; n++) {
    const result = await runHostedTask({ prompt: '继续文字 ' + n, workspace: f.workspace, sessionId: first.sessionId, settings: f.settings });
    assert.equal(result.ok, true);
    const next = f.calls.filter(call => call.type === 'prompt').at(-1);
    assert.equal(next.message.content.some(block => block.type === 'image'), false);
    assert.equal(next.priorHistory.flatMap(message => message.content).filter(block => block.type === 'image' && !block.offloaded).length, 0);
  }
  const offload = f.calls.find(call => call.type === 'image/offload');
  assert.deepEqual(offload.data.targets, [{ seq: 1, imageIndexes: [0] }]);
  assert.ok(f.calls.indexOf(offload) < f.calls.findIndex(call => call.type === 'flush'));
  assert.equal(f.calls.filter(call => call.type === 'save-images').length, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'harness-host', 'sessions.json'), 'utf8')).sessions[first.sessionId].pendingImageTaskId, undefined);
});

test('health requires actual model metadata plus attachment service; text remains compatible', async t => {
  for (const options of [{ noLlm: true }, { noAttachments: true }, { textModel: true }, { resolve: async () => { throw Error('synthetic-native-private-message'); } }]) {
    const f = await fixture(t, options);
    assert.equal((await f.raw('/health')).body.capabilities.images, false);
    const task = await f.submit({ images: [image()] });
    const done = await f.wait(task.body.taskId);
    assert.equal(done.status, 'failed');
    assert.ok(['HOST_IMAGES_UNSUPPORTED', 'IMAGE_PREPARATION_FAILED'].includes(done.result.error.code));
    assert.equal(f.calls.some(call => call.type === 'save-images' || call.type === 'prompt'), false);
    const text = await f.submit({ images: [] }); assert.equal((await f.wait(text.body.taskId)).status, 'completed');
    assert.doesNotMatch(JSON.stringify(done), /synthetic-native-private-message/);
  }
});

test('health metadata timeout is bounded and resolver receives an aborted signal', async t => {
  const f = await fixture(t, { resolve: () => new Promise(() => {}), config: { imagePrepareTimeoutMs: 50 } });
  const begin = Date.now();
  assert.equal((await f.raw('/health')).body.capabilities.images, false);
  assert.ok(Date.now() - begin < 1000);
  assert.equal(f.calls[0].signal.aborted, true);
  const task = await f.submit({ images: [image()] });
  assert.equal((await f.wait(task.body.taskId)).result.error.code, 'IMAGE_PREPARATION_TIMEOUT');
});

test('host rejects forged image bytes before any native work and keeps text at 256 KiB', async t => {
  const f = await fixture(t), original = image();
  const badInputs = [null, [original, original, original, original, original],
    [{ ...original, b64: original.b64 + '\n' }], [{ ...original, bytes: original.bytes + 1 }],
    [{ ...original, sha256: 'b'.repeat(64) }], [{ ...original, mime: 'image/jpeg' }],
    [{ ...original, name: '../private.png' }], [{ ...original, path: 'C:/private.png' }]];
  for (const images of badInputs) { const reply = await f.submit({ images }); assert.equal(reply.status, 400); assert.match(reply.body.error.code, /^IMAGE_/); }
  const oversizedText = await f.submit({ prompt: 'x'.repeat(256 * 1024 + 1), images: [original] });
  assert.equal(oversizedText.status, 413);
  assert.equal(f.calls.length, 0);
});

test('four maximum-size images fit the bounded HTTP body and use ordered native references', async t => {
  const f = await fixture(t), images = Array.from({ length: 4 }, (_, index) => image(index, 768 * 1024));
  const task = await f.submit({ images, prompt: 'x'.repeat(256 * 1024) });
  assert.equal(task.status, 202); assert.equal((await f.wait(task.body.taskId)).status, 'completed');
  assert.deepEqual(f.calls.find(call => call.type === 'image/offload').data.targets, [{ seq: 1, imageIndexes: [0, 1, 2, 3] }]);
  const tooLarge = await f.submit({ images: [image(0, 768 * 1024 + 1)] });
  assert.equal(tooLarge.status, 400); assert.equal(tooLarge.body.error.code, 'IMAGE_SIZE_EXCEEDED');
  assert.equal((await f.submit({ extra: 'x'.repeat(6 * 1024 * 1024) })).status, 413);
});

test('idempotent tasks bind verified image order, digest and display name', async t => {
  const f = await fixture(t), taskId = randomUUID(), images = [image(1), image(2)];
  const [a, b] = await Promise.all([f.submit({ taskId, images }), f.submit({ taskId, images })]);
  assert.equal(a.body.taskId, b.body.taskId); await f.wait(taskId);
  assert.equal(f.calls.filter(call => call.type === 'prompt').length, 1);
  for (const changed of [images.toReversed(), [image(3), images[1]], [{ ...images[0], name: '改名.png' }, images[1]], []]) {
    const reply = await f.submit({ taskId, images: changed }); assert.equal(reply.status, 409); assert.equal(reply.body.error.code, 'TASK_CONFLICT');
  }
});

test('cancel during metadata or attachment save never follows up after late completion or close', async t => {
  for (const stage of ['metadata', 'save']) {
    const gate = deferred();
    const f = await fixture(t, stage === 'metadata' ? { resolve: () => gate.promise } : { saveDelay: gate });
    const task = await f.submit({ images: [image()] });
    await until(() => f.calls.some(call => call.type === (stage === 'metadata' ? 'metadata' : 'save-images')));
    await f.raw('/tasks/' + task.body.taskId, undefined, 'DELETE');
    const done = await f.wait(task.body.taskId); assert.equal(done.status, 'cancelled'); assert.equal(done.cancellation.confirmed, true);
    await f.close(); const before = f.calls.length;
    gate.resolve({ inputModalities: ['text', 'image'] }); await pause(25);
    assert.equal(f.calls.length, before); assert.equal(f.calls.some(call => call.type === 'prompt' || call.type === 'flush'), false);
  }
});

test('confirmed failure and cancellation offload and flush before publishing terminal receipts', async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t, { saveSingle: true, behaviour(agent) {
      if (!cancelled) { agent.status = 'idle'; agent.session.append('turn/end', { turn: agent.turn, reason: { kind: 'failed' } }); }
    } });
    const task = await f.submit({ images: [image()] });
    await until(() => f.calls.some(call => call.type === 'prompt'));
    if (cancelled) await f.raw('/tasks/' + task.body.taskId, undefined, 'DELETE');
    const done = await f.wait(task.body.taskId);
    assert.equal(done.status, cancelled ? 'cancelled' : 'failed'); assert.equal(done.nativeTerminal, true);
    assert.equal(f.calls.filter(call => call.type === 'image/offload').length, 1);
    assert.equal(f.calls.filter(call => call.type === 'flush').length, 1);
    assert.equal(done.cancellation.confirmed, cancelled);
  }
});

test('unconfirmed stop holds image session until a real late turn/end permits cleanup', async t => {
  const f = await fixture(t, { ignoreCancel: true, behaviour() {} });
  const task = await f.submit({ images: [image()] }); await until(() => f.calls.some(call => call.type === 'prompt'));
  await f.raw('/tasks/' + task.body.taskId, undefined, 'DELETE');
  const unknown = await f.wait(task.body.taskId);
  assert.equal(unknown.status, 'stop_unconfirmed'); assert.equal(unknown.nativeTerminal, false); assert.equal(unknown.cancellation.confirmed, false);
  assert.equal(f.calls.some(call => call.type === 'image/offload' || call.type === 'flush'), false);
  assert.equal((await f.submit({ sessionId: task.body.sessionId })).body.error.code, 'SESSION_BUSY');
  const agent = f.agents.get(task.body.sessionId); agent.status = 'idle'; agent.session.append('turn/end', { turn: agent.turn, reason: { kind: 'cancelled' } });
  const done = await until(async () => { const value = (await f.raw('/tasks/' + task.body.taskId)).body; return value.status === 'cancelled' && value; });
  assert.equal(done.nativeTerminal, true); assert.equal(f.calls.filter(call => call.type === 'image/offload').length, 1);
});

test('image cleanup stays saving and locked until durable flush has completed', async t => {
  const gate = deferred(), f = await fixture(t, { flushDelay: gate });
  const task = await f.submit({ images: [image()] });
  await until(() => f.calls.some(call => call.type === 'flush'));
  const saving = (await f.raw('/tasks/' + task.body.taskId)).body;
  assert.equal(saving.status, 'saving'); assert.equal(saving.nativeTerminal, false);
  assert.equal((await f.submit({ sessionId: task.body.sessionId })).body.error.code, 'SESSION_BUSY');
  gate.resolve(); assert.equal((await f.wait(task.body.taskId)).status, 'completed');
});

test('native compaction can offload a subset or remove the message before terminal cleanup', async t => {
  for (const compacted of [false, true]) {
    const f = await fixture(t, { behaviour(agent) {
      const user = agent.session.log.find(event => event.type === 'user/message');
      if (compacted) agent.session.hidden.add(user.seq);
      else agent.session.append('image/offload', { targets: [{ seq: user.seq, imageIndexes: [1] }] });
      agent.session.append('assistant/message', { turn: agent.turn, message: { content: [{ type: 'text', text: '原生压缩后的合成回复' }] } });
      agent.status = 'idle'; agent.session.append('turn/end', { turn: agent.turn, reason: { kind: 'completed' } });
    } });
    const task = await f.submit({ images: [image(1), image(2)] });
    assert.equal((await f.wait(task.body.taskId)).status, 'completed');
    const unloads = f.calls.filter(call => call.type === 'image/offload');
    assert.equal(unloads.length, compacted ? 0 : 2);
    if (!compacted) assert.deepEqual(unloads[1].data.targets, [{ seq: 1, imageIndexes: [0] }]);
    const state = JSON.parse(await readFile(path.join(f.root, 'harness-host', 'sessions.json'), 'utf8'));
    assert.equal(state.sessions[task.body.sessionId].pendingImageTaskId, undefined);
  }
});

test('failed image cleanup is quarantined durably across host restart', async t => {
  for (const options of [{ flushFalse: true }, { offloadError: true }, { skipAdmission: true }]) {
    const f = await fixture(t, options), task = await f.submit({ images: [image()] });
    const done = await f.wait(task.body.taskId);
    assert.equal(done.status, 'failed'); assert.match(done.result.error.code, /^IMAGE_/);
    const saved = JSON.parse(await readFile(path.join(f.root, 'harness-host', 'sessions.json'), 'utf8'));
    assert.equal(saved.sessions[task.body.sessionId].pendingImageTaskId, task.body.taskId);
    await f.close(); await f.start();
    assert.equal((await f.submit({ sessionId: task.body.sessionId })).body.error.code, 'SESSION_IMAGE_CLEANUP_REQUIRED');
    assert.equal(f.calls.filter(call => call.type === 'prompt').length, 1);
  }
});

test('standalone installation copies the shared contract and revisioned image dependencies', async t => {
  const f = await fixture(t), installDirectory = path.join(f.root, 'plugins', 'host');
  const installed = await prepareHostedPluginInstall({ productDataRoot: f.root, workspacesRoot: f.workspaces, installDirectory });
  const server = await readFile(path.join(installDirectory, 'server.mjs'), 'utf8');
  assert.ok(server.includes('./contract-image-input-' + installed.revision + '.mjs'));
  assert.ok(server.includes('./image-input-' + installed.revision + '.mjs'));
  assert.doesNotMatch(server, /\.\.\/contracts\//);
  const contract = await import(pathToFileURL(path.join(installDirectory, 'contract-image-input.mjs')).href);
  assert.equal(contract.validateTaskImages([image()]).length, 1);
  const standalone = await import(pathToFileURL(path.join(installDirectory, 'server.mjs')).href);
  assert.equal(typeof standalone.createHostedBridge, 'function');
});
