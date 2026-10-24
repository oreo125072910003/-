export const name = 'xiaozhushou-desktop-text-policy';
export const inject = ['tools'];
export const TEXT_POLICY = Symbol.for('xiaozhushou.desktop-text-policy.v1');

/** Mounted only in product-owned agent contexts, never in the global Harness scope. */
export function apply(ctx) {
  if (typeof ctx.tools?.guard !== 'function') throw new Error('HOST_TEXT_GUARD_UNAVAILABLE');
  ctx.tools.presentAs?.('native');
  ctx.tools.guard(exec => (exec?.agent?.ctx?.[OWNER_ACCESS] ?? ctx[OWNER_ACCESS])?.check(exec?.name) ? undefined : '小助手本轮没有授权此工具。');
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!Array.isArray(assembly?.tools)) throw new Error('HOST_TEXT_ASSEMBLY_UNVERIFIED');
    const names = (context?.scope?.ctx?.[OWNER_ACCESS] ?? ctx[OWNER_ACCESS])?.names() ?? new Set();
    return { ...assembly, tools: assembly.tools.filter(tool => names.has(tool.name)).map(({ deferLoading, ...tool }) => tool) };
  }, { prepend: true });
  ctx[TEXT_POLICY] = true;
}
import { OWNER_ACCESS } from './owner-access.mjs';
