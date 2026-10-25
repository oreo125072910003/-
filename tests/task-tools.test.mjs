import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createTaskToolAccess, renderProductDrawing, runProductCommand } from '../apps/service/task-tools.mjs';
import { PRODUCT_TOOLS } from '../packages/contracts/product-tools.mjs';
import { describeTool } from '../packages/contracts/tool-policy.mjs';
import { bindOwnerAccess, normalizeOwnerGrants } from '../packages/harness-host-plugin/owner-access.mjs';
import { validateProductConnection } from '../packages/harness-host-plugin/product-access.mjs';
import { extractDocument } from '../packages/documents/index.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="#f4efe2"/><circle cx="400" cy="280" r="140" fill="#9cd3c9"/><text x="400" y="490" text-anchor="middle" font-size="40">小助手绘图</text></svg>';
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-task-tools-')), workspace = path.join(root, 'task'); fs.mkdirSync(workspace);
  const controller = new AbortController(), artifacts = new Map(), deliveries = [];
  let permitted = true;
  const task = { id: 'task_' + randomUUID(), workspace };
  const access = await createTaskToolAccess({ task, tools: PRODUCT_TOOLS.map(tool => tool.name), signal: controller.signal, authorize: async () => permitted,
    addArtifact: (filename, name, type) => { const bytes = fs.readFileSync(filename), item = { id: 'artifact_' + randomUUID(), taskId: task.id, path: filename, name, type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; artifacts.set(item.id, item); return item; },
    resolveArtifact: id => { if (!artifacts.has(id)) throw Error('成果不存在'); return artifacts.get(id); }, onDelivery: item => deliveries.push(item), ...options });
  t.after(async () => { await access.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (name, args = {}, extra = {}) => {
    const response = await fetch(access.connection.endpoint, { method: 'POST', headers: { authorization: 'Bearer ' + access.connection.token, 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify({ id: extra.id ?? randomUUID(), name, args }), signal: AbortSignal.timeout(10000) });
    const value = await response.json(); return { ...value, ...(value.isError ? {} : { result: JSON.parse(value.content) }), status: response.status };
  };
  return { root, workspace, task, access, request, artifacts, deliveries, controller, revoke() { permitted = false; } };
}

test('product drawing renders Chinese vector art into a nonempty PNG and rejects active or external SVG', () => {
  const png = renderProductDrawing(svg);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 1280); assert.equal(png.readUInt32BE(20), 960);
  for (const bad of ['<svg><script>1</script></svg>', '<svg><image href="file:///secret"/></svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg>&x;</svg>', '<svg><foreignObject/></svg>', '<svg><rect onload="alert(1)"/></svg>', '<svg><path fill="url(https://example.test)"/></svg>']) assert.throws(() => renderProductDrawing(bad));
});

test('task tools create real editable Word and readable PDF with scoped immutable artifacts', async t => {
  const f = await fixture(t);
  const result = await f.request('xiaozhushou_document', { title: 'Feature recovery fixture', blocks: [{ type: 'heading', text: 'Contract materials' }, { type: 'paragraph', text: 'Synthetic material: quantity 12, amount 240.' }], formats: ['docx','pdf'] });
  assert.equal(result.isError, false, result.content); assert.equal(result.result.artifacts.length, 2);
  for (const item of result.result.artifacts) {
    assert.equal(item.path, undefined, 'model sees opaque product metadata'); const real = f.artifacts.get(item.id);
    const extracted = await extractDocument({ path: real.path, allowedRoot: f.workspace }); assert.match(extracted.text, /quantity 12/);
  }
  const invalid = await f.request('xiaozhushou_document', { title: 'No arbitrary output', blocks: [{ type: 'paragraph', text: 'test' }], workspace: f.root }); assert.equal(invalid.isError, true);
});

test('generated drawing and text can be selected for this task; caller cannot choose a destination or another task', async t => {
  const f = await fixture(t);
  const drawing = await f.request('xiaozhushou_draw', { title: '恢复绘图', svg }); assert.equal(drawing.isError, false, drawing.content);
  const id = drawing.result.artifact.id;
  assert.equal((await f.request('xiaozhushou_attachment', { artifactId: id, mediaType: 'image' })).isError, false); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.request('xiaozhushou_attachment', { artifactId: id, mediaType: 'image', target: 'someone-else' })).isError, true);
  f.artifacts.get(id).taskId = 'task_other'; assert.equal((await f.request('xiaozhushou_attachment', { artifactId: id, mediaType: 'image' })).isError, true);
});

