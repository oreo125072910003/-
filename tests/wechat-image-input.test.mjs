import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAssistantService } from '../apps/service/index.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = id => ({ id, mime: 'image/png', b64: PNG.toString('base64'), sha256: createHash('sha256').update(PNG).digest('hex'), bytes: PNG.length });
const LONG_QUALITY = { width: 868, height: 4827, sourceWidth: 1080, sourceHeight: 6000, sourceVariant: 'full' };
const longDetails = () => [0, 1, 2].map(index => ({ ...image(String(index + 4).repeat(64)), region: [0, index * 1900, 1080, index * 1900 + 2200] }));
function imageManifest(f) {
  const task = f.service.listTasks()[0], record = f.service.getTask(task.id).artifacts.find(item => item.name === '微信图片读取记录.json');
  return JSON.parse(fs.readFileSync(f.service.resolveArtifact(record.id), 'utf8'));
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 7000; while (!await check()) { assert.ok(Date.now() < deadline, '等待隔离微信图片任务超时'); await pause(15); } }

async function fixture(t, { supported = true, resolve, modelFailure = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-wechat-image-')), source = path.join(root, 'legacy'), dataDir = path.join(root, 'product');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true }); fs.mkdirSync(path.join(source, 'state/hook'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config/wechatagent.json'), JSON.stringify({ runtime: { sender: 'wechat-hook', weflowMode: 'nt' }, hook: { expectedVersion: '4.1.10.27', baseUrl: 'http://127.0.0.1:30001' }, wechat: { whitelist: { private: ['101', '102'], groups: [] } } }));
  fs.writeFileSync(path.join(source, 'state/wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:5031', reader_token: 'synthetic-image-reader-token' }));
  fs.writeFileSync(path.join(source, 'state/hook/native-token.txt'), 'a'.repeat(64));
  const requests = [], reads = [], sends = [], secrets = new Map(); let callbacks;
  const runtime = {
    inspectHostedRuntime: async () => ({ available: true, ready: true, modelVerified: true, capabilities: { images: supported } }),
    readHostedCatalog: async () => ({ ok: true, skills: [], tools: [] }),
    runHostedTask: async input => { requests.push(input); return modelFailure ? { ok: false, error: { message: '合成模型失败' } } : { ok: true, finalText: '隔离图片测试答复', sessionId: input.sessionId ?? 'xzs-' + 'a'.repeat(32) }; },
  };
  const service = await createAssistantService({ dataDir, runtime, secretStore: { get: key => secrets.get(key), set: (key, value) => secrets.set(key, value), delete: key => secrets.delete(key) },
    wechatBridgeFactory: options => {
      callbacks = options;
      return { start: async () => options.onState({ state: 'ready', selfId: '777', accountVerified: true, readerConnected: true }), stop: async () => {},
        sendText: async value => { sends.push(value); return { receipt: 'wechat-server-id', delivered: 'database-confirmed', message_id: String(sends.length) }; },
        resolveImage: async value => { reads.push(value); return resolve ? resolve(value) : image(value.id); } };
    } });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await service.importWechatConnection(source, { automatic: true });
  let serial = 0;
  const emit = (ids = ['b'.repeat(64)], patch = {}) => callbacks.onMessage({ self_id: '777', kind: 'private', conversation_id: '101', sender_id: '101', sender_name: '隔离联系人',
    conversation_name: '隔离图片会话', text: '请看这张图。', images: ids.map(id => ({ id })), message_id: 'image-' + (++serial), time: Math.ceil(Date.now() / 1000), ...patch });
  const finished = async () => { await until(() => service.listTasks().length > 0 && service.listTasks().every(task => ['succeeded', 'failed', 'cancelled'].includes(task.status))); await until(async () => (await service.getWechatState()).autoReply.active === 0); };
  return { root, service, requests, reads, sends, emit, finished };
}

