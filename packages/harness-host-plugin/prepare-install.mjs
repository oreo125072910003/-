import { readFile, mkdir, realpath, writeFile, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const inside = (root, target) => { const value = path.relative(root, target); return value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value); };
async function exists(target) { try { await access(target); return true; } catch { return false; } }
async function physicalProspectivePath(target) {
  const resolved = path.resolve(target);
  try { return await realpath(resolved); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(resolved);
    if (parent === resolved) throw error;
    return path.join(await physicalProspectivePath(parent), path.basename(resolved));
  }
}

/** Prepare reviewable product-owned artifacts only. Does not alter any Harness profile. */
export async function prepareHostedPluginInstall({ productDataRoot, workspacesRoot, installDirectory, port = 11234, provider = 'deepseek-account', model = 'deepseek-flash' } = {}) {
  if (![productDataRoot, workspacesRoot, installDirectory].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('HOST_INSTALL_PATH_INVALID');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('HOST_INSTALL_PORT_INVALID');
  if (![provider, model].every(value => typeof value === 'string' && /^[\w./:-]{1,160}$/.test(value))) throw new Error('HOST_INSTALL_MODEL_INVALID');
  await mkdir(productDataRoot, { recursive: true });
  const dataRoot = await realpath(productDataRoot);
  const prospectiveWorkspaces = await physicalProspectivePath(workspacesRoot);
  if (!inside(dataRoot, prospectiveWorkspaces)) throw new Error('HOST_WORKSPACE_ROOT_OUTSIDE_PRODUCT');
  await mkdir(workspacesRoot, { recursive: true });
  const workspaces = await realpath(workspacesRoot);
  if (!inside(dataRoot, workspaces)) throw new Error('HOST_WORKSPACE_ROOT_OUTSIDE_PRODUCT');
  const prospectiveInstall = await physicalProspectivePath(installDirectory);
  if (!inside(dataRoot, prospectiveInstall) || prospectiveInstall === dataRoot) throw new Error('HOST_INSTALL_OUTSIDE_PRODUCT');
  await mkdir(installDirectory, { recursive: true });
  const destination = await realpath(installDirectory);
  if (!inside(dataRoot, destination)) throw new Error('HOST_INSTALL_OUTSIDE_PRODUCT');
  const markerFile = path.join(destination, '.xiaozhushou-host-plugin');
  if (await exists(path.join(destination, 'package.json')) && !await exists(markerFile)) throw new Error('HOST_INSTALL_DIRECTORY_NOT_OWNED');
  await writeFile(markerFile, 'xiaozhushou-harness-host-v1\n', { mode: 0o600 });
  const contents = await Promise.all(['package.json', 'index.mjs', 'server.mjs', 'image-input.mjs', 'text-policy.mjs', 'owner-access.mjs', 'product-access.mjs', 'locale/zh.json', 'locale/en.json', 'icon.svg'].map(async name => [name, await readFile(path.join(sourceDir, name), 'utf8')]));
  contents.push(['contract-image-input.mjs', await readFile(path.join(sourceDir, '../contracts/image-input.mjs'), 'utf8')]);
  contents.push(['contract-tool-policy.mjs',await readFile(path.join(sourceDir,'../contracts/tool-policy.mjs'),'utf8')]);
  contents.push(['contract-model-failure.mjs',await readFile(path.join(sourceDir,'../contracts/model-failure.mjs'),'utf8')]);
  contents.push(['contract-product-tools.mjs',await readFile(path.join(sourceDir,'../contracts/product-tools.mjs'),'utf8')]);
  const revision = createHash('sha256').update('physical-module-revisions-v2\0').update(contents.map(([name, text]) => name + '\0' + text).join('\0')).digest('hex').slice(0, 16);
  // Harness can normalize query strings while resolving dependencies. Give each
  // local module a new physical filename so live reload cannot reuse old code.
  for (const [name, source] of contents) {
    const localized = source.replaceAll('../contracts/image-input.mjs', './contract-image-input.mjs').replaceAll('../contracts/tool-policy.mjs','./contract-tool-policy.mjs').replaceAll('../contracts/model-failure.mjs','./contract-model-failure.mjs').replaceAll('../contracts/product-tools.mjs','./contract-product-tools.mjs').replaceAll("'./product-tools.mjs'", "'./contract-product-tools.mjs'");
    const content=name.endsWith('.mjs')?localized.replace(/(['"])(\.\/[a-z-]+)\.mjs\1/g,(_match,quote,module)=>quote+module+'-'+revision+'.mjs'+quote):localized;
    await mkdir(path.dirname(path.join(destination, name)), { recursive: true }); await writeFile(path.join(destination, name), content);
    if (name === 'index.mjs') await writeFile(path.join(destination, 'entry-' + revision + '.mjs'), content);
    else if (name.endsWith('.mjs')) await writeFile(path.join(destination, name.slice(0, -4) + '-' + revision + '.mjs'), content);
  }
  const tokenDir = path.join(dataRoot, 'harness-host'); await mkdir(tokenDir, { recursive: true });
  if (!inside(dataRoot, await realpath(tokenDir))) throw new Error('HOST_TOKEN_DIRECTORY_REFUSED');
  const tokenFile = path.join(tokenDir, 'bridge-token.txt');
  await writeFile(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  // Bundle patches resolve relative modules inside the installed package. An
  // absolute source URL escapes the profile's shared-package resolution.
  // DSH treats a relative patch name as a filesystem path, including any '?'.
  // A distinct entry filename preserves reloads without escaping the package.
  const moduleUri = name => './' + (name === 'index.mjs' ? 'entry-' + revision + '.mjs' : name);
  const bridgeConfig = { productDataRoot: dataRoot, workspacesRoot: workspaces, tokenFile, port, provider, model, agentPreset: 'xiaozhushou-desktop-text-v1',revision,pluginVersion:JSON.parse(contents.find(([name])=>name==='package.json')[1]).version };
  const patch = '- insert:\n' +
    '    - id: xiaozhushou-harness-host\n      name: ' + JSON.stringify(moduleUri('index.mjs')) + '\n      config: ' + JSON.stringify(bridgeConfig) + '\n' +
    '    - id: preset-xiaozhushou-desktop-text\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: xiaozhushou-desktop-text-v1\n        name: 小助手\n        description: 小助手独立产品会话，复用现有 Harness 登录\n        order: 21\n        plugins:\n' +
    '          - id: persona\n            name: "@deepseek-ai/dsh-persona"\n            config:\n              prefix: ' + JSON.stringify('你是小助手，是主人电脑上持续陪伴的个人助手。用自然清楚的中文交流。身份、任务和成果属于小助手；准确区分计划、执行与验证。只使用本轮主人明确授权且可见的能力；没有真实执行证据时，不能声称已操作微信、邮箱或本机文件。') + '\n              suffix: ""\n              includeRuntimeContext: false\n';
  await writeFile(path.join(destination, 'cordis.patch.yml'), patch);
  const endpoint = 'http://127.0.0.1:' + port, configFile = path.join(tokenDir, 'client.json');
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, endpoint, tokenFile, installDirectory: destination, revision }, null, 2) + '\n', { mode: 0o600 });
  return { installDirectory: destination, configFile, endpoint, tokenFile, revision, dependencySource: 'harness-runtime', harnessProfileModified: false, restartRequired: 'desktop-plugin-install-or-reload-required' };
}
