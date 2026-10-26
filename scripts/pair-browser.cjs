// Local owner provisioning; not exposed to the renderer, DSH or external chats.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const option = name => process.argv[process.argv.indexOf(name) + 1];
const dataDir = option('--data-home'), input = option('--connection-file');
if (!process.argv.includes('--data-home') || !process.argv.includes('--connection-file') || !path.isAbsolute(dataDir || '') || !path.isAbsolute(input || '')) {
  console.error('需要指定本机数据目录与配对文件。'); app.exit(1);
} else {
  // OSCrypt keys belong to the product's Chromium profile, not the helper's
  // default Electron profile. Use exactly the desktop app's userData path.
  app.setName('小助手');
  app.setPath('userData', path.join(fs.realpathSync(dataDir), 'desktop'));
}
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const stat = fs.lstatSync(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw Error('配对文件无效。');
  const value = JSON.parse(fs.readFileSync(input, 'utf8'));
  const secretStore = require('../apps/desktop/secret-store.cjs').createSecretStore({ dataDir, safeStorage });
  const { saveBrowserConnection } = await import(pathToFileURL(path.resolve(__dirname, '../apps/service/browser-connection.mjs')).href);
  const result = await saveBrowserConnection({ ...value, dataDir, secretStore });
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(() => { console.error('浏览器配对未完成，原信息已保留。'); app.exit(1); });