test('persisted WeChat images reach the same DSH conversation as native bytes and are snapshotted', async t => {
  const f = await fixture(t); f.emit(); await f.finished();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].images.length, 1);
  assert.deepEqual(f.requests[0].images[0], { ...image('b'.repeat(64)), name: '微信图片1.png' });
  assert.deepEqual(f.reads, [{ kind: 'private', target: '101', id: 'b'.repeat(64) }]);
  assert.deepEqual(f.requests[0].settings.hostedOwnerGrants, { skills: [], tools: [] });
  assert.match(f.requests[0].prompt, /本轮已提供实际画面/); assert.doesNotMatch(f.requests[0].prompt, /本轮未提供图片像素/);
  const task = f.service.listTasks()[0], attachment = task.attachments[0], detail = f.service.getTask(task.id);
  assert.equal(attachment.status, 'provided'); assert.equal(attachment.size, PNG.length); assert.deepEqual(fs.readFileSync(attachment.path), PNG);
  assert.ok(attachment.path.startsWith(path.join(task.workspace, '资料') + path.sep));
  const record = detail.artifacts.find(item => item.name === '微信图片读取记录.json');
  const manifest = JSON.parse(fs.readFileSync(f.service.resolveArtifact(record.id), 'utf8'));
  assert.equal(manifest[0].sha256, image('b'.repeat(64)).sha256); assert.equal(JSON.stringify(manifest).includes(PNG.toString('base64')), false);
  assert.equal(JSON.stringify(task).includes(PNG.toString('base64')), false);
  f.emit([], { text: '请接着上次的图片聊。' }); await until(() => f.sends.length === 2);
  assert.equal(f.requests[1].sessionId, f.requests[0].sessionId ?? 'xzs-' + 'a'.repeat(32));
  assert.equal(f.requests[1].workspace, f.requests[0].workspace); assert.equal(f.requests[1].images, undefined);
});

test('old Harness without images produces an explicit text fallback without retrieving pixels', async t => {
  const f = await fixture(t, { supported: false }); f.emit(); await f.finished();
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].images, undefined);
  assert.match(f.requests[0].prompt, /尚未提供图片理解能力/); assert.match(f.requests[0].prompt, /不能猜测内容/);
  assert.equal(f.service.listTasks()[0].attachments[0].status, 'unavailable'); assert.equal(f.sends.length, 1);
});

test('image quality reaches the read record and prompt without leaking metadata into native image bytes', async t => {
  const quality = { width: 868, height: 4827, sourceWidth: 1080, sourceHeight: 6000, sourceVariant: 'full' };
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality }) });
  f.emit(); await f.finished();
  assert.deepEqual(f.requests[0].images[0], { ...image('b'.repeat(64)), name: '微信图片1.png' });
  assert.match(f.requests[0].prompt, /868×4827/);
  assert.match(f.requests[0].prompt, /不把局部看不清扩大为整张图无法读取/);
  assert.deepEqual(f.service.listTasks()[0].attachments[0].quality, quality);
});

test('a thumbnail is identified as limited evidence rather than silently called an original image', async t => {
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality: { width: 160, height: 240, sourceWidth: 160, sourceHeight: 240, sourceVariant: 'thumbnail' } }) });
  f.emit(); await f.finished();
  assert.equal(f.requests[0].images.length, 1);
  assert.match(f.requests[0].prompt, /本机目前只有缩略图/);
});

