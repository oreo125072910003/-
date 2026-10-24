import { readFile, mkdir, realpath, writeFile, access } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
export async function prepareHostedPluginInstall({ productDataRoot, workspacesRoot, installDirectory, port = 11234, provider = 'deepseek', model = 'deepseek-flash' } = {}) {
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
  const contents = await Promise.all(['package.json', 'index.mjs', 'server.mjs', 'text-policy.mjs', 'owner-access.mjs', 'locale/zh.json', 'locale/en.json', 'icon.svg'].map(async name => [name, await readFile(path.join(sourceDir, name), 'utf8')]));
  const revision = createHash('sha256').update(contents.map(([name, text]) => name + '\0' + text).join('\0')).digest('hex').slice(0, 16);
  for (const [name, content] of contents) { await mkdir(path.dirname(path.join(destination, name)), { recursive: true }); await writeFile(path.join(destination, name), content); }
  const tokenDir = path.join(dataRoot, 'harness-host'); await mkdir(tokenDir, { recursive: true });
  if (!inside(dataRoot, await realpath(tokenDir))) throw new Error('HOST_TOKEN_DIRECTORY_REFUSED');
  const tokenFile = path.join(tokenDir, 'bridge-token.txt');
  await writeFile(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const moduleUri = name => pathToFileURL(path.join(destination, name)).href + '?revision=' + revision;
  const bridgeConfig = { productDataRoot: dataRoot, workspacesRoot: workspaces, tokenFile, port, provider, model, agentPreset: 'xiaozhushou-desktop-text-v1' };
  const patch = '- insert:\n' +
    '    - id: xiaozhushou-harness-host\n      name: ' + JSON.stringify(moduleUri('index.mjs')) + '\n      config: ' + JSON.stringify(bridgeConfig) + '\n' +
    '    - id: preset-xiaozhushou-desktop-text\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: xiaozhushou-desktop-text-v1\n        name: 小助手\n        description: 小助手独立产品会话，复用现有 Harness 登录\n        order: 21\n        plugins:\n' +
    '          - id: persona\n            name: "@deepseek-ai/dsh-persona"\n            config:\n              prefix: ' + JSON.stringify('你是小助手，是主人电脑上持续陪伴的个人助手。用自然清楚的中文交流。身份、任务和成果属于小助手；准确区分计划、执行与验证。只使用本轮主人明确授权且可见的能力；没有真实执行证据时，不能声称已操作微信、邮箱或本机文件。') + '\n              suffix: ""\n              includeRuntimeContext: false\n';
  await writeFile(path.join(destination, 'cordis.patch.yml'), patch);
  const endpoint = 'http://127.0.0.1:' + port, configFile = path.join(tokenDir, 'client.json');
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, endpoint, tokenFile, installDirectory: destination, revision }, null, 2) + '\n', { mode: 0o600 });
  return { installDirectory: destination, configFile, endpoint, tokenFile, revision, dependenciesInstalled: await exists(path.join(destination, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json')), harnessProfileModified: false, restartRequired: 'desktop-plugin-install-or-reload-required' };
}