test('file reads are restricted to the task; local export requires its own exact granted tool', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'owner.txt'); fs.writeFileSync(outside, 'synthetic owner file');
  assert.equal((await f.request('xiaozhushou_read_document', { path: outside })).isError, true);
  const exported = await f.request('xiaozhushou_export_file', { path: outside }); assert.equal(exported.isError, false, exported.content);
  const snapshot = f.artifacts.get(exported.result.artifact.id); fs.writeFileSync(outside, 'changed'); assert.equal(fs.readFileSync(snapshot.path, 'utf8'), 'synthetic owner file');
  const before = fs.readFileSync(outside, 'utf8'); assert.equal((await f.request('xiaozhushou_write_local_file', { path: outside, text: 'must not overwrite' })).isError, true); assert.equal(fs.readFileSync(outside, 'utf8'), before);
  const drawing=path.join(f.root,'local.png');fs.writeFileSync(drawing,renderProductDrawing(svg));
  const image=await f.request('xiaozhushou_export_file',{path:drawing});assert.equal(image.result.artifact.type,'image/png');
  assert.equal((await f.request('xiaozhushou_attachment',{artifactId:image.result.artifact.id,mediaType:'image'})).isError,false);
  fs.writeFileSync(drawing,'not an image');const invalid=await f.request('xiaozhushou_export_file',{path:drawing});
  assert.equal((await f.request('xiaozhushou_attachment',{artifactId:invalid.result.artifact.id,mediaType:'image'})).isError,true);
});

