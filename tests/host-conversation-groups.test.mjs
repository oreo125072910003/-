import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createHostedBridge } from '../packages/harness-host-plugin/server.mjs';
import { OWNER_ACCESS } from '../packages/harness-host-plugin/owner-access.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xzs-native-groups-'));
  const workspaces = path.join(root, 'tasks'), workspace = path.join(workspaces, 'conversations', 'wechat_' + 'a'.repeat(64));
  await mkdir(workspace, { recursive: true });
  const token = 'synthetic-native-groups-token-not-a-real-credential', tokenFile = path.join(root, 'token.txt');
  await writeFile(tokenFile, token);
  const agents = new Map(), stored = new Map(), groups = new Map(), subscribers = new Set(), calls = [];
  let registryTail = Promise.resolve(), bridge, endpoint;
  const emit = (session, type, data) => { for (const subscriber of subscribers) subscriber(session, { type, data }); };
  const titles = {
    get: session => session.snapshotEvents().findLast(event => event.type === 'session/title')?.data,
    rename(session, title) { calls.push({ type: 'rename', sid: session.id }); session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } }); },
  };
  function groupAt(directory, title = '合成测试工作空间') {
    const group = { id: randomUUID(), path: directory, title, sessionIds: [],
      async attachSession(sid) {
        calls.push({ type: 'attach', sid });
        if (options.attachFailure) throw new Error('synthetic-private-contact-name');
        const header = stored.get(sid)?.header;
        assert.ok(header, 'the native header must be flushed before attachment');
        assert.equal(await realpath(header.cwd), directory, 'native membership validates exact canonical cwd');
        if (!group.sessionIds.includes(sid)) group.sessionIds.push(sid);
      },
    };
    groups.set(group.id, group); return group;
  }
  const registry = {
    archivedSessionIds: [], get: id => groups.get(id), list: () => [...groups.values()],
    async resolveByPath(directory) {
      calls.push({ type: 'resolve', directory });
      if (options.resolveDelay) await pause(options.resolveDelay);
      return [...groups.values()].find(group => group.path === directory);
    },
    create(directory, title) {
      const job = registryTail.then(async () => {
        const prior = [...groups.values()].find(group => group.path === directory);
        if (prior) return prior;
        calls.push({ type: 'group-create', directory }); return groupAt(directory, title);
      });
      registryTail = job.catch(() => {}); return job;
    },
  };
  const ctx = {
    on(name, callback) { if (name === 'session/event') subscribers.add(callback); return () => subscribers.delete(callback); },
    get(name) { return name === 'workspaceRegistry' ? options.noRegistry ? undefined : registry : name === 'sessionTitle' ? options.noTitleService ? undefined : titles : undefined; },
    agentPresets: { async mount(_ctx, id) { return { id }; } },
    sessions: { async flush(session) {
      calls.push({ type: 'flush', sid: session.id });
      if (options.flushFalse) return false;
      stored.set(session.id, structuredClone({ header: session.header, events: session.snapshotEvents() }));
      await writeFile(path.join(root, 'native-sessions.json'), JSON.stringify([...stored]));
      return true;
    } },
    agents: {
      get: sid => agents.get(sid),
      create: input => makeAgent(input.sessionId, input, false),
      resume: input => makeAgent(input.resumeSessionId, input, true),
    },
  };
  Object.defineProperty(ctx, 'credentials', { get() { throw Error('model credentials must remain with Harness'); } });
  async function makeAgent(sid, input, resumed) {
    calls.push({ type: resumed ? 'resume' : 'create', sid });
    const previous = resumed ? stored.get(sid) : undefined;
    if (resumed) assert.ok(previous, 'resume must use the persisted native session');
    const log = structuredClone(previous?.events || []);
    const session = { id: sid, header: previous?.header || { id: sid, ...input.meta },
      snapshotEvents: () => log.slice(), append(type, data) { log.push({ type, data }); emit(session, type, data); } };
    const agentCtx = { tools: { presentAs() {}, guard(fn) { this.check = fn; }, register() { return () => {}; } }, on() {} };
    await input.setup(agentCtx);
    const agent = { ctx: agentCtx, session, status: 'idle', turn: 0,
      followup(message) {
        calls.push({ type: 'prompt', sid, message, toolDenied: typeof agentCtx.tools.check({ name: 'shell' }) === 'string', ownerGranted: (agentCtx[OWNER_ACCESS]?.names().size || 0) > 0 });
        agent.status = 'running'; agent.turn++;
        emit(session, 'turn/start', { turn: agent.turn });
        queueMicrotask(() => {
          emit(session, 'assistant/message', { turn: agent.turn, message: { content: [{ type: 'text', text: '合成原生回复' }] } });
          agent.status = 'idle'; emit(session, 'turn/end', { turn: agent.turn, reason: { kind: 'completed' } });
        });
      },
      cancel() { agent.status = 'idle'; emit(session, 'turn/end', { turn: agent.turn, reason: { kind: 'cancelled' } }); },
    };
    agents.set(sid, agent); return { dispose() { agents.delete(sid); } };
  }
  async function start() {
    bridge = await createHostedBridge(ctx, { productDataRoot: root, workspacesRoot: workspaces, tokenFile, port: 0 }, { createUserMessage: value => value });
    endpoint = await bridge.listen();
  }
  await start();
  t.after(async () => { await bridge.close(); await rm(root, { recursive: true, force: true }); });
  function raw(route, body, method = body === undefined ? 'GET' : 'POST') {
    return new Promise((resolve, reject) => {
      const request = http.request(endpoint + route, { method, headers: { authorization: 'Bearer ' + token } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async function wait(id) {
    for (let n = 0; n < 200; n++) {
      const value = (await raw('/tasks/' + id)).body;
      if (['completed', 'failed', 'cancelled', 'stop_unconfirmed'].includes(value.status)) return value;
      await pause(5);
    }
    throw Error('synthetic native task did not settle');
  }
  async function run(value = {}) {
    const response = await raw('/tasks', { taskId: randomUUID(), prompt: '合成消息', workspace, ...value });
    return response.status === 202 ? wait(response.body.taskId) : response.body;
  }
  return { root, workspaces, workspace, calls, groups, agents, registry, groupAt, raw, wait, run,
    async restart() { await bridge.close(); await start(); } };
}

test('new product conversations use native canonical workspace membership and a display-only title', async t => {
  const f = await fixture(t);
  const result = await f.run({ conversation: { channel: 'wechat', displayName: '合成联系人' } });
  assert.equal(result.status, 'completed');
  const group = [...f.groups.values()][0];
  assert.equal(group.path, await realpath(f.workspace)); assert.equal(group.title, '小助手 · 微信 · 合成联系人');
  assert.deepEqual(group.sessionIds, [result.sessionId]); assert.equal(result.groupId, group.id);
  assert.equal(f.agents.get(result.sessionId).session.snapshotEvents()[0].data.title, group.title);
  const prompt = f.calls.find(call => call.type === 'prompt');
  assert.equal(prompt.toolDenied, true); assert.equal(prompt.ownerGranted, false);
  assert.equal(prompt.message.source.authority, 'text-only'); assert.doesNotMatch(prompt.message.content[0].text, /合成联系人/);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'prompt').length, 1);
  const saved = JSON.parse(await readFile(path.join(f.root, 'harness-host', 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions[result.sessionId].groupId, group.id);
  assert.equal((await f.raw('/health')).body.capabilities.sessionGroups, true);
});

test('continuing the same session preserves user titles, membership and native group identity', async t => {
  const f = await fixture(t);
  const group = f.groupAt(await realpath(f.workspace), '主人已有的分类');
  const first = await f.run({ conversation: { channel: 'wechat', displayName: '首次名字' } });
  f.agents.get(first.sessionId).session.append('session/title', { title: '主人自定义对话名', messageSeqs: [], source: { kind: 'user' } });
  const second = await f.run({ sessionId: first.sessionId, conversation: { channel: 'wechat', displayName: '更新名字' } });
  assert.equal(second.status, 'completed'); assert.equal(second.sessionId, first.sessionId);
  assert.equal(group.title, '主人已有的分类'); assert.equal(second.groupId, group.id);
  assert.equal(f.agents.get(first.sessionId).session.snapshotEvents().findLast(event => event.type === 'session/title').data.title, '主人自定义对话名');
  assert.equal(f.calls.filter(call => call.type === 'attach').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'rename').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'group-create').length, 0);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
});

test('host reload resumes the saved native conversation without duplicating sessions or groups', async t => {
  const f = await fixture(t);
  const first = await f.run({ conversation: { channel: 'wechat', displayName: '持久合成联系人' } });
  await f.restart();
  const next = await f.run({ sessionId: first.sessionId, conversation: { channel: 'wechat', displayName: '持久合成联系人' } });
  assert.equal(next.status, 'completed'); assert.equal(next.groupId, first.groupId); assert.equal(next.sessionId, first.sessionId);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'resume').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'group-create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'attach').length, 1);
});

test('an existing unclassified product session gains native classification without replacing its history', async t => {
  const options = { noRegistry: true }, f = await fixture(t, options);
  const first = await f.run();
  assert.equal(first.status, 'completed'); assert.equal(first.groupId, undefined);
  options.noRegistry = false;
  await f.restart();
  const resumed = await f.run({ sessionId: first.sessionId, conversation: { channel: 'wechat', displayName: '迁移合成联系人' } });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.sessionId, first.sessionId); assert.ok(resumed.groupId);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'resume').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'group-create').length, 1);
  const saved = JSON.parse(await readFile(path.join(f.root, 'harness-host', 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions[first.sessionId].groupId, resumed.groupId);
});

