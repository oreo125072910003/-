const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// A packaged launcher can redirect Roaming. Both product entry points must
// discover the same existing identity, and neither may choose between two DBs.
function resolveProductDataRoot(options = {}, { home = os.homedir(), environment = process.env, roaming = environment.APPDATA || path.join(home, 'AppData/Roaming'), candidates } = {}) {
  const explicit = options.productDataRoot || environment.XIAOZHUSHOU_DATA_HOME;
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw Error('小助手数据目录需要绝对路径。');
    return explicit;
  }
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
  if (existing.length > 1) throw Error('找到多份小助手数据。请明确指定原来的数据目录（独立桌面 --data-home，插件 productDataRoot），原数据均已保留。');
  return existing[0] || standard;
}

module.exports = { resolveProductDataRoot };