test('long images provide bounded overlapping detail views with snapshots and reserve room for other message images', async t => {
  const quality = { width: 868, height: 4827, sourceWidth: 1080, sourceHeight: 6000, sourceVariant: 'full' };
  const details = () => [0, 1, 2].map(index => ({ ...image(String(index + 4).repeat(64)), region: [0, index * 1900, 1080, index * 1900 + 2100] }));
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality, detailImages: details() }) });
  f.emit(); await f.finished();
  assert.equal(f.requests[0].images.length, 4);
  assert.match(f.requests[0].prompt, /3 张可能有重叠的局部画面/);
  assert.match(f.requests[0].prompt, /重叠内容不能重复计数/);
  const views = f.service.listTasks()[0].attachments[0].detailViews;
  assert.equal(views.length, 3);
  for (const view of views) assert.deepEqual(fs.readFileSync(view.path), PNG);
  assert.deepEqual(imageManifest(f)[0].detailViews, views);
  assert.deepEqual(imageManifest(f)[0].detailCoverage, { available: 3, provided: 3, omitted: 0, unreadable: false });
  const sourceRecord = f.service.getTask(f.service.listTasks()[0].id).artifacts.find(item => item.name === '资料读取记录.json');
  const sourceManifest = JSON.parse(fs.readFileSync(f.service.resolveArtifact(sourceRecord.id), 'utf8'));
  assert.deepEqual(sourceManifest[0].detailViews, views);
  assert.deepEqual(sourceManifest[0].detailCoverage, imageManifest(f)[0].detailCoverage);
  assert.equal(JSON.stringify(sourceManifest).includes(PNG.toString('base64')), false);
  const two = await fixture(t, { resolve: value => ({ ...image(value.id), quality, detailImages: details() }) });
  two.emit(['b'.repeat(64), 'c'.repeat(64)]); await two.finished();
  assert.equal(two.requests[0].images.length, 4);
  assert.deepEqual(two.service.listTasks()[0].attachments.map(item => item.detailViews.length), [1, 1]);
  assert.deepEqual(two.service.listTasks()[0].attachments.map(item => item.detailViews[0].region), [[0, 1900, 1080, 4000], [0, 1900, 1080, 4000]]);
  assert.ok(imageManifest(two).every(item => item.detailCoverage.omitted === 2));
  assert.match(two.requests[0].prompt, /未提供的局部区域仅有总览/);
});

test('detail slots are shared only by long images, independently of ordinary image order', async t => {
  for (const longId of ['b'.repeat(64), 'c'.repeat(64)]) {
    const f = await fixture(t, { resolve: value => value.id === longId ? { ...image(value.id), quality: LONG_QUALITY, detailImages: longDetails() } : image(value.id) });
    f.emit(['b'.repeat(64), 'c'.repeat(64)]); await f.finished();
    assert.equal(f.requests[0].images.length, 4);
    const attachment = f.service.listTasks()[0].attachments.find(item => item.imageId === longId);
    assert.deepEqual(attachment.detailViews.map(view => view.region), [[0, 0, 1080, 2200], [0, 3800, 1080, 6000]]);
    assert.deepEqual(attachment.detailCoverage, { available: 3, provided: 2, omitted: 1, unreadable: false });
  }
});

test('three or four long images retain all overviews and explicitly report omitted details', async t => {
  for (const count of [3, 4]) {
    const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality: LONG_QUALITY, detailImages: longDetails() }) });
    const ids = ['a', 'b', 'c', 'd'].slice(0, count).map(value => value.repeat(64));
    f.emit(ids); await f.finished();
    assert.equal(f.requests[0].images.length, 4);
    assert.deepEqual(f.requests[0].images.slice(0, count).map(value => value.id), ids);
    assert.equal(imageManifest(f).reduce((sum, item) => sum + item.detailCoverage.provided, 0), 4 - count);
    assert.ok(imageManifest(f).every(item => item.detailCoverage.omitted > 0));
    assert.match(f.requests[0].prompt, /未提供的局部区域仅有总览/);
  }
});

