export const name = 'xiaozhushou-desktop-text-policy';
export const inject = ['tools'];
export const TEXT_POLICY = Symbol.for('xiaozhushou.desktop-text-policy.v1');

/** Start a native declaration series when none of its immediate tools remain.
 * DSH's addition-only projection defers tools added after the baseline. An
 * empty baseline (for example a text-only turn after compaction) otherwise
 * turns the next granted tool set into an invalid all-deferred request.
 * Append a native checkpoint; never edit the log or add an ungranted tool.
 */
export function ensureImmediateToolSeries(session, tools) {
  if (!tools.length || typeof session?.requestHeader !== 'function' ||
      typeof session?.toolHistory !== 'function' || typeof session?.append !== 'function') return;
  const header = session.requestHeader();
  if (!header) return;
  const names = new Set(tools.map(tool => tool.name));
  if (session.toolHistory().tools.some(tool => !tool.deferLoading && names.has(tool.name))) return;
  session.append('request/header', { header: { ...header, tools }, reason: 'series' });
}

/** Mounted only in product-owned agent contexts, never in the global Harness scope. */
export function apply(ctx) {
  if (typeof ctx.tools?.guard !== 'function') throw new Error('HOST_TEXT_GUARD_UNAVAILABLE');
  ctx.tools.presentAs?.('native');
  ctx.tools.guard(exec => (exec?.agent?.ctx?.[OWNER_ACCESS] ?? ctx[OWNER_ACCESS])?.check(exec?.name) ? undefined : '小助手本轮没有授权此工具。');
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next();
    if (!Array.isArray(assembly?.tools)) throw new Error('HOST_TEXT_ASSEMBLY_UNVERIFIED');
    const names = (context?.scope?.ctx?.[OWNER_ACCESS] ?? ctx[OWNER_ACCESS])?.names() ?? new Set();
    const tools = assembly.tools.filter(tool => names.has(tool.name)).map(({ deferLoading, ...tool }) => tool);
    ensureImmediateToolSeries(context?.scope?.session, tools);
    return { ...assembly, tools };
  }, { prepend: true });
  ctx[TEXT_POLICY] = true;
}
import { OWNER_ACCESS } from './owner-access.mjs';
