import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createHostedBridge } from './payload/packages/harness-host-plugin/server.mjs';
import { createNativeAssistant } from './host.mjs';
import { resolveProductDataRoot } from './paths.mjs';

export const name = 'xiaozhushou-harness-host';
export const inject = ['agents','sessions','agentPresets','workspaceRegistry','webServer'];
const { version } = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8'));
export async function apply(ctx, options = {}) {
  if (process.platform !== 'win32') throw Error('小助手与微信插件目前支持 Windows。');
  const selected = resolveProductDataRoot(options);
  await fs.mkdir(selected, { recursive: true });
  const productDataRoot = await fs.realpath(selected), workspacesRoot = path.join(productDataRoot, 'tasks');
  await fs.mkdir(workspacesRoot, { recursive: true });
  const tokenDir = path.join(productDataRoot, 'harness-host'); await fs.mkdir(tokenDir, { recursive: true });
  const tokenFile = path.join(tokenDir, 'bridge-token.txt');
  await fs.writeFile(tokenFile, randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const config = { ...options, productDataRoot, workspacesRoot, tokenFile, port: options.port ?? 11234, provider: options.provider || 'deepseek-account', model: options.model || 'deepseek-flash', agentPreset: 'xiaozhushou-desktop-text-v1', pluginVersion: version, revision: 'native-assistant-' + version };
  const bridge = await createHostedBridge(ctx, config, { createUserMessage });
  let native;
  ctx.effect(() => async () => { try { await native?.close(); } finally { await bridge.close(); } }, 'xiaozhushou: integrated service');
  const endpoint = await bridge.listen();
  await fs.writeFile(path.join(tokenDir, 'client.json'), JSON.stringify({ schemaVersion: 1, endpoint, tokenFile, revision: config.revision }, null, 2) + '\n', { mode: 0o600 });
  native = await createNativeAssistant(ctx, config);
  // Data may still be owned by the old desktop. Keep the DSH panel available;
  // its next user operation retries after the owner exits. Never steal the lock.
  void native.start().catch(() => {});
}