test('different conversation directories have different groups while concurrent same-path sessions reuse one group', async t => {
  const f = await fixture(t), other = path.join(f.workspaces, 'conversations', 'wechat_' + 'b'.repeat(64));
  await mkdir(other);
  const [one, two, three] = await Promise.all([
    f.run({ conversation: { channel: 'wechat', displayName: '甲' } }),
    f.run({ conversation: { channel: 'wechat', displayName: '甲' } }),
    f.run({ workspace: other, conversation: { channel: 'mail', displayName: '乙' } }),
  ]);
  assert.ok([one, two, three].every(result => result.status === 'completed'));
  assert.equal(one.groupId, two.groupId); assert.notEqual(one.groupId, three.groupId);
  assert.equal(f.groups.size, 2); assert.equal(f.calls.filter(call => call.type === 'group-create').length, 2);
});

test('display metadata cannot supply authorization, session identity or arbitrary group paths', async t => {
  const f = await fixture(t);
  for (const conversation of [null, [], { channel: 'unknown' }, { channel: {} }, { channel: 'wechat', displayName: {} },
    { channel: 'wechat', path: os.tmpdir() }, { channel: 'wechat', authority: 'product-owner' },
    { channel: 'wechat', ownerGrants: { tools: ['shell'] } }, { channel: 'wechat', displayName: 'x'.repeat(1025) }]) {
    const response = await f.raw('/tasks', { prompt: '合成消息', workspace: f.workspace, conversation });
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'INVALID_CONVERSATION');
  }
  assert.equal(f.calls.length, 0);
});

