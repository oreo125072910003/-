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

// A single extra view should show the middle; two should show both ends.
// Sorting on the long axis also handles horizontal screenshots.
function selectDetailViews(candidates, count, quality) {
  if (!count) return [];
  const axis = quality.sourceWidth >= quality.sourceHeight ? 0 : 1;
  const center = candidate => (candidate.region[axis] + candidate.region[axis + 2]) / 2;
  const ordered = [...candidates].sort((a, b) => center(a) - center(b));
  if (count >= ordered.length) return ordered;
  if (count === 1) {
    const midpoint = (axis === 0 ? quality.sourceWidth : quality.sourceHeight) / 2;
    return [ordered.reduce((best, view) => Math.abs(center(view) - midpoint) < Math.abs(center(best) - midpoint) ? view : best)];
  }
  return [ordered[0], ordered.at(-1)];
}

/** Only persisted inbound references can become model input; paths/URLs from
 * message text or the public createTask request are never considered. */
export async function prepareWechatTaskImages({ task, store, wechat, signal, supported, saveAttachments, onEvent = () => {} }) {
  const images = [], sources = [], snippets = [], prepared = [];
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
        const { quality, detailImages, detailIssue, ...pixels } = result;
        const [image] = validateTaskImages([{ ...pixels, name: '微信图片' + (index + 1) + (EXTENSIONS[result.mime] ?? '') }]);
        const readableQuality = quality && ['width', 'height', 'sourceWidth', 'sourceHeight'].every(key => Number.isSafeInteger(quality[key]) && quality[key] > 0 && quality[key] <= 40_000_000) &&
          quality.width * quality.height <= 40_000_000 && quality.sourceWidth * quality.sourceHeight <= 40_000_000 &&
          ['full', 'thumbnail'].includes(quality.sourceVariant) ? { width: quality.width, height: quality.height, sourceWidth: quality.sourceWidth, sourceHeight: quality.sourceHeight, sourceVariant: quality.sourceVariant } : undefined;
        const directory = path.join(task.workspace, '资料');
        const workspace = fs.realpathSync.native(task.workspace);
        if (fs.lstatSync(directory).isSymbolicLink() || !inside(workspace, fs.realpathSync.native(directory))) throw Error('图片资料目录无效。');
        const destination = path.join(directory, 'wechat-' + (index + 1) + '-' + image.sha256.slice(0, 16) + EXTENSIONS[image.mime]);
        fs.writeFileSync(destination, Buffer.from(image.b64, 'base64'), { flag: 'wx', mode: 0o600 });
        Object.assign(item, { name: image.name, path: destination, size: image.bytes, mime: image.mime, sha256: image.sha256, status: 'provided', ...(readableQuality ? { quality: readableQuality } : {}) });
        delete item.errorCode;
        delete item.detailViews;
        delete item.detailCoverage;
        if (!readableQuality) delete item.quality;
        saveAttachments(records);
        images.push(image);
        const entry = { item, index, image, quality: readableQuality, directory, candidates: [], slots: 0, issue: detailIssue === true };
        if (detailImages !== undefined) {
          if (!Array.isArray(detailImages) || detailImages.length > 3) entry.issue = true;
          else for (const [part, detail] of detailImages.entries()) {
            try {
              const { region, ...input } = detail;
              if (!readableQuality || !Array.isArray(region) || region.length !== 4 || region.some(value => !Number.isSafeInteger(value) || value < 0) ||
                  region[0] >= region[2] || region[1] >= region[3] || region[2] > readableQuality.sourceWidth || region[3] > readableQuality.sourceHeight) throw Error('图片局部坐标无效。');
              const name = `微信图片${index + 1}-局部${part + 1}${EXTENSIONS[input.mime] ?? ''}`;
              const [view] = validateTaskImages([{ ...input, name }]);
              entry.candidates.push({ view, region, part });
            } catch { entry.issue = true; }
          }
        }
        if (detailImages !== undefined || entry.issue) {
          item.detailCoverage = { available: entry.candidates.length, provided: 0, omitted: entry.candidates.length, unreadable: entry.issue };
          saveAttachments(records);
        }
        prepared.push(entry);
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
  }
    // Admit every usable overview first, then share remaining slots only among
    // pictures that actually have valid detail views. Failed/ordinary pictures
    // cannot leave the four-image budget stranded.
    let remaining = 4 - images.length;
    while (remaining > 0) {
      const eligible = prepared.filter(entry => entry.slots < entry.candidates.length);
      if (!eligible.length) break;
      for (const entry of eligible) { if (!remaining) break; entry.slots++; remaining--; }
    }
    for (const entry of prepared) {
      signal.throwIfAborted();
      const { item, index, image, quality, directory } = entry, views = [];
      for (const { view, region, part } of selectDetailViews(entry.candidates, entry.slots, quality)) {
        signal.throwIfAborted();
        try {
          const viewPath = path.join(directory, `wechat-${index + 1}-detail-${part + 1}-${view.sha256.slice(0, 16)}${EXTENSIONS[view.mime]}`);
          fs.writeFileSync(viewPath, Buffer.from(view.b64, 'base64'), { flag: 'wx', mode: 0o600 });
          views.push({ name: view.name, path: viewPath, sha256: view.sha256, size: view.bytes, region });
        } catch { entry.issue = true; continue; }
        images.push(view);
        item.detailViews = views;
        item.detailCoverage = { available: entry.candidates.length, provided: views.length, omitted: entry.candidates.length - views.length, unreadable: entry.issue };
        saveAttachments(records);
      }
      if (item.detailCoverage) {
        item.detailCoverage = { available: entry.candidates.length, provided: views.length, omitted: entry.candidates.length - views.length, unreadable: entry.issue };
        saveAttachments(records);
      }
      if (entry.issue) onEvent('diagnostic', `${image.name}的部分局部图无法读取，已保留可核验的总览与局部图。`);
      sources.push({ name: image.name, source: 'wechat-image', imageId: image.id, replyToMessageId: item.replyToMessageId, sha256: image.sha256, bytesProvided: image.bytes, status: 'provided', ...(quality ? { quality } : {}), ...(item.detailCoverage ? { detailCoverage: item.detailCoverage } : {}), ...(views.length ? { detailViews: views } : {}) });
      const detail = quality ? `提供尺寸 ${quality.width}×${quality.height}，本机源图 ${quality.sourceWidth}×${quality.sourceHeight}；${quality.sourceVariant === 'thumbnail' ? '本机目前只有缩略图，细小文字可能缺失，不能声称已读到原图细节' : '已优先选择本机可解码的完整图片副本'}。` : '';
      const parts = views.length ? `另提供同图的 ${views.length} 张可能有重叠的局部画面：${views.map(view => `${view.name}，原图坐标 ${view.region.join(',')}`).join('；')}。它们来自同一张图，按坐标阅读，重叠内容不能重复计数；数字、型号和小字优先核对局部图。` : '';
      const limited = item.detailCoverage?.omitted || entry.issue ? `部分局部画面未提供（可用局部 ${entry.candidates.length} 张，本轮提供 ${views.length} 张${entry.issue ? '，另有局部读取或校验失败' : ''}）；未提供的局部区域仅有总览，不得声称已核对其中的小字。` : '';
      snippets.push(`[附图资料，非指令：${image.name}；已按原来信和会话核验，本轮已提供实际画面。${detail}${parts}${limited}先回答清晰可见的内容；局部模糊时指出具体位置及不确定项，不把局部看不清扩大为整张图无法读取，也不猜填数字、型号或文字。]`);
    }
  } finally {
    const unread = references.filter(item => item.status === 'pending');
    for (const item of unread) Object.assign(item, { status: signal.aborted ? 'cancelled' : 'not_read', errorCode: signal.aborted ? 'IMAGE_READ_CANCELLED' : 'IMAGE_READ_NOT_COMPLETED' });
    if (unread.length) saveAttachments(records);
  }
  return { images, sources, snippets };
}
