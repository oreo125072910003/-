import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/dsh-plugin/ui-smoke'); fs.mkdirSync(output, { recursive: true });
const full = process.argv.includes('--full');
const stage = path.join(root, 'dist/dsh-plugin', full ? '1.1.0-full/package' : '1.1.0/package');
const { createNativeAssistant } = await import(pathToFileURL(path.join(stage, 'host.mjs')).href);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhushou-dsh-smoke-'));
const attachment = path.join(directory, '合成资料.txt'); fs.writeFileSync(attachment, '数量：3\n单价：20\n这是离线插件界面验收资料。');
const data = new Map();
const runtime = { inspectHostedRuntime: async () => ({ available: true, source: 'existing-harness-host', detail: '离线界面验收，没有调用模型', capabilities: {} }), runHostedTask: async () => { throw Error('Offline only'); } };
let route, native, browser;
const server = http.createServer((req, res) => route.handler(req, res));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = { webServer: { port: server.address().port, register: value => { route = value; return () => {}; } } };
  native = await createNativeAssistant(ctx, { productDataRoot: directory }, { runtime,
    secretStore: { get: async key => data.get(key), set: async (key, value) => data.set(key, value), delete: async key => data.delete(key) },
    operate: async (operation, value) => { assert.equal(operation, 'dialog'); assert.equal(value.kind, 'files'); return [attachment]; } });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:' + server.address().port + '/xiaozhushou/');
  await page.locator('#task-prompt').waitFor();
  if (full) {
    await page.getByRole('button', { name: '新电脑 · 连接微信', exact: true }).waitFor();
    await page.getByRole('button', { name: '新电脑 · 连接微信', exact: true }).click();
    await page.locator('.portable-setup-dialog[open]').waitFor();
    await page.screenshot({ path: path.join(output, '新电脑连接向导.png') });
    await page.getByRole('button', { name: '关闭微信准备', exact: true }).click();
  }
  await page.locator('[data-action="attach"]').click();
  await page.getByText('合成资料.txt', { exact: false }).first().waitFor();
  await page.locator('.work-options summary').click();
  await page.locator('#task-type').selectOption('organize');
  await page.locator('#task-prompt').fill('请整理这份合成资料');
  await page.locator('#send-button').click();
  await page.locator('[data-action="open-task"]').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.task-list')?.textContent.includes('已完成'));
  await page.locator('[data-action="open-artifact"]').first().waitFor();
  await page.screenshot({ path: path.join(output, '任务成果.png') });
  await page.locator('#close-drawer').click();
  for (const [id, title] of [['wechat','微信'], ['mail','邮箱'], ['capabilities','能力'], ['settings','控制面板']]) {
    await page.locator('[data-page="' + id + '"]').first().click();
    await page.waitForTimeout(150);
    assert.ok((await page.locator('body').innerText()).includes(title));
    await page.screenshot({ path: path.join(output, id + '.png') });
  }
  await page.locator('[name="assistantName"]').fill('插件验收小助手');
  await page.locator('#save-settings').click();
  await page.waitForFunction(() => document.body.textContent.includes('已保存'));
  await page.reload();
  await page.locator('#task-prompt').waitFor();
  assert.ok((await page.locator('body').innerText()).includes('插件验收小助手'));
  await page.setViewportSize({ width: 920, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, '窄窗口.png') });
  assert.deepEqual(errors, []);
  const report = { ok: true, packageVersion: '1.1.0', realPackagedService: true, renderedPages: ['home','task','wechat','mail','capabilities','settings'],
    localTaskArtifacts: true, nativeFilePickerAdapter: true, identityPersisted: true, narrowViewport: true, consoleErrors: errors,
    modelCalled: false, wechatMessagesSent: 0, isolatedData: true, installedIntoLiveDsh: false };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close(); await native?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('xiaozhushou-dsh-smoke-')) throw Error('Unexpected cleanup path');
  fs.rmSync(directory, { recursive: true, force: true });
}
