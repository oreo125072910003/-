import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The old desktop may have been started by a packaged app, whose Roaming
// directory differs from DSH's. Choose an existing database, never a new empty
// identity merely because the launcher environment changed.
export function resolveProductDataRoot(options = {}, { home = os.homedir(), roaming = process.env.APPDATA || path.join(home, 'AppData/Roaming'), candidates } = {}) {
  const explicit = options.productDataRoot || process.env.XIAOZHUSHOU_DATA_HOME;
  if (explicit) { if (!path.isAbsolute(explicit)) throw Error('小助手数据目录需要绝对路径。'); return explicit; }
  const standard = path.join(roaming, 'XiaoZhuShou');
  let roots = candidates;
  if (!roots) {
    roots = [standard];
    const packages = path.join(home, 'AppData/Local/Packages');
    if (fs.existsSync(packages)) for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && /^OpenAI\.Codex_/.test(entry.name)) roots.push(path.join(packages, entry.name, 'LocalCache/Roaming/XiaoZhuShou'));
    }
  }
  const existing = [...new Set(roots.filter(directory => fs.existsSync(path.join(directory, 'db/assistant.sqlite'))).map(directory => fs.realpathSync(directory)))];
  if (existing.length > 1) throw Error('找到多份小助手数据。请在插件配置中填写原来的 productDataRoot，原数据均已保留。');
  return existing[0] || standard;
}