test('conversation classification fails visibly without a registry while older metadata-free clients remain compatible', async t => {
  const f = await fixture(t, { noRegistry: true });
  const failed = await f.run({ conversation: { channel: 'wechat', displayName: '合成联系人' } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.result.error.code, 'SESSION_GROUP_UNAVAILABLE');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.raw('/health')).body.capabilities.sessionGroups, false);
  assert.equal((await f.run()).status, 'completed');
});

test('native classification or durable-save failures never submit a prompt or expose backend contact errors', async t => {
  const badAttach = await fixture(t, { attachFailure: true });
  const failed = await badAttach.run({ conversation: { channel: 'wechat', displayName: '合成联系人' } });
  assert.equal(failed.status, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /synthetic-private-contact-name/);
  assert.equal(badAttach.calls.filter(call => call.type === 'prompt').length, 0);
  const unsaved = await fixture(t, { flushFalse: true });
  const result = await unsaved.run({ conversation: { channel: 'wechat' } });
  assert.equal(result.result.error.code, 'SESSION_GROUP_SAVE_FAILED');
  assert.equal(unsaved.calls.filter(call => call.type === 'attach' || call.type === 'prompt').length, 0);
});

test('canonical directory aliases reuse native groups and outside-workspace aliases remain rejected', async t => {
  const f = await fixture(t), alias = path.join(f.workspaces, 'conversation-alias');
  await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const one = await f.run({ conversation: { channel: 'wechat' } });
  const two = await f.run({ workspace: alias, sessionId: one.sessionId, conversation: { channel: 'wechat' } });
  assert.equal(two.status, 'completed'); assert.equal(one.groupId, two.groupId); assert.equal(f.groups.size, 1);
  const outside = path.join(f.root, 'outside'), escape = path.join(f.workspaces, 'escape');
  await mkdir(outside); await symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.run({ workspace: escape, conversation: { channel: 'wechat' } })).error.code, 'WORKSPACE_REFUSED');
  assert.equal(f.groups.size, 1);
});

