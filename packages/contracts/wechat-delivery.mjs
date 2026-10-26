export const MAX_WECHAT_DELIVERIES = 12;

// Split on Unicode code points: preserve the complete answer and never split a
// surrogate pair or exceed the transport's byte limit with Chinese text.
export function splitWechatReply(text, limit = 16000) {
  if (typeof text !== 'string' || !text.trim() || text.includes('\0') || Buffer.byteLength(text) > 1024 * 1024) throw Error('微信回复正文无效或超过上限。');
  const chunks = []; let chunk = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
