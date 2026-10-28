const fault = (code, message) => Object.assign(new Error(message), { code });

function services(ctx) {
  const llm = ctx.get?.('llm') ?? ctx.llm;
  const attachments = ctx.get?.('attachments') ?? ctx.attachments;
  if (typeof llm?.resolveModelInfo !== 'function' ||
      typeof attachments?.saveImages !== 'function' && typeof attachments?.saveImage !== 'function') {
    throw fault('HOST_IMAGES_UNSUPPORTED', '当前 Harness 尚未提供原生图片服务。');
  }
  return { llm, attachments };
}

async function bounded(work, { signal: parent, timeoutMs }) {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(fault('IMAGE_PREPARATION_TIMEOUT', 'Harness 图片准备超时，本轮未提交。')), timeoutMs);
  let rejectAbort;
  const cancelled = new Promise((_resolve, reject) => { rejectAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

/** Metadata resolution uses the already logged-in Harness adapter; no inference. */
export async function supportsNativeImages(ctx, provider, model, { signal, timeoutMs = 5000 } = {}) {
  try {
    const { llm } = services(ctx);
    return await bounded(async nativeSignal => {
      const info = await llm.resolveModelInfo(provider, model, nativeSignal);
      nativeSignal.throwIfAborted();
      return info?.inputModalities?.includes('image') === true;
    }, { signal, timeoutMs });
  } catch { return false; }
}

/** Inputs have passed the shared byte-level contract before entering this function. */
export async function prepareNativeImageBlocks(ctx, images, provider, model, { signal, timeoutMs = 25000 } = {}) {
  if (!images.length) return [];
  const { llm, attachments } = services(ctx);
  try {
    return await bounded(async nativeSignal => {
      const info = await llm.resolveModelInfo(provider, model, nativeSignal);
      nativeSignal.throwIfAborted();
      if (!info?.inputModalities?.includes('image')) throw fault('HOST_IMAGES_UNSUPPORTED', '当前 Harness 模型不支持图片输入。');
      const inputs = images.map(image => ({ data: Buffer.from(image.b64, 'base64'), mediaType: image.mime, ...(image.name ? { name: image.name } : {}) }));
      let references;
      if (typeof attachments.saveImages === 'function') references = await attachments.saveImages(inputs);
      else {
        references = [];
        for (const input of inputs) {
          nativeSignal.throwIfAborted();
          references.push(await attachments.saveImage(input));
        }
      }
      nativeSignal.throwIfAborted();
      if (!Array.isArray(references) || references.length !== images.length || references.some(ref =>
        !ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId || '') ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType) ||
        ![ref.bytes, ref.width, ref.height].every(value => Number.isSafeInteger(value) && value > 0))) {
        throw fault('IMAGE_ATTACHMENT_INVALID', 'Harness 未返回有效的原生图片引用。');
      }
      // Native normalization may resize/re-encode. Its attachment digest is not
      // required to equal the verified source-byte digest in the HTTP contract.
      return references.map(attachment => ({ type: 'image', attachment }));
    }, { signal, timeoutMs });
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code === 'HOST_IMAGES_UNSUPPORTED' || /^IMAGE_[A-Z_]+$/.test(error?.code || '')) throw error;
    throw fault('IMAGE_PREPARATION_FAILED', 'Harness 无法准备本轮图片，本轮未提交。');
  }
}

/** Capture immutable native event coordinates rather than scanning session history. */
export function nativeImageTarget(event, taskId) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'xiaozhushou-desktop-host' || event.data.source.taskId !== taskId) return null;
  const indexes = [];
  for (const block of event.data.content || []) if (block.type === 'image') indexes.push(indexes.length);
  if (!indexes.length) return null;
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw fault('IMAGE_SESSION_EVENT_INVALID', 'Harness 图片会话事件缺少可核对的位置。');
  return { seq: event.seq, imageIndexes: indexes };
}

export function nativeToolImageTarget(event) {
  if(event?.type!=='tool/result')return null;
  const images=event.data?.message?.content?.filter(block=>block.type==='image')??[];
  if(!images.length)return null;
  if(!Number.isSafeInteger(event.seq)||event.seq<0)throw fault('IMAGE_SESSION_EVENT_INVALID','截图结果缺少原生会话位置。');
  return {seq:event.seq,imageIndexes:images.map((_,index)=>index)};
}

/** Only this task's admitted image blocks are removed from future model history. */
export function offloadNativeImages(session, targets) {
  if (!targets.length) return;
  const nodes = session?.surface?.nodes;
  if (typeof session?.append !== 'function' || typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function' || !Array.isArray(nodes)) {
    throw fault('IMAGE_OFFLOAD_FAILED', 'Harness 图片卸载服务不可用。');
  }
  const visible = new Set(nodes), remaining = [];
  for (const target of targets) {
    // Native compaction may already have removed this exact message from the
    // model surface, or projected an offloaded image during a provider retry.
    if (!visible.has(target.seq)) continue;
    const event = session.eventAt(target.seq);
    const message = ['user/message','tool/result'].includes(event?.type) ? session.deriveEventMessage(event) : null;
    if (!Array.isArray(message?.content)) throw fault('IMAGE_OFFLOAD_FAILED', 'Harness 图片投影未通过核对。');
    const images = message.content.filter(block => block.type === 'image');
    if (target.imageIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= images.length)) throw fault('IMAGE_OFFLOAD_FAILED', 'Harness 图片位置未通过核对。');
    const imageIndexes = target.imageIndexes.filter(index => !images[index].offloaded);
    if (imageIndexes.length) remaining.push({ seq: target.seq, imageIndexes });
  }
  if (remaining.length) session.append('image/offload', { targets: remaining });
}
