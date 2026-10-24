import { chatSettingsSnapshot, applyChatSettings } from '../../代码/项目/public/console/conversation-settings.mjs';
import { allowedConversation, validateConversationSettings } from '../../代码/项目/packages/dsh-social-bridge-plugin/conversation-policy.mjs';
import { validateStickerSettings } from '../../代码/项目/components/qq-bridge/src/core/sticker-policy.js';
import { validateProactiveSettings } from '../../代码/项目/components/qq-bridge/src/core/proactive-policy.js';

// These are the original console functions, not a second per-chat schema.
export { chatSettingsSnapshot, applyChatSettings, allowedConversation, validateConversationSettings };

function keyFor(config, kind, target) {
  const key = 'wechat:' + kind + ':' + target;
  if (!allowedConversation(config?.wechat, key)) throw Object.assign(new Error('CONVERSATION_NOT_ALLOWED'), { code: 'CONVERSATION_NOT_ALLOWED' });
  return key;
}

export function readConversationSettings(config, { kind, target } = {}) {
  const key = keyFor(config, kind, target);
  return { key, ...chatSettingsSnapshot(config, key) };
}

/** Returns a detached candidate. The product service owns durable commit/revision checks. */
export function updateConversationSettings(config, { kind, target, settings, access } = {}) {
  const key = keyFor(config, kind, target), next = structuredClone(config);
  applyChatSettings(next, key, settings, access);
  validateConversationSettings(next.wechat);
  validateStickerSettings(next.wechat.stickers);
  validateProactiveSettings(next.wechat.proactive);
  return next;
}
