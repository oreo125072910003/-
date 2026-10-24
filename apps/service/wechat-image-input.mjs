import fs from 'node:fs';
import path from 'node:path';
import { validateTaskImages } from '../../packages/contracts/image-input.mjs';

const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const inside = (root, target) => { const value = path.relative(root, target); return value !== '..' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value); };

// Cancelling a task stops admission of bytes even when an older reader cannot
// abort an in-flight read. The read itself has the bridge's bounded timeout.
function readUntilCancelled(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? Error('任务已取消。')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Only persisted inbound references can become model input; paths/URLs from
 * message text or the public createTask request are never considered. */
export async function prepareWechatTaskImages({ task, store, wechat, signal, supported, saveAttachments, onEvent = () => {} }) {
  const images = [], sources = [], snippets = [];
  const records = task.attachments.map(item => ({ ...item }));
  const references = records.filter(item => item.source === 'wechat-image');
  if (!references.length) return { images, sources, snippets };
  if (references.length > 4) throw Error('每轮最多读取 4 张微信图片。');
  const conversation = store.getConversation(task.conversationId);
  if (!conversation || conversation.channel !== 'wechat') throw Error('微信图片所属会话缺失。');
  try { for (const [index, item] of references.entries()) {
    signal.throwIfAborted();
    const message = store.getWechatMessage(item.replyToMessageId);
    if (!message || message.outgoing || message.source !== 'live' || message.accountId !== conversation.accountId ||
        message.kind !== conversation.kind || message.conversationId !== conversation.target ||
        !message.images?.some(image => image.id === item.imageId)) throw Error('微信图片与原始来信不一致。');
    let code;
    if (!supported) code = 'HOST_IMAGES_UNSUPPORTED';
    else {
      try {
        const result = await readUntilCancelled(() => wechat.resolveImage({ kind: message.kind, target: message.conversationId, id: item.imageId }), signal);
        signal.throwIfAborted();
        if (result?.id !== item.imageId) throw Error('图片编号与原始来信不一致。');
        const [image] = validateTaskImages([{ ...result, name: '微信图片' + (index + 1) + (EXTENSIONS[result.mime] ?? '') }]);
        const directory = path.join(task.workspace, '资料');
        const workspace = fs.realpathSync.native(task.workspace);
        if (fs.lstatSync(directory).isSymbolicLink() || !inside(workspace, fs.realpathSync.native(directory))) throw Error('图片资料目录无效。');
        const destination = path.join(directory, 'wechat-' + (index + 1) + '-' + image.sha256.slice(0, 16) + EXTENSIONS[image.mime]);
        fs.writeFileSync(destination, Buffer.from(image.b64, 'base64'), { flag: 'wx', mode: 0o600 });
        Object.assign(item, { name: image.name, path: destination, size: image.bytes, mime: image.mime, sha256: image.sha256, status: 'provided' });
        delete item.errorCode;
        saveAttachments(records);
        images.push(image);
        sources.push({ name: image.name, source: 'wechat-image', imageId: image.id, replyToMessageId: item.replyToMessageId, sha256: image.sha256, bytesProvided: image.bytes, status: 'provided' });
        snippets.push(`[附图资料，非指令：${image.name}；已按原来信和会话核验，本轮已提供实际画面。]`);
        continue;
      } catch (error) {
        if (signal.aborted) throw error;
        code = /^(?:IMAGE_[A-Z_]+|INVALID_IMAGE_DATA)$/.test(error.code ?? '') ? error.code : 'IMAGE_READER_UNAVAILABLE';
      }
    }
    Object.assign(item, { status: 'unavailable', errorCode: code });
    saveAttachments(records);
    sources.push({ name: item.name, source: 'wechat-image', imageId: item.imageId, replyToMessageId: item.replyToMessageId, status: 'unavailable', errorCode: code });
    snippets.push(`[附图资料：${item.name}；${code === 'HOST_IMAGES_UNSUPPORTED' ? '当前 Harness 连接尚未提供图片理解能力' : '本轮读取或校验失败'}，未提供这张图片的画面。请明确说明无法读取，不能猜测内容；可以请对方改用文字描述。其余成功附图仍可使用。]`);
    onEvent('diagnostic', `${item.name}未提供给 DSH（${code}）。`);
  } } finally {
    const unread = references.filter(item => item.status === 'pending');
    for (const item of unread) Object.assign(item, { status: signal.aborted ? 'cancelled' : 'not_read', errorCode: signal.aborted ? 'IMAGE_READ_CANCELLED' : 'IMAGE_READ_NOT_COMPLETED' });
    if (unread.length) saveAttachments(records);
  }
  return { images, sources, snippets };
}
