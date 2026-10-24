import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantService } from '../apps/service/index.mjs';
import { createStore } from '../packages/storage/index.mjs';

const MCP_FIXTURE = String.raw`
import readline from 'node:readline';
const input=readline.createInterface({input:process.stdin});
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
input.on('line',line=>{const message=JSON.parse(line);
  if(message.method==='initialize')send(message.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'bundled-upgrade-fixture',version:'2.0.0'}});
  if(message.method==='tools/list')send(message.id,{tools:['get_contract_schema','preview_contract','generate_contract'].map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:false}}))});
  if(message.method==='tools/call')send(message.id,{isError:false,content:[{type:'text',text:'New bundled executable answered.'}]});
});
input.on('close',()=>process.exit(0));
`;
const hostedRuntime = {
  inspectHostedRuntime: async () => ({ available: true, credentialsSource: 'harness-existing-login' }),
  runHostedTask: async () => ({ ok: true, finalText: '小助手 DSH 的合成回归回复。' }),
};
function vault() {
  const values = new Map();
  return { get: async key => values.get(key), set: async (key, value) => values.set(key, value), delete: async key => values.delete(key) };
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-builtin-upgrade-'));
  const dataDir = path.join(directory, 'product'), oldCommand = path.join(directory, 'old-contract.exe');
  const newEntry = path.join(directory, 'new-contract.mjs');
  fs.writeFileSync(oldCommand, 'Synthetic old package, never executed.');
  fs.writeFileSync(newEntry, MCP_FIXTURE);
  const builtin = { id: 'contract-helper', name: '内置合同助手', version: '2.0.0', source: 'bundled-synthetic-contract',
    command: process.execPath, args: [newEntry], allowedTools: ['get_contract_schema', 'preview_contract', 'generate_contract'], permissions: ['contract.read', 'contract.generate'] };
  let service;
  const open = async options => service = await createAssistantService({ dataDir, runtime: hostedRuntime, secretStore: vault(), ...options });
  const close = async () => { await service?.close(); service = undefined; };
  t.after(async () => { await close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, dataDir, oldCommand, builtin, open, close };
}

test('reopening after the old bundled path disappears upgrades its executable without widening grants', async t => {
  const { dataDir, oldCommand, builtin, open, close } = fixture(t);
  let service = await open();
  await service.installMcp({ ...builtin, version: '1.0.0', command: oldCommand, args: [],
    allowedTools: ['get_contract_schema', 'legacy_only'], permissions: ['contract.read', 'legacy.permission'] });
  await service.enableMcp(builtin.id);
  await close();
  fs.unlinkSync(oldCommand);

  service = await open({ builtinMcp: [builtin] });
  let plugin = service.getExtensionsState().mcp[0];
  assert.equal(plugin.command, fs.realpathSync(process.execPath));
  assert.deepEqual(plugin.args, builtin.args);
  assert.equal(plugin.version, '2.0.0');
  assert.equal(plugin.enabled, false);
  assert.deepEqual(plugin.allowedTools, ['get_contract_schema']);
  assert.deepEqual(plugin.permissions, ['contract.read']);
  assert.equal(plugin.history[0].version, '1.0.0');
  const registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'extensions', 'registry.json'), 'utf8'));
  assert.equal(registry.mcp[builtin.id].history[0].command, oldCommand);
  await assert.rejects(service.testMcp(builtin.id), error => error.code === 'PLUGIN_DISABLED');

  await service.enableMcp(builtin.id);
  const report = await service.testMcp(builtin.id);
  assert.equal(report.serverInfo.name, 'bundled-upgrade-fixture');
  assert.deepEqual(report.tools.filter(tool => tool.authorized).map(tool => tool.name), ['get_contract_schema']);
  await assert.rejects(service.callMcpTool({ id: builtin.id, tool: 'generate_contract', args: {} }), error => error.code === 'TOOL_NOT_AUTHORIZED');
  assert.equal((await service.callMcpTool({ id: builtin.id, tool: 'get_contract_schema', args: {} })).ok, true);
  await close();

  service = await open({ builtinMcp: [builtin] });
  plugin = service.getExtensionsState().mcp[0];
  assert.equal(plugin.enabled, true, 'an unchanged bundle must not be disabled again on each launch');
  assert.equal(plugin.history.length, 1);
});

test('a user configured plugin with the same id is preserved and absent bundles are not installed automatically', async t => {
  const { oldCommand, builtin, open, close } = fixture(t);
  let service = await open({ builtinMcp: [builtin] });
  assert.equal(service.getExtensionsState().mcp.length, 0);
  await service.installMcp({ ...builtin, version: '1.0.0', source: 'user-installed-local', command: oldCommand, args: [], allowedTools: [], permissions: [] });
  await service.enableMcp(builtin.id);
  await close();

  service = await open({ builtinMcp: [builtin] });
  const plugin = service.getExtensionsState().mcp[0];
  assert.equal(plugin.source, 'user-installed-local');
  assert.equal(plugin.command, oldCommand);
  assert.equal(plugin.version, '1.0.0');
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.history.length, 0);
});

test('hosted settings preserve a legacy SDK home alias while saving personality and cannot switch the DSH core', async t => {
  const { directory, dataDir, open } = fixture(t);
  const oldHome = path.join(directory, 'old-appdata-alias', 'harness-home');
  const store = await createStore(path.join(dataDir, 'db'));
  store.saveSettings({ runtimeHome: oldHome, assistantName: '旧名字' });
  store.close();
  let calls = 0, submitted;
  const service = await open({ runtime: { ...hostedRuntime, runHostedTask: async value => { calls++; submitted = value; return { ok: true, finalText: '仍由小助手 DSH 交付。' }; }, runTask: async () => { throw Error('legacy runtime must not execute'); } } });
  const saved = await service.saveSettings({ assistantName: '小月', persona: '温暖而严谨', runtimeHome: oldHome, runtimeMode: 'hosted', runtimeApiKey: 'synthetic-optional-helper-key' });
  assert.equal(saved.assistantName, '小月');
  assert.equal(saved.persona, '温暖而严谨');
  assert.equal(saved.runtimeHome, oldHome);
  assert.equal(saved.runtimeMode, 'hosted');
  assert.equal((await service.saveSettings({ runtimeHome: path.join(directory, 'another-unused-sdk-home') })).runtimeHome, oldHome);
  await assert.rejects(service.saveSettings({ runtimeHome: oldHome, runtimeMode: 'optional-api' }), /始终使用 DSH/);
  const task = await service.createTask({ prompt: '确认保存后仍由 DSH 执行。' });
  const deadline = Date.now() + 5000;
  while (!['succeeded', 'failed'].includes(service.getTask(task.id).task.status)) {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(service.getTask(task.id).task.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(submitted.settings.hostedConfigFile, path.join(dataDir, 'harness-host', 'client.json'));
  assert.equal(submitted.settings.env, undefined);
  assert.match(submitted.settings.personaPrefix, /小月.*温暖而严谨/);
});

test('legacy SDK fixtures still reject SDK homes outside the product directory', async t => {
  const { directory, open } = fixture(t);
  const service = await open({ runtime: { inspectRuntime: async () => ({ available: false }), runTask: async () => { throw Error('not called'); } } });
  await assert.rejects(service.saveSettings({ runtimeHome: path.join(directory, 'outside-sdk-home') }), /数据目录内/);
});