test('archived sessions stay archived and cancelled classification does not start a native inference', async t => {
  const f = await fixture(t);
  const first = await f.run({ conversation: { channel: 'wechat' } });
  f.registry.archivedSessionIds.push(first.sessionId);
  assert.equal((await f.run({ sessionId: first.sessionId, conversation: { channel: 'wechat' } })).error.code, 'SESSION_ARCHIVED');
  assert.equal(f.calls.filter(call => call.type === 'prompt').length, 1);
  const delayed = await fixture(t, { resolveDelay: 80 });
  const response = await delayed.raw('/tasks', { prompt: '合成消息', workspace: delayed.workspace, conversation: { channel: 'wechat' } });
  await delayed.raw('/tasks/' + response.body.taskId, undefined, 'DELETE');
  assert.equal((await delayed.wait(response.body.taskId)).status, 'cancelled');
  await pause(100);
  assert.equal(delayed.calls.filter(call => call.type === 'create' || call.type === 'prompt').length, 0);
  assert.equal(delayed.groups.size, 0);
});

test('native title events support absent optional title service with bounded safe Unicode display text', async t => {
  const f = await fixture(t, { noTitleService: true });
  const result = await f.run({ conversation: { channel: 'wechat', displayName: '\u001b\u202e 合成联系人😀 '.repeat(20) } });
  assert.equal(result.status, 'completed');
  const title = f.agents.get(result.sessionId).session.snapshotEvents()[0].data.title;
  assert.match(title, /^小助手 · 微信 · /); assert.ok(Buffer.byteLength(title) <= 75);
  assert.doesNotMatch(title, /[\u001b\u202e\ufffd]/); assert.equal(Buffer.from(title).toString('utf8'), title);
  assert.equal(f.calls.filter(call => call.type === 'rename').length, 0);
});

test('idempotent requests include normalized display metadata and never submit a duplicate turn', async t => {
  const f = await fixture(t), taskId = randomUUID();
  const body = { taskId, prompt: '合成消息', workspace: f.workspace, conversation: { channel: 'wechat', displayName: '甲' } };
  const first = await f.raw('/tasks', body); await f.wait(taskId);
  const repeated = await f.raw('/tasks', body);
  assert.equal(repeated.body.sessionId, first.body.sessionId); assert.equal(f.calls.filter(call => call.type === 'prompt').length, 1);
  const conflict = await f.raw('/tasks', { ...body, conversation: { channel: 'wechat', displayName: '乙' } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'TASK_CONFLICT');
});