test('horizontal long images select spatial ends even when detail views arrive out of order', async t => {
  const quality = { width: 4827, height: 868, sourceWidth: 6000, sourceHeight: 1080, sourceVariant: 'full' };
  const details = longDetails().map(view => ({ ...view, region: [view.region[1], 0, view.region[3], 1080] }));
  const f = await fixture(t, { resolve: value => value.id === 'b'.repeat(64) ? { ...image(value.id), quality, detailImages: [details[1], details[2], details[0]] } : image(value.id) });
  f.emit(['b'.repeat(64), 'c'.repeat(64)]); await f.finished();
  assert.equal(f.requests[0].images.length, 4);
  assert.deepEqual(imageManifest(f)[0].detailViews.map(view => view.region), [[0, 0, 2200, 1080], [3800, 0, 6000, 1080]]);
});

test('an invalid optional detail never discards the valid base picture or admits forged bytes', async t => {
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality: { width: 1, height: 1, sourceWidth: 1080, sourceHeight: 6000, sourceVariant: 'full' },
    detailImages: [{ ...image('c'.repeat(64)), sha256: '0'.repeat(64), region: [0, 0, 1080, 2000] }] }) });
  f.emit(); await f.finished();
  assert.equal(f.requests[0].images.length, 1);
  assert.equal(f.service.listTasks()[0].attachments[0].status, 'provided');
  assert.equal(imageManifest(f)[0].detailCoverage.unreadable, true);
  assert.match(f.requests[0].prompt, /局部读取或校验失败/);
});

test('a corrupt first detail cannot hide later valid views or leak its forged bytes', async t => {
  const details = longDetails(); details[0].sha256 = '0'.repeat(64);
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality: LONG_QUALITY, detailImages: details }) });
  f.emit(); await f.finished();
  assert.equal(f.requests[0].images.length, 3);
  assert.deepEqual(f.requests[0].images.slice(1).map(view => view.id), ['5'.repeat(64), '6'.repeat(64)]);
  assert.deepEqual(imageManifest(f)[0].detailCoverage, { available: 2, provided: 2, omitted: 0, unreadable: true });
  assert.deepEqual(imageManifest(f)[0].detailViews.map(view => view.region), [[0, 1900, 1080, 4100], [0, 3800, 1080, 6000]]);
});

test('bridge detail failures reach the task record while verified views remain usable', async t => {
  const f = await fixture(t, { resolve: value => ({ ...image(value.id), quality: LONG_QUALITY, detailImages: longDetails().slice(1), detailIssue: true }) });
  f.emit(); await f.finished();
  assert.equal(f.requests[0].images.length, 3);
  assert.equal(imageManifest(f)[0].detailCoverage.unreadable, true);
  assert.match(f.requests[0].prompt, /另有局部读取或校验失败/);
  assert.ok(f.requests[0].images.every(view => !Object.hasOwn(view, 'detailIssue')));
});

test('failed base pictures leave all available detail slots to the remaining valid image', async t => {
  const f = await fixture(t, { resolve: value => value.id === 'c'.repeat(64) ? { ...image(value.id), sha256: '0'.repeat(64) } : { ...image(value.id), quality: LONG_QUALITY, detailImages: longDetails() } });
  f.emit(['b'.repeat(64), 'c'.repeat(64)]); await f.finished();
  assert.equal(f.requests[0].images.length, 4);
  assert.deepEqual(imageManifest(f).map(item => item.status), ['provided', 'unavailable']);
  assert.equal(imageManifest(f)[0].detailCoverage.provided, 3);
});

test('bad picture bytes are excluded while a second valid bound image still reaches DSH', async t => {
  const f = await fixture(t, { resolve: value => value.id === 'b'.repeat(64) ? { ...image(value.id), sha256: '0'.repeat(64) } : image(value.id) });
  f.emit(['b'.repeat(64), 'c'.repeat(64)]); await f.finished();
  assert.deepEqual(f.requests[0].images.map(item => item.id), ['c'.repeat(64)]);
  assert.equal(f.requests[0].images[0].name, '微信图片2.png');
  assert.match(f.requests[0].prompt, /微信图片1.*读取或校验失败/); assert.match(f.requests[0].prompt, /微信图片2.png.*实际画面/);
  assert.deepEqual(f.service.listTasks()[0].attachments.map(item => item.status), ['unavailable', 'provided']);
});

