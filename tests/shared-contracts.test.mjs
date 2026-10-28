import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { normalizeImageQuality, normalizeImageRegion } from '../packages/contracts/image-input.mjs';
import { UI_SERVICE_METHODS } from '../packages/contracts/ui-service-methods.mjs';
import { SERVICE_METHODS, NATIVE_METHODS } from '../packages/dsh-plugin/host.mjs';
import { resolveProductDataRoot as pluginDataRoot } from '../packages/dsh-plugin/paths.mjs';
const { resolveProductDataRoot } = createRequire(import.meta.url)('../packages/contracts/product-data.cjs');
const quality = { width: 868, height: 4827, sourceWidth: 1080, sourceHeight: 6000, sourceVariant: 'full' };

test('shared image metadata strips unknown text and rejects invalid pixel budgets', () => {
  assert.deepEqual(normalizeImageQuality({ ...quality, instruction: 'untrusted', b64: 'pixels' }), quality);
  for (const value of [undefined, null, {}, { ...quality, width: 0 }, { ...quality, width: 1.5 }, { ...quality, width: Infinity },
    { ...quality, sourceVariant: 'original' }, { ...quality, sourceWidth: 40_000_001 }, { ...quality, sourceWidth: 8000, sourceHeight: 8000 }]) {
    assert.equal(normalizeImageQuality(value), undefined);
  }
  assert.equal(normalizeImageQuality({ ...quality, sourceWidth: 8000, sourceHeight: 5000 }).sourceWidth, 8000);
});

test('shared image regions reject sparse, reversed and out-of-source rectangles and copy valid coordinates', () => {
  const rectangle = [0, 0, 1080, 6000], normalized = normalizeImageRegion(rectangle, quality);
  assert.deepEqual(normalized, rectangle); assert.notEqual(normalized, rectangle);
  rectangle[2] = 99999; assert.equal(normalized[2], 1080);
  for (const value of [new Array(4), [0, ,1080,6000], [0,0,0,1], [1,1,0,2], [-1,0,1080,6000], [0,0,1081,6000], [0,0,1080,6001], [0,0,1080,0.5], null]) {
    assert.equal(normalizeImageRegion(value, quality), undefined);
  }
  assert.equal(normalizeImageRegion([0,0,1080,6000], { ...quality, sourceVariant: 'untrusted' }), undefined);
});

test('desktop preload and DSH share the same explicit public service contract', () => {
  let exposed;
  vm.runInNewContext(fs.readFileSync(new URL('../apps/desktop/preload.cjs', import.meta.url), 'utf8'), {
    require(name) { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'assistant'); exposed = api; } }, ipcRenderer: { invoke() {}, on() {}, removeListener() {} } }; },
  });
  assert.equal(SERVICE_METHODS, UI_SERVICE_METHODS);
  assert.equal(new Set(UI_SERVICE_METHODS).size, UI_SERVICE_METHODS.length);
  assert.equal(Object.isFrozen(UI_SERVICE_METHODS), true);
  for (const name of UI_SERVICE_METHODS) assert.equal(typeof exposed[name], 'function', name);
  const desktopNative = Object.keys(exposed).filter(name => name !== 'onChange' && !UI_SERVICE_METHODS.includes(name));
  assert.deepEqual(desktopNative.sort(), [...NATIVE_METHODS].sort());
  for (const internal of ['close','getStore','installMcp','grantAttachments','proposeSelfImprovementApproval','approveSelfImprovement']) assert.equal(Object.hasOwn(exposed, internal), false);
});

test('both product entries discover existing redirected data without creating another identity', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-shared-data-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roaming = path.join(home, 'normal-roaming'), discovery = { home, roaming, environment: {} };
  const standard = path.join(roaming, 'XiaoZhuShou');
  assert.equal(pluginDataRoot, resolveProductDataRoot);
  assert.equal(resolveProductDataRoot({}, discovery), standard);
  assert.equal(fs.existsSync(standard), false, 'discovery is read-only');
  const redirected = path.join(home, 'AppData/Local/Packages/OpenAI.Codex_synthetic-family/LocalCache/Roaming/XiaoZhuShou');
  fs.mkdirSync(path.join(redirected, 'db'), { recursive: true });
  fs.writeFileSync(path.join(redirected, 'db/assistant.sqlite'), 'synthetic-identity');
  assert.equal(resolveProductDataRoot({}, discovery), fs.realpathSync(redirected));
  fs.mkdirSync(path.join(standard, 'db'), { recursive: true });
  fs.writeFileSync(path.join(standard, 'db/assistant.sqlite'), 'another-synthetic-identity');
  assert.throws(() => resolveProductDataRoot({}, discovery), /多份小助手数据/);
  assert.equal(resolveProductDataRoot({ productDataRoot: redirected }, discovery), redirected);
  assert.equal(fs.readFileSync(path.join(standard, 'db/assistant.sqlite'), 'utf8'), 'another-synthetic-identity');
});

test('explicit desktop and environment data paths retain priority and reject relative paths', () => {
  const data = path.join(os.tmpdir(), 'synthetic-original-data'), envData = path.join(os.tmpdir(), 'synthetic-environment-data');
  const discovery = { candidates: [], environment: { XIAOZHUSHOU_DATA_HOME: envData } };
  assert.equal(resolveProductDataRoot({}, discovery), envData);
  assert.equal(resolveProductDataRoot({ productDataRoot: data }, discovery), data);
  assert.throws(() => resolveProductDataRoot({ productDataRoot: 'relative-data' }, discovery), /绝对路径/);
  assert.throws(() => resolveProductDataRoot({}, { environment: { XIAOZHUSHOU_DATA_HOME: 'relative-env-data' } }), /绝对路径/);
});

test('installed plugin layout loads both shared contracts from its payload without source-tree fallback', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-contract-package-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ['host.mjs','paths.mjs','portable-wechat.mjs','windows-protection.mjs']) {
    fs.copyFileSync(new URL('../packages/dsh-plugin/' + name, import.meta.url), path.join(directory, name));
  }
  const contracts = path.join(directory, 'payload/packages/contracts');
  fs.mkdirSync(contracts, { recursive: true });
  for (const name of ['product-data.cjs','ui-service-methods.mjs']) fs.copyFileSync(new URL('../packages/contracts/' + name, import.meta.url), path.join(contracts, name));
  const bridge = path.join(directory, 'payload/packages/wechat-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.copyFileSync(new URL('../packages/wechat-bridge/portable.mjs', import.meta.url), path.join(bridge, 'portable.mjs'));
  const host = await import(pathToFileURL(path.join(directory, 'host.mjs')).href);
  const paths = await import(pathToFileURL(path.join(directory, 'paths.mjs')).href);
  assert.deepEqual(host.SERVICE_METHODS, UI_SERVICE_METHODS);
  assert.equal(path.resolve(host.payloadRoot), path.join(directory, 'payload'));
  const explicit = path.join(directory, 'synthetic-data');
  assert.equal(paths.resolveProductDataRoot({ productDataRoot: explicit }), explicit);
  assert.equal(fs.existsSync(explicit), false);
});
