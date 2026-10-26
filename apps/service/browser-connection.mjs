import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const secretName = 'browser-extension-token';
const fail = () => Object.assign(Error('浏览器配对信息无效，请重新配对；原连接信息已保留。'), { code: 'BROWSER_PAIRING_INVALID' });
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);

export function installedBrowserChannel({ env = process.env, platform = process.platform } = {}) {
  if (env.PLAYWRIGHT_MCP_BROWSER) return env.PLAYWRIGHT_MCP_BROWSER;
  if (platform === 'win32' && env.LOCALAPPDATA) {
    for (const [channel, relative] of [['msedge', 'Microsoft/Edge/User Data'], ['chrome', 'Google/Chrome/User Data']]) {
      const root = path.join(env.LOCALAPPDATA, relative);
      try {
        const profiles = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name));
        if (profiles.some(entry => fs.existsSync(path.join(root, entry.name, 'Extensions', extensionId)))) return channel;
      } catch { /* An uninstalled browser has no profile directory. */ }
    }
  }
  return 'chrome';
}

function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['chrome', 'msedge'].includes(value.browser)) throw fail();
  const profile = value.profileDirName;
  if (profile !== undefined && (typeof profile !== 'string' || !/^[^<>:"/\\\x00-\x1f]{1,80}$/.test(profile) || /[. ]$/.test(profile) || profile === '.')) throw fail();
  return { browser: value.browser, ...(profile ? { profileDirName: profile } : {}) };
}

function filename(dataDir) {
  if (!path.isAbsolute(dataDir)) throw fail();
  const target = path.join(dataDir, 'browser-connection.json');
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw fail();
  }
  return target;
}

/** Trusted local pairing only. This is deliberately not a model/task tool. */
export async function saveBrowserConnection({ dataDir, secretStore, browser, profileDirName, extensionToken }) {
  const config = selection({ browser, profileDirName });
  if (!tokenValid(extensionToken) || !secretStore?.set || !secretStore?.get || !secretStore?.delete) throw fail();
  fs.mkdirSync(dataDir, { recursive: true });
  const target = filename(dataDir), temporary = target + '.' + randomUUID() + '.tmp';
  const previous = await secretStore.get(secretName);
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...config }) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await secretStore.set(secretName, extensionToken);
    try { fs.renameSync(temporary, target); }
    catch (error) { if (previous) await secretStore.set(secretName, previous); else await secretStore.delete(secretName); throw error; }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { paired: true, ...config, automaticConnection: true };
}

export async function readBrowserConnection({ dataDir, secretStore, env = process.env, platform = process.platform }) {
  let saved = {};
  const target = filename(dataDir);
  if (fs.existsSync(target)) {
    let value;
    try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { throw fail(); }
    if (!value || typeof value !== 'object' || value.version !== 1 || Object.keys(value).some(key => !['version', 'browser', 'profileDirName'].includes(key))) throw fail();
    saved = selection(value);
  }
  const config = selection({ browser: env.PLAYWRIGHT_MCP_BROWSER || saved.browser || installedBrowserChannel({ env, platform }),
    profileDirName: env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME || saved.profileDirName });
  const extensionToken = env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || (saved.browser ? await secretStore?.get(secretName) : null);
  if (extensionToken && !tokenValid(extensionToken)) throw fail();
  if (saved.browser && !extensionToken) throw Object.assign(Error('已保存的浏览器配对暂不可用，请重新配对后连接。'), { code: 'BROWSER_PAIRING_UNAVAILABLE' });
  return { ...config, ...(extensionToken ? { extensionToken } : {}) };
}