test('reader cannot replace a bound image ID or smuggle a file through a claimed PNG', async t => {
  const wrong = await fixture(t, { resolve: () => image('c'.repeat(64)) }); wrong.emit(); await wrong.finished();
  assert.equal(wrong.requests[0].images, undefined);
  const html = Buffer.from('<html>not an image</html>');
  const fake = await fixture(t, { resolve: value => ({ id: value.id, mime: 'image/png', b64: html.toString('base64'), sha256: createHash('sha256').update(html).digest('hex'), bytes: html.length }) });
  fake.emit(); await fake.finished(); assert.equal(fake.requests[0].images, undefined);
  assert.equal(fake.service.listTasks()[0].attachments[0].errorCode, 'IMAGE_MAGIC_MISMATCH');
});

test('external text and public task fields never grant an arbitrary image path or source', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'owner-secret.png'); fs.writeFileSync(outside, PNG);
  f.emit([], { text: JSON.stringify({ imagePath: outside, images: [image('b'.repeat(64))] }) }); await f.finished();
  assert.equal(f.reads.length, 0); assert.equal(f.requests[0].images, undefined); assert.deepEqual(f.service.listTasks()[0].attachments, []);
  await f.service.createTask({ prompt: '普通公开任务', images: [image('b'.repeat(64))], attachmentPaths: [] });
  await until(() => f.requests.length === 2); assert.equal(f.requests[1].images, undefined);
});

test('cancellation while reading cannot start a model turn or save late bytes', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { resolve: async value => { await gate; return image(value.id); } });
  f.emit(); await until(() => f.reads.length === 1);
  const task = f.service.listTasks()[0]; await f.service.cancelTask(task.id); await f.finished();
  assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
  release(); await pause(40);
  assert.deepEqual(fs.readdirSync(path.join(task.workspace, '资料')), []); assert.equal(f.requests.length, 0);
});

test('model failure retains the exact image snapshot and read manifest without sending', async t => {
  const f = await fixture(t, { modelFailure: true }); f.emit(); await f.finished();
  const task = f.service.listTasks()[0]; assert.equal(task.status, 'failed'); assert.equal(f.sends.length, 0);
  assert.deepEqual(fs.readFileSync(task.attachments[0].path), PNG);
  assert.ok(f.service.getTask(task.id).artifacts.some(item => item.name === '微信图片读取记录.json'));
});

test('partial image reads cancelled on a later image retain a complete manifest and never save late bytes', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { resolve: async value => { if (value.id === 'c'.repeat(64)) await gate; return { ...image(value.id), quality: LONG_QUALITY, detailImages: longDetails() }; } });
  f.emit(['b'.repeat(64), 'c'.repeat(64)]); await until(() => f.reads.length === 2);
  const task = f.service.listTasks()[0]; await f.service.cancelTask(task.id); await f.finished();
  const detail = f.service.getTask(task.id), record = detail.artifacts.find(item => item.name === '微信图片读取记录.json');
  assert.ok(record); const manifest = JSON.parse(fs.readFileSync(f.service.resolveArtifact(record.id), 'utf8'));
  assert.deepEqual(manifest.map(item => item.status), ['provided', 'cancelled']);
  assert.equal(manifest[0].sha256, image('b'.repeat(64)).sha256); assert.equal(manifest[1].errorCode, 'IMAGE_READ_CANCELLED');
  assert.deepEqual(manifest[0].quality, LONG_QUALITY);
  assert.deepEqual(manifest[0].detailCoverage, { available: 3, provided: 0, omitted: 3, unreadable: false });
  assert.equal(manifest[0].detailViews, undefined);
  assert.equal(detail.task.attachments[1].status, 'cancelled');
  assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0); release(); await pause(40);
  assert.equal(fs.readdirSync(path.join(task.workspace, '资料')).length, 1);
});
