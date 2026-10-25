import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshAccess } from '../apps/service/dsh-access.mjs';

const catalog = () => ({ ok: true, metadataOnly: true, source: 'harness-host',
  skills: [{ name: 'office-docx', description: '原 Harness Word 技能', provider: 'dsh', modelInvocable: true }, { name: 'internal-only', modelInvocable: false }],
  tools: [{ name: 'mcp__contract_helper__library_search', description: '合同检索', grantable: true }, { name: 'shell', grantable: false }] });
function fixture(options = {}) {
  let settings = { ...(options.settings || {}) }, response = options.response || catalog(), calls = 0, changes = 0;
  const requests = [], writes = [];
  const access = createDshAccess({ runtime: { async readHostedCatalog(input) { calls++; requests.push(input); if (response instanceof Error) throw response; return structuredClone(response); } },
    settingsProvider: async () => ({ hostedConfigFile: 'C:/product/harness-host/client.json', env: { DEEPSEEK_API_KEY: 'never-forward-synthetic' }, personaPrefix: '不应转交清单服务' }),
    store: { getSettings: () => structuredClone(settings), async saveSettings(patch) { if (options.saveError) throw new Error('synthetic-save-failure'); writes.push(structuredClone(patch)); settings = { ...settings, ...structuredClone(patch) }; } },
    onChange: async () => { changes++; if (options.observerError) throw new Error('synthetic-observer-error'); } });
  return { access, requests, writes, get settings() { return settings; }, get calls() { return calls; }, get changes() { return changes; }, set response(value) { response = value; } };
}

