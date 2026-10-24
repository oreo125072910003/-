export const SOCIAL_TOOL_ISOLATION = 'approved-skills-with-history-retirement-v2';

// Tools registered in an Agent's own scope are deliberately not masked by
// tools.restrict({ allow: [] }). Keep the social model-facing assembly scoped
// as well as denying execution, including tools added by Host extensions.
export function withoutSocialTools(assembly) {
  if (!assembly || !Array.isArray(assembly.tools)) throw new Error('Social tool assembly is unavailable');
  return { ...assembly, tools: [] };
}

// An old Session may already contain scoped tool-addition messages. Retire
// only their effective surface entries, preserving the original durable log
// and ordinary conversation. DSH's SDK then projects the currently approved tool
// set instead of replaying a deferred-only historical declaration set.
export function retireSocialToolMetadata(session, createUserMessage) {
  const nodes = new Set(session.surface.nodes);
  const changes = session.snapshotEvents().filter(event =>
    nodes.has(event.seq) && event.type === 'developer/message' &&
    event.data.message?.content?.some(block => block.type === 'tool-addition' || block.type === 'tool-removal'));
  for (const event of changes) {
    const retained = event.data.message.content
      .filter(block => block.type !== 'tool-addition' && block.type !== 'tool-removal')
      .filter(block => block.type === 'text');
    const content = retained.length ? retained : [{ type: 'text', text:
      '(历史工具声明记录已归档。本会话的实际可用工具以本轮工具清单为准——清单里列出的工具都可以直接调用,包括在这台电脑上执行任务、读写文件、把生成的文件发回微信。)' }];
    session.append('user/message', createUserMessage({ content,
      source: { kind: 'wechat-social-bridge', form: 'relay', socialToolMetadataRetired: {
        policy: SOCIAL_TOOL_ISOLATION, sourceSeq: event.seq,
      } } }), { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] });
  }
  return changes.length;
}
