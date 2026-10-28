export const CONTEXT_POLICY = Object.freeze({ thresholdTokens: 120000, retainTokens: 24000, retainUserMessages: 12 });

export function conversationContextOwner(ctx) {
  const policy = typeof ctx.get === 'function' ? ctx.get('biliBasicCompactionPolicy') : ctx.biliBasicCompactionPolicy;
  return policy?.owner === 'billion-context' ? 'billion-context' : 'dsh-native';
}

// Read-only cut validation; the native engine validates the chosen span again.
function balancedToolCut(session, cut) {
  let pending = 0;
  for (const seq of session.surface.nodes) {
    if (seq === cut) return pending === 0;
    const event = session.eventAt(seq);
    if (event?.type === 'assistant/message') pending += (event.data?.message?.content ?? []).filter(block => block.type === 'tool-call').length;
    if (event?.type === 'tool/result') pending--;
    if (pending < 0) return false;
  }
  return false;
}

/** Select a priced prefix, retaining recent dialogue and complete tool pairs. */
export function selectConversationPrefix(session, measurement, balancedBefore, policy = CONTEXT_POLICY) {
  const nodes = session?.surface?.nodes, priced = measurement?.nodes;
  if (!Array.isArray(nodes) || !Array.isArray(priced) || nodes.length !== priced.length ||
      nodes.some((seq, i) => priced[i]?.seq !== seq || !Number.isFinite(priced[i].tokens) || priced[i].tokens < 0)) return null;
  if (measurement.totalTokens < policy.thresholdTokens || !nodes.length) return null;
  const first = session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;
  let keep = nodes.length, tokens = 0, users = 0;
  for (let i = nodes.length - 1; i >= first; i--) {
    tokens += priced[i].tokens;
    if (session.eventAt(nodes[i])?.type === 'user/message') users++;
    keep = i;
    if (tokens >= policy.retainTokens && users >= policy.retainUserMessages) break;
  }
  while (keep > first && !balancedBefore(session, nodes[keep])) keep--;
  if (keep <= first) return null;
  return { start: nodes[first], end: nodes[keep - 1] };
}

/** Use DSH's own meter, summary engine and durable surface replacement. */
export function bindConversationContext(agentCtx, hostCtx, { balancedBefore = balancedToolCut, onMaintenance = () => {} } = {}) {
  const presetService = hostCtx.agentPresets?.serviceFor;
  // Cordis get() is the optional-service API. A missing service must not fall
  // through to a property read, which requires a declared injection.
  const hostCompaction = typeof hostCtx.get === 'function' ? hostCtx.get('compaction') : hostCtx.compaction;
  const meter = typeof hostCtx.get === 'function' ? hostCtx.get('tokenMeter') : hostCtx.tokenMeter;
  if ((typeof hostCompaction?.compactRegion !== 'function' && typeof presetService !== 'function') || typeof meter?.measure !== 'function' || typeof balancedBefore !== 'function') return null;
  return agentCtx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted();
    // The installed compressor explicitly owns this lane and refuses native
    // summary requests. Respect its native service marker before starting a
    // transaction; an optional speed optimization must not break normal turns.
    if (conversationContextOwner(hostCtx) === 'billion-context') {
      onMaintenance({ state: 'delegated', owner: 'billion-context', beforeTokens: meter.measure(agent.session).totalTokens });
      return next();
    }
    const compaction = hostCtx.agentPresets?.serviceFor?.(agent, 'compaction') ?? hostCompaction;
    if (typeof compaction?.compactRegion !== 'function') {
      onMaintenance({ state: 'unavailable', reason: 'native-engine-unavailable' });
    } else if (!signal.aborted) {
      const before = meter.measure(agent.session);
      const range = selectConversationPrefix(agent.session, before, balancedBefore);
      if (!range) onMaintenance({ state: before.totalTokens < CONTEXT_POLICY.thresholdTokens ? 'not-needed' : 'deferred', beforeTokens: before.totalTokens });
      if (range) {
        const started = Date.now();
        onMaintenance({ state: 'running', beforeTokens: before.totalTokens });
        try {
          await compaction.compactRegion(range.start, range.end, agent, signal);
          signal.throwIfAborted();
          // Keep the replacement checkpoint durable before a normal request.
          if (await hostCtx.sessions.flush(agent.session) === false) throw Error('CONTEXT_CHECKPOINT_NOT_SAVED');
          onMaintenance({ state: 'completed', beforeTokens: before.totalTokens, afterTokens: meter.measure(agent.session).totalTokens, elapsedMs: Date.now() - started });
        } catch (error) {
          signal.throwIfAborted();
          onMaintenance({ state: 'failed', elapsedMs: Date.now() - started });
          // Never dispatch on a failed summary/commit/checkpoint. Native DSH
          // owns the transaction and the user's original log stays available.
          throw error;
        }
      }
    }
    return next();
  }, { prepend: true });
}