test('capability transport denies wrong tokens and browser origins, deduplicates writes, and rejects request-id conflicts', async t => {
  const f = await fixture(t), id = randomUUID(), args = { name: 'table.csv', text: 'name,quantity\nfixture,12' };
  assert.equal((await f.request('xiaozhushou_save_text', args, { headers: { authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await f.request('xiaozhushou_save_text', args, { headers: { origin: 'https://example.test' } })).status, 403);
  const [a, b] = await Promise.all([f.request('xiaozhushou_save_text', args, { id }), f.request('xiaozhushou_save_text', args, { id })]);
  assert.equal(a.isError, false); assert.equal(a.content, b.content); assert.equal(f.artifacts.size, 1);
  assert.equal((await f.request('xiaozhushou_save_text', { ...args, text: 'different' }, { id })).isError, true);
});

test('revocation and cancellation stop previously valid tool capabilities', async t => {
  const f = await fixture(t); f.revoke();
  assert.equal((await f.request('xiaozhushou_save_text', { name: 'denied.txt', text: 'no' })).isError, true); assert.equal(f.artifacts.size, 0);
  const g = await fixture(t); g.controller.abort(); assert.equal((await g.request('xiaozhushou_save_text', { name: 'cancelled.txt', text: 'no' })).isError, true); assert.equal(g.artifacts.size, 0);
});

test('screenshot implementation is called only by its own task grant and returns a registered PNG', async t => {
  let calls = 0; const png = renderProductDrawing(svg), f = await fixture(t, { screenshot: async filename => { calls++; fs.writeFileSync(filename, png); } });
  const result = await f.request('xiaozhushou_screenshot'); assert.equal(result.isError, false); assert.equal(calls, 1); assert.equal(result.result.artifact.type, 'image/png');
  f.revoke(); assert.equal((await f.request('xiaozhushou_screenshot')).isError, true); assert.equal(calls, 1);
});

test('stickers are selected from the real current-chat list and mail creates drafts without a send operation', async t => {
  const id = 'a'.repeat(64), seen = [], f = await fixture(t, { conversation: { kind: 'private', target: '101' },
    wechat: { getStickers: async target => { seen.push(target); return { enabled: true, stickers: [{ id, description: 'fixture' }] }; } },
    mail: { getState: () => ({ accounts: [{ id: 'account_fixture', address: 'owner@example.test', credentialRef: 'never-expose' }], messages: [] }), createDraft: value => value } });
  assert.equal((await f.request('xiaozhushou_sticker', { action: 'select', id })).isError, false);
  assert.deepEqual(f.deliveries, [{ kind: 'sticker', stickerId: id }]); assert.deepEqual(seen, [{ kind: 'private', target: '101' }]);
  assert.equal((await f.request('xiaozhushou_sticker', { action: 'select', id: 'b'.repeat(64) })).isError, true);
  const accounts = await f.request('xiaozhushou_mail', { action: 'accounts' }); assert.equal(accounts.content.includes('never-expose'), false);
  const draft = await f.request('xiaozhushou_mail', { action: 'draft', accountId: 'account_fixture', to: ['friend@example.test'], subject: 'Fixture', text: 'Review before sending' }); assert.equal(draft.result.sent, false);
  assert.equal((await f.request('xiaozhushou_mail', { action: 'send' })).isError, true);
});

test('native scoped tool registration invokes the authenticated product handler and disposes with the turn', async t => {
  const f = await fixture(t), registered = new Map(), context = { tools: { register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); } } };
  const grants = normalizeOwnerGrants({ authority: 'product-owner', ownerGrants: { tools: ['xiaozhushou_save_text'] } });
  const access = await bindOwnerAccess(context, { tools: { schemas: () => [] } }, {}, { grants, active: () => true, signal: f.controller.signal, productConnection: f.access.connection });
  assert.equal(access.policy.check('xiaozhushou_save_text'), true); assert.equal(access.policy.check('xiaozhushou_screenshot'), false);
  const tool = registered.get('xiaozhushou_save_text'), result = await tool.execute({ name: 'native.txt', text: 'Native registered tool fixture' }); assert.equal(result.isError, false);
  access.dispose(); assert.equal(registered.size, 0); await assert.rejects(tool.execute({ name: 'late.txt', text: 'No stale calls' }), /NOT_GRANTED/);
});

test('computer tools require private computer scope and product connections are loopback only', () => {
  for (const tool of PRODUCT_TOOLS.filter(tool => tool.computer)) {
    assert.equal(describeTool(tool.name).grantable, false); assert.equal(describeTool(tool.name).computerGrantable, true);
    assert.throws(() => normalizeOwnerGrants({ authority: 'product-owner', ownerGrants: { tools: [tool.name] } }), { code: 'OWNER_GRANTS_INVALID' });
  }
  for (const endpoint of ['http://example.test:1234/tools','http://localhost:1234/tools','http://127.0.0.1:99999/tools','http://127.0.0.1:1234/other']) assert.throws(() => validateProductConnection({ endpoint, token: 'a'.repeat(43) }));
});

test('local command runner returns the actual exit code and output and stops a timed out process', async t => {
  const f = await fixture(t), windows = process.platform === 'win32';
  const result = await runProductCommand(windows ? "Write-Output 'task-tools-ok'; exit 7" : "echo task-tools-ok; exit 7", { cwd: f.workspace, timeoutMs: 5000 }); assert.equal(result.exitCode, 7); assert.match(result.output, /task-tools-ok/);
  const timed = await runProductCommand(windows ? 'Start-Sleep -Seconds 20' : 'sleep 20', { cwd: f.workspace, timeoutMs: 1000 }); assert.equal(timed.stopped, 'timeout');
});
