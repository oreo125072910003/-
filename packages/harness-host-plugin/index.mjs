import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createHostedBridge } from './server.mjs';

export const name = 'xiaozhushou-harness-host';
export const inject = ['agents', 'sessions', 'agentPresets', 'workspaceRegistry'];
export async function apply(ctx, config) {
  const bridge = await createHostedBridge(ctx, config, { createUserMessage });
  // Cordis owns async cleanup through effects. A plain 'dispose' event listener
  // is not a lifecycle effect and leaves the HTTP listener alive on hot reload.
  ctx.effect(() => () => bridge.close(), 'xiaozhushou: hosted bridge');
  await bridge.listen();
}
