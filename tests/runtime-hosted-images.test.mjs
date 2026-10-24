import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateTaskImages } from '../packages/contracts/image-input.mjs';
import { runHostedTask } from '../packages/runtime-harness/hosted.mjs';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG = Buffer.from([255, 216, 255, 224]);
const WEBP = Buffer.from('52494646100000005745425056503820', 'hex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('合成图片宿主没有到达预期状态'); await pause(5); }
}
function image(mime = 'image/png', { bytes, id = 'a'.repeat(64), name } = {}) {
  const content = bytes ?? Buffer.concat([mime === 'image/png' ? PNG : mime === 'image/jpeg' ? JPEG : WEBP, Buffer.from('synthetic-image-data')]);
  return { id, ...(name === undefined ? {} : { name }), mime, b64: content.toString('base64'), sha256: digest(content), bytes: content.length };
}

// Only a local protocol fixture; it never invokes a model or a WeChat transport.
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xzs-host-images-'));
  const workspace = path.join(root, 'workspace'), tokenFile = path.join(root, 'token.txt');
  const token = 'synthetic-image-test-bridge-token-not-a-provider-key';
  await mkdir(workspace); await writeFile(tokenFile, token);
  const posts = [], deletes = [], healthRequests = [], requests = [];
  const sessionId = 'xzs-' + 'c'.repeat(32);
  const task = (taskId, status = 'completed') => ({
    taskId, sessionId, status, nativeTerminal: status !== 'running' && status !== 'stop_unconfirmed',
    cancellation: { requested: ['cancelled', 'stop_unconfirmed'].includes(status), confirmed: status === 'cancelled' },
    ...(status === 'running' ? {} : { result: {
      ok: status === 'completed', finalText: status === 'completed' ? '合成图片任务完整回复。' : '', sessionId, artifacts: [],
      ...(status === 'completed' ? {} : { error: { code: status === 'cancelled' ? 'CANCELLED' : 'CANCEL_UNCONFIRMED', message: '合成取消回执。' } }),
    } }),
  });
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    const json = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== 'Bearer ' + token) return json({ error: { code: 'UNAUTHORIZED', message: '合成令牌错误' } }, 401);
    if (request.url === '/health') {
      healthRequests.push(true);
      return json({ ok: true, protocol: 'xiaozhushou-harness-host-v1', project: 'xiaozhushou', toolPolicy: 'product-text-only-v1',
        credentialsSource: 'harness-existing-login', modelVerified: true,
        capabilities: Object.hasOwn(options, 'imagesCapability') ? options.imagesCapability === undefined ? {} : { images: options.imagesCapability } : { images: true } });
    }
    if (request.url === '/tasks' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body); posts.push(value);
      return json(task(value.taskId, options.pending ? 'running' : 'completed'), 202);
    }
    const taskId = request.url.split('/').at(-1);
    if (request.url.startsWith('/tasks/') && request.method === 'DELETE') {
      deletes.push(taskId); return json(task(taskId, options.unconfirmed ? 'stop_unconfirmed' : 'cancelled'));
    }
    if (request.url.startsWith('/tasks/') && request.method === 'GET') return json(task(taskId, 'running'));
    return json({ error: { code: 'NOT_FOUND', message: '合成路由不存在' } }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('xzs-host-images-'));
    await rm(root, { recursive: true, force: true });
  });
  const settings = { hostedEndpoint: 'http://127.0.0.1:' + server.address().port, hostedTokenFile: tokenFile, hostedPollMs: 20, hostedCancelWaitMs: 1000 };
  return { workspace, settings, posts, deletes, healthRequests, requests, token };
}

