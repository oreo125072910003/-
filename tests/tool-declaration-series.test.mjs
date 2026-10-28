import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, ensureImmediateToolSeries } from '../packages/harness-host-plugin/text-policy.mjs';
import { OWNER_ACCESS } from '../packages/harness-host-plugin/owner-access.mjs';

const tool = name => ({ name, description: name, parameters: { type: 'object' } });
function fixture(baseline, active = baseline) {
  const records = [], header = { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }, adapterDefaults: { maxTokens: true }, tools: active };
  return { records, header, requestHeader: () => header, toolHistory: () => ({ tools: baseline, updates: [] }), append(type, data) { records.push({ type, data }); } };
}
test('empty or removed immediate tool baselines are rebased with current declarations', () => {
  const current = [tool('xiaozhushou_desktop')];
  for (const baseline of [[], [tool('old-tool')], [{ ...current[0], deferLoading: true }]]) {
    const session = fixture(baseline);
    ensureImmediateToolSeries(session, current);
    assert.deepEqual(session.records, [{ type: 'request/header', data: { header: { ...session.header, tools: current }, reason: 'series' } }]);
  }
});
test('a retained immediate tool, an empty request and a fresh session need no checkpoint', () => {
  const current = [tool('xiaozhushou_desktop')], session = fixture(current);
  ensureImmediateToolSeries(session, current); ensureImmediateToolSeries(session, []);
  ensureImmediateToolSeries({ ...session, requestHeader: () => undefined }, current);
  assert.deepEqual(session.records, []);
});
test('assembly rebases only the authorized schemas without exposing historical or foreign tools', async () => {
  let assemble;
  const session = fixture([tool('ungranted-shell')]);
  const scope = { session, ctx: { [OWNER_ACCESS]: { names: () => new Set(['xiaozhushou_desktop']) } } };
  apply({ tools: { guard() {}, presentAs() {} }, on(event, callback) { if (event === 'system-prompt/assemble') assemble = callback; } });
  const input = { tools: [tool('ungranted-shell'), { ...tool('xiaozhushou_desktop'), deferLoading: true }], sections: [] };
  const result = await assemble(input, { scope }, async () => input);
  assert.deepEqual(result.tools, [tool('xiaozhushou_desktop')]);
  assert.deepEqual(session.records[0].data.header.tools, result.tools);
  assert.equal(input.tools[1].deferLoading, true);
});