test('DSH catalog reads actual runtime metadata and passes only product config reference', async () => {
  const f = fixture(), result = await f.access.getCatalog();
  assert.equal(result.ok, true); assert.equal(result.skills[0].name, 'office-docx'); assert.equal(result.tools[0].grantable, true);
  assert.equal(result.tools[1].grantable, false); assert.equal(result.skills[0].executableInProduct, false);
  assert.deepEqual(f.requests, [{ hostedConfigFile: 'C:/product/harness-host/client.json' }]);
  assert.doesNotMatch(JSON.stringify(result), /never-forward-synthetic/); assert.equal(f.writes.length, 0);
});
test('default grants are empty even while all original host capabilities are visible', async () => {
  const f = fixture(), state = await f.access.getState();
  assert.equal(state.connected, true); assert.deepEqual(state.saved, { skills: [], tools: [] }); assert.deepEqual(state.effective, state.saved);
  assert.deepEqual(await f.access.grantsForTask({ source: 'desktop' }), state.saved); assert.equal(f.calls, 1);
});
test('trusted explicit save uses exact live names and persists only dshOwnerGrants', async () => {
  const f = fixture({ settings: { assistantName: '小助手' } });
  const result = await f.access.saveGrants({ skills: ['office-docx'], tools: ['mcp__contract_helper__library_search'] });
  assert.deepEqual(result.saved, { skills: ['office-docx'], tools: ['mcp__contract_helper__library_search'] });
  assert.deepEqual(f.writes, [{ dshOwnerGrants: result.saved }]); assert.equal(f.settings.assistantName, '小助手'); assert.equal(f.changes, 1);
  const state = await f.access.getState(); assert.deepEqual(state.effective, result.saved); assert.deepEqual(state.unavailable, { skills: [], tools: [] });
});
test('wildcards, altered case, non-invocable skills and ungrantable tools fail without save', async () => {
  const f = fixture();
  for (const input of [{ skills: ['Office-docx'] }, { skills: ['office-docx '] }, { skills: ['internal-only'] }, { tools: ['shell'] }, { tools: ['mcp_missing'] }, { skills: ['*'] }]) await assert.rejects(f.access.saveGrants(input), error => ['DSH_GRANTS_INVALID', 'DSH_GRANT_NOT_AVAILABLE'].includes(error.code));
  assert.equal(f.writes.length, 0); assert.equal(f.changes, 0);
});
test('grant lists are bounded, unique, exact strings and do not accept extra authority fields', async () => {
  const f = fixture();
  for (const input of [{ tools: ['x', 'x'] }, { skills: ['x'.repeat(161)] }, { skills: Array.from({ length: 301 }, (_, i) => 'skill' + i) }, { tools: ['a\nb'] }, { tools: 'shell' }, { skills: ['a/b'] }, { skills: [], tools: [], source: 'desktop' }, null, []]) await assert.rejects(f.access.saveGrants(input), { code: 'DSH_GRANTS_INVALID' });
  assert.equal(f.calls, 0); assert.equal(f.writes.length, 0);
});
test('wechat, missing and unrecognized source always receive zero owner capabilities without host read', async () => {
  const f = fixture({ settings: { dshOwnerGrants: { skills: ['office-docx'], tools: ['mcp__contract_helper__library_search'] } } });
  for (const request of [{ source: 'wechat' }, { source: 'mail' }, { source: 'web' }, {}, undefined]) assert.deepEqual(await f.access.grantsForTask(request), { skills: [], tools: [] });
  assert.equal(f.calls, 0); assert.equal(f.writes.length, 0);
});
test('desktop task rechecks live source and receives only still-available exact grants', async () => {
  const f = fixture({ settings: { dshOwnerGrants: { skills: ['office-docx', 'removed-skill'], tools: ['mcp__contract_helper__library_search', 'removed_tool'] } } });
  assert.deepEqual(await f.access.grantsForTask({ source: 'desktop' }), { skills: ['office-docx'], tools: ['mcp__contract_helper__library_search'] });
  f.response = { ...catalog(), tools: [{ name: 'mcp__contract_helper__library_search', grantable: false }] };
  assert.deepEqual(await f.access.grantsForTask({ source: 'desktop' }), { skills: ['office-docx'], tools: [] });
  const state = await f.access.getState(); assert.deepEqual(state.unavailable, { skills: ['removed-skill'], tools: ['mcp__contract_helper__library_search', 'removed_tool'] });
  assert.equal(f.writes.length, 0);
});
test('disconnected Harness fails closed while keeping saved selection and stale metadata for explanation', async () => {
  const f = fixture({ settings: { dshOwnerGrants: { skills: ['office-docx'], tools: ['mcp__contract_helper__library_search'] } } });
  await f.access.getCatalog(); f.response = { ok: false, error: { code: 'HOST_UNAVAILABLE', message: 'Harness 未启动' } };
  const state = await f.access.getState(); assert.equal(state.connected, false); assert.equal(state.catalog.stale, true); assert.equal(state.catalog.skills[0].name, 'office-docx');
  assert.deepEqual(state.effective, { skills: [], tools: [] }); assert.deepEqual(state.unavailable, state.saved);
  assert.deepEqual(await f.access.grantsForTask({ source: 'desktop' }), { skills: [], tools: [] });
  await assert.rejects(f.access.saveGrants({ skills: ['office-docx'] }), { code: 'DSH_CATALOG_UNAVAILABLE' }); assert.equal(f.writes.length, 0);
  const cleared = await f.access.saveGrants({ skills: [], tools: [] }); assert.deepEqual(cleared.saved, { skills: [], tools: [] }); assert.equal(f.writes.length, 1);
});
test('malformed or duplicate live catalog cannot confer authority', async () => {
  const f = fixture({ response: { ...catalog(), tools: [{ name: 'mcp__contract_helper__library_search', grantable: true }, { name: 'mcp__contract_helper__library_search', grantable: true }] } });
  assert.equal((await f.access.getCatalog()).error.code, 'DSH_CATALOG_INVALID');
  await assert.rejects(f.access.saveGrants({ tools: ['mcp__contract_helper__library_search'] }), { code: 'DSH_CATALOG_UNAVAILABLE' });
  f.response = { ...catalog(), metadataOnly: false }; assert.equal((await f.access.getCatalog()).ok, false);
  f.response = { ...catalog(), tools: Array.from({ length: 501 }, (_, i) => ({ name: 'tool_' + i, grantable: true })) }; assert.equal((await f.access.getCatalog()).ok, false);
  assert.equal(f.writes.length, 0);
});
test('corrupted persisted grants are never forwarded and returned arrays cannot mutate persisted authority', async () => {
  const f = fixture({ settings: { dshOwnerGrants: { tools: ['mcp__contract_helper__library_search', 'mcp__contract_helper__library_search'] } } });
  assert.deepEqual(await f.access.grantsForTask({ source: 'desktop' }), { skills: [], tools: [] });
  const saved = await f.access.saveGrants({ tools: ['mcp__contract_helper__library_search'] }); saved.saved.tools.push('shell');
  const effective = await f.access.grantsForTask({ source: 'desktop' }); effective.tools.push('shell');
  assert.deepEqual(f.settings.dshOwnerGrants, { skills: [], tools: ['mcp__contract_helper__library_search'] });
});
test('failed persistence does not notify while UI observer failure cannot undo a completed save', async () => {
  const failed = fixture({ saveError: true }); await assert.rejects(failed.access.saveGrants({ skills: ['office-docx'] }), /synthetic-save-failure/); assert.equal(failed.changes, 0);
  const notified = fixture({ observerError: true }); assert.equal((await notified.access.saveGrants({ skills: ['office-docx'] })).saved.skills[0], 'office-docx'); assert.equal(notified.writes.length, 1);
});