test('shared image contract returns fresh normalized objects and accepts supported magic headers', () => {
  const supplied = Object.freeze([
    Object.freeze(image('image/png', { id: 'A'.repeat(64), name: ' 图片.png ' })),
    Object.freeze(image('image/jpeg')),
    Object.freeze(image('image/webp')),
  ]);
  const result = validateTaskImages(supplied);
  assert.notEqual(result, supplied); assert.notEqual(result[0], supplied[0]);
  assert.equal(result[0].id, 'a'.repeat(64)); assert.equal(result[0].name, '图片.png');
  assert.equal(Object.hasOwn(result[1], 'name'), false);
  assert.deepEqual(result.map(item => item.mime), ['image/png', 'image/jpeg', 'image/webp']);
  assert.deepEqual(validateTaskImages(undefined), []); assert.deepEqual(validateTaskImages([]), []);
});

test('invalid image metadata, bytes and formats fail locally with stable image codes before any host request', async t => {
  const f = await fixture(t), valid = image();
  const cases = [
    [null, 'IMAGE_LIST_INVALID'],
    [Array(5).fill(valid), 'IMAGE_COUNT_EXCEEDED'],
    [Array(1), 'IMAGE_FIELDS_INVALID'],
    [[{ ...valid, url: 'https://example.invalid/image.png' }], 'IMAGE_FIELDS_INVALID'],
    [[{ ...valid, path: 'C:/private/image.png' }], 'IMAGE_FIELDS_INVALID'],
    [[{ ...valid, id: 'short' }], 'IMAGE_ID_INVALID'],
    [[{ ...valid, sha256: 'bad' }], 'IMAGE_SHA256_INVALID'],
    [[{ ...valid, name: '../image.png' }], 'IMAGE_NAME_INVALID'],
    [[{ ...valid, name: 'C:image.png' }], 'IMAGE_NAME_INVALID'],
    [[{ ...valid, name: 'image\n.png' }], 'IMAGE_NAME_INVALID'],
    [[{ ...valid, name: 'a'.repeat(161) }], 'IMAGE_NAME_INVALID'],
    [[{ ...valid, mime: 'image/gif' }], 'IMAGE_MIME_INVALID'],
    [[{ ...valid, bytes: 0 }], 'IMAGE_BYTES_INVALID'],
    [[{ ...valid, bytes: 1.5 }], 'IMAGE_BYTES_INVALID'],
    [[{ ...valid, bytes: 768 * 1024 + 1 }], 'IMAGE_SIZE_EXCEEDED'],
    [[{ ...valid, b64: valid.b64 + '\n' }], 'IMAGE_BASE64_INVALID'],
    [[{ ...valid, b64: 'AB==', bytes: 1 }], 'IMAGE_BASE64_INVALID'],
    [[{ ...valid, b64: 'A'.repeat(4 * 262144 + 4) }], 'IMAGE_SIZE_EXCEEDED'],
    [[{ ...valid, bytes: valid.bytes + 1 }], 'IMAGE_SIZE_MISMATCH'],
    [[{ ...valid, sha256: '0'.repeat(64) }], 'IMAGE_SHA256_MISMATCH'],
    [[{ ...valid, mime: 'image/jpeg' }], 'IMAGE_MAGIC_MISMATCH'],
    [[image('image/png', { bytes: Buffer.from('<svg>not a bitmap</svg>') })], 'IMAGE_MAGIC_MISMATCH'],
    [[image('image/webp', { bytes: Buffer.from('RIFF0000FAKEpayload') })], 'IMAGE_MAGIC_MISMATCH'],
  ];
  for (const [images, code] of cases) {
    const result = await runHostedTask({ prompt: '请阅读图片', workspace: f.workspace, images, settings: f.settings });
    assert.equal(result.ok, false, code); assert.equal(result.error.code, code);
    assert.equal(result.finalText, ''); assert.deepEqual(result.artifacts, []);
  }
  assert.equal(f.requests.length, 0, 'malformed input cannot even probe the host');
});

