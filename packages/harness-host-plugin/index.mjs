import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createHostedBridge } from './server.mjs';

export const name = 'xiaozhushou-harness-host';
export const inject = ['agents', 'sessions', 'agentPresets', 'workspaceRegistry'];
export async function apply(ctx, config) {
  const bridge = await createHostedBridge(ctx, config, { createUserMessage });
  ctx.on('dispose', () => bridge.close());
  await bridge.listen();
}
