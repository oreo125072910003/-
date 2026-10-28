import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'packages/dsh-plugin/package.json'), 'utf8'));
const full = process.argv.includes('--full'), reuse = process.argv.includes('--reuse');
const output = reuse ? path.resolve(process.argv[process.argv.indexOf('--reuse') + 1]) : path.join(root, 'dist/dsh-plugin', 'official-verification-' + Date.now()); fs.mkdirSync(output, { recursive: true });
const candidate = path.join(output, 'package'); if (!reuse) fs.cpSync(path.join(root, 'dist/dsh-plugin', version + (full ? '-full' : ''), 'package'), candidate, { recursive: true });
async function freePort() { const server = http.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
let bridgePort = await freePort(); const webPort = await freePort();
const patchFile = path.join(candidate, 'cordis.patch.yml'), patch = YAML.parse(fs.readFileSync(patchFile, 'utf8'));
if (!reuse) { patch[0].insert[0].config = { productDataRoot: path.join(output, 'data'), port: bridgePort }; fs.writeFileSync(patchFile, YAML.stringify(patch)); }
else bridgePort = patch[0].insert[0].config.port;
const env = { ...process.env, DSH_HOME: path.join(output, 'home') };
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const prefix = [npmCli, 'exec', '--yes', '--package=@deepseek-ai/dsh@0.2.1-rc.3', '--', 'dsh'];
function launch(args, logfile) {
  const child = spawn(process.execPath, [...prefix, ...args], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let outputText = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { outputText += data.toString('utf8'); fs.appendFileSync(logfile, data); });
  return { child, text: () => outputText, completed: new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); }) };
}
let running, browser;
try {
  console.log(JSON.stringify({ stage: 'official-plugin-install', isolatedProfile: true }));
  if (!reuse) {
    const installed = launch(['plugin', '--profile', 'web', 'add', 'file:' + candidate, '--ignore-scripts'], path.join(output, 'install.log'));
    const status = await installed.completed;
    if (status !== 0) throw Error('官方 CLI 安装失败，详情：' + path.join(output, 'install.log'));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('xiaozhushou-harness-host'));
  console.log(JSON.stringify({ stage: 'official-host-start', pluginRegistered: true }));
  running = launch(['web', '--no-open', '--port', String(webPort)], path.join(output, 'host.private.log'));
  const origin = 'http://127.0.0.1:' + webPort;
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    if (running.child.exitCode !== null) throw Error('DSH 启动失败，详情：' + path.join(output, 'host.private.log'));
    try { const response = await fetch(origin + '/xiaozhushou/state', { signal: AbortSignal.timeout(1000) }); if (response.ok) { const state = await response.json(); if (state.state === 'running') { ready = true; break; } } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, '真实 DSH 插件服务没有启动。');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push({ text: message.text(), url: message.location().url }); });
  await page.goto(origin + '/xiaozhushou/'); await page.locator('#task-prompt').waitFor();
  await page.screenshot({ path: path.join(output, '真实DSH内置工作台.png') });
  const bootstrap = await page.evaluate(() => window.assistant.getBootstrap());
  assert.equal(bootstrap.runtime.version, version); assert.equal(bootstrap.runtime.source, 'existing-harness-host');
  // Open the real host shell as well, using only its generated local bootstrap
  // URL if it has one. It never contains a user's account or cloud credentials.
  const urls = running.text().match(/https?:\/\/127\.0\.0\.1:\d+[^\s\u001b]*/g) || [];
  const bootstrapUrl = urls.find(url => url.startsWith(origin) && url.length > origin.length + 1) || origin;
  await page.goto(bootstrapUrl);
  await page.waitForTimeout(1500);
  const preview = page.getByRole('button', { name: '继续', exact: true });
  if (await preview.count()) await preview.click();
  fs.writeFileSync(path.join(output, 'shell-buttons.json'), JSON.stringify(await page.locator('button').evaluateAll(buttons => buttons.map(button => ({ text: button.textContent, label: button.getAttribute('aria-label'), haspopup: button.getAttribute('aria-haspopup') }))), null, 2));
  await page.getByRole('button', { name: '账号菜单', exact: true }).click();
  fs.writeFileSync(path.join(output, 'shell-account-menu.txt'), await page.locator('body').innerText());
  await page.getByText('设置', { exact: true }).last().click();
  await page.waitForTimeout(200);
  fs.writeFileSync(path.join(output, 'shell-after-more.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: path.join(output, 'DSH更多菜单.png') });
  fs.writeFileSync(path.join(output, 'loaded-plugin-scripts.json'), JSON.stringify(await page.evaluate(() => [...document.scripts].map(script => script.src).filter(url => url.includes('xiaozhushou')))));
  await page.getByText('小助手与微信', { exact: true }).first().click();
  await page.getByRole('button', { name: '小助手 · 微信', exact: true }).click();
  await page.frameLocator('iframe[title="小助手工作台"]').locator('#task-prompt').waitFor();
  fs.writeFileSync(path.join(output, 'shell-text.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: path.join(output, 'DSH插件入口.png') });
  const report = { ok: true, version, officialCliVersion: '0.2.1-rc.3', installedInIsolatedProfile: true, nativeServiceRunningInDsh: true,
    realHostedRuntime: true, nativeWorkbenchRendered: true, realClientEntryAndEmbeddedPanel: true, shellPageErrors: errors, liveProfileModified: false, realWechatMessagesSent: 0, output };
  fs.writeFileSync(path.join(output, 'console-errors.json'), JSON.stringify(errors, null, 2));
  assert.deepEqual(errors.filter(error => typeof error === 'string' || !error.url.endsWith('/favicon.ico')), []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (running?.child.pid && running.child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(running.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