test('hosted client forwards validated image bytes, optional names and existing session without provider keys', async t => {
  const f = await fixture(t), images = [image('image/png', { name: '合成图片.png' }), image('image/jpeg'), image('image/webp')];
  const sessionId = 'xzs-' + 'c'.repeat(32), conversation = { channel: 'wechat', displayName: '合成联系人' };
  const events = [];
  const result = await runHostedTask({ prompt: '请描述这些图片', workspace: f.workspace, sessionId, conversation, images, settings: f.settings, onEvent: event => events.push(event) });
  assert.equal(result.ok, true); assert.equal(result.finalText, '合成图片任务完整回复。');
  assert.deepEqual(result.cancellation, { requested: false, confirmed: false });
  assert.equal(f.healthRequests.length, 1); assert.equal(f.posts.length, 1); assert.equal(f.deletes.length, 0);
  assert.deepEqual(f.posts[0].images, images); assert.deepEqual(f.posts[0].conversation, conversation);
  assert.equal(f.posts[0].sessionId, sessionId); assert.equal(f.posts[0].prompt, '请描述这些图片');
  assert.ok(f.requests.every(request => request.authorization === 'Bearer ' + f.token));
  assert.equal(JSON.stringify(f.posts[0]).includes('API_KEY'), false);
  assert.equal(events.filter(event => event.type === 'text').length, 1);
});

test('image requests require an explicit true host capability and never silently fall back to text', async t => {
  for (const capability of [undefined, false, 'true']) await t.test(String(capability), async child => {
    const f = await fixture(child, { imagesCapability: capability });
    const result = await runHostedTask({ prompt: '必须阅读这张图片', workspace: f.workspace, images: [image()], settings: f.settings });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'HOST_IMAGES_UNSUPPORTED');
    assert.equal(result.finalText, ''); assert.equal(f.healthRequests.length, 1);
    assert.equal(f.posts.length, 0); assert.equal(f.deletes.length, 0);
  });
});

test('text-only requests retain compatibility with an old host and omit empty images', async t => {
  const f = await fixture(t, { imagesCapability: undefined });
  for (const images of [undefined, []]) {
    const result = await runHostedTask({ prompt: '普通文字任务', workspace: f.workspace, images, settings: f.settings });
    assert.equal(result.ok, true);
  }
  assert.equal(f.posts.length, 2); assert.ok(f.posts.every(post => !Object.hasOwn(post, 'images')));
});

test('four images at the exact per-image limit are forwarded without truncation', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(768 * 1024); PNG.copy(bytes);
  const images = Array.from({ length: 4 }, (_, index) => image('image/png', { bytes, id: String(index + 1).repeat(64) }));
  const result = await runHostedTask({ prompt: '四张图片任务', workspace: f.workspace, images, settings: f.settings });
  assert.equal(result.ok, true); assert.equal(f.posts.length, 1);
  assert.deepEqual(f.posts[0].images, images);
  assert.equal(f.posts[0].images.reduce((total, item) => total + item.bytes, 0), 4 * 768 * 1024);
});

test('already-cancelled image task makes no host request', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  const result = await runHostedTask({ prompt: '已取消的图片任务', workspace: f.workspace, images: [image()], signal: controller.signal, settings: f.settings });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'CANCELLED'); assert.equal(f.requests.length, 0);
});

test('image tasks preserve confirmed and unresolved host cancellation receipts without resubmitting', async t => {
  for (const unconfirmed of [false, true]) await t.test(unconfirmed ? 'unconfirmed' : 'confirmed', async child => {
    const f = await fixture(child, { pending: true, unconfirmed }), controller = new AbortController();
    const running = runHostedTask({ prompt: '可以取消的图片任务', workspace: f.workspace, images: [image()], signal: controller.signal, settings: f.settings });
    await until(() => f.posts.length === 1); controller.abort();
    const result = await running;
    assert.equal(result.ok, false); assert.equal(result.error.code, unconfirmed ? 'CANCEL_UNCONFIRMED' : 'CANCELLED');
    assert.deepEqual(result.cancellation, { requested: true, confirmed: !unconfirmed });
    assert.equal(f.posts.length, 1); assert.equal(f.deletes.length, 1);
  });
});
