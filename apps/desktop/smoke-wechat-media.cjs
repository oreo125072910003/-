// All media staging and sending below are synthetic. No real message is sent.
const fs = require('node:fs');
const path = require('node:path');

exports.verifyWechatMediaUI = async function verifyWechatMediaUI({ window, service, waitFor, artifactsDir, syntheticOnly = false }) {
  if (syntheticOnly !== true) throw Error('微信附件界面验收仅允许使用合成环境。');
  const evaluate = source => window.webContents.executeJavaScript(`{${source}\n}`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 220));
  const changed = () => window.webContents.send('assistant:change');
  const original = Object.fromEntries(['getWechatState', 'grantWechatAttachments', 'stageWechatAttachment', 'sendWechatAttachment'].map(name => [name, service[name]]));
  const base = await original.getWechatState();
  const granted = new Set(), staged = new Map(), outbox = [], submitted = [];
  const contacts = [{ kind: 'private', id: '7700001', name: '合成材料收件人', allowed: true }, { kind: 'group', id: '7700002', name: '合成协作群', allowed: true }];
  service.getWechatState = () => ({ ...base, settings: { ...base.settings, allowedPrivate: ['7700001'], allowedGroups: ['7700002'] }, connection: { ...base.connection, state: 'ready' }, allowedContacts: contacts, sessions: contacts, messages: [], outbox: structuredClone(outbox) });
  service.grantWechatAttachments = paths => { for (const filename of paths) granted.add(filename); };
  service.stageWechatAttachment = async value => {
    if (!granted.has(value.path) || !['image', 'file'].includes(value.mediaType)) throw Error('合成附件未经过文件选择入口。');
    const attachment = { id: `wechatattachment_ui_${staged.size + 1}`, name: value.mediaType === 'image' ? '合成图片.png' : '合成验收材料.pdf', size: value.mediaType === 'image' ? 1024 : 2048, mediaType: value.mediaType };
    staged.set(attachment.id, attachment);
    return structuredClone(attachment);
  };
  service.sendWechatAttachment = async value => {
    if (Object.keys(value).some(key => !['kind', 'target', 'attachmentId', 'requestId'].includes(key)) || value.kind !== 'private' || value.target !== '7700001' || !value.requestId) throw Error('附件目标或提交字段不正确。');
    const previous = outbox.find(item => item.requestId === value.requestId);
    if (previous) return structuredClone(previous);
    const attachment = staged.get(value.attachmentId);
    if (!attachment) throw Error('没有找到已选择的合成附件。');
    submitted.push(value);
    const delivery = { ...attachment, id: `wechatdelivery_ui_${submitted.length}`, attachmentId: attachment.id, requestId: value.requestId, kind: value.kind, target: value.target, status: 'sending', createdAt: new Date().toISOString() };
    outbox.push(delivery); changed(); await pause();
    const attempt = submitted.filter(item => item.attachmentId === attachment.id).length;
    delivery.status = attachment.mediaType === 'file' ? attempt === 1 ? 'rejected' : 'delivered' : 'unconfirmed';
    if (delivery.status === 'rejected') { delivery.attempted = false; delivery.error = '合成拒绝：请先打开目标微信聊天后再发送。'; }
    if (delivery.status === 'unconfirmed') delivery.error = '合成回执：请在微信中核对，程序不会自动重发。';
    changed(); return structuredClone(delivery);
  };
  const snapshot = async name => {
    await evaluate(`document.querySelector('#toast').className='toast'; document.querySelector('.wechat-attachments')?.scrollIntoView({block:'center'})`);
    await pause();
    fs.writeFileSync(path.join(artifactsDir, name), (await window.webContents.capturePage()).toPNG());
  };
  const pick = async mediaType => {
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="wechat-attachment-pick"][data-media-type="${mediaType}"]:not(:disabled)'))`), '附件选择按钮未就绪');
    await evaluate(`document.querySelector('[data-action="wechat-attachment-pick"][data-media-type="${mediaType}"]').click()`);
    await waitFor(() => [...staged.values()].some(item => item.mediaType === mediaType), '未通过文件选择接口添加附件');
    const item = [...staged.values()].find(attachment => attachment.mediaType === mediaType);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-attachment-id="${item.id}"] [data-action="wechat-attachment-send"]:not(:disabled)'))`), '待发送附件未展示');
    return item;
  };
  try {
    changed();
    await evaluate(`document.querySelector('[data-action="close-task"]')?.click(); document.querySelector('[data-page="wechat"]').click(); document.querySelector('[data-action="wechat-tab"][data-tab="inbox"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="wechat-conversation"][data-key="private:7700001"]'))`), '合成媒体会话未显示');
    await evaluate(`document.querySelector('[data-action="wechat-conversation"][data-key="private:7700001"]').click()`);
    const file = await pick('file'), picture = await pick('image');
    if (submitted.length) throw Error('选择附件时自动发送了消息。');
    const selection = await evaluate(`({text:document.querySelector('.wechat-attachments')?.textContent,paths:document.querySelectorAll('.wechat-attachments input').length,manual:document.querySelector('#wechat-reply-form [type="submit"]')?.textContent})`);
    if (!selection.text.includes('合成验收材料.pdf') || !selection.text.includes('2.0 KB') || !selection.text.includes('1.0 KB') || selection.paths || !selection.manual.includes('发送文字')) throw Error('附件分类、大小或文字入口显示错误。');
    await snapshot('desktop-wechat-media-selected.png');

    await evaluate(`document.querySelector('[data-action="wechat-conversation"][data-key="group:7700002"]').click()`);
    if (await evaluate(`document.querySelectorAll('.wechat-selected-attachment').length`)) throw Error('附件串到了其他聊天。');
    await evaluate(`document.querySelector('[data-action="wechat-conversation"][data-key="private:7700001"]').click(); document.querySelector('[data-action="wechat-attachment-send"][data-id="${file.id}"]').click(); document.querySelector('[data-action="wechat-attachment-send"][data-id="${file.id}"]')?.click()`);
    await waitFor(() => outbox.find(item => item.attachmentId === file.id)?.status === 'rejected', '合成文件预提交拒绝未保留');
    await waitFor(() => evaluate(`document.querySelector('[data-attachment-id="${file.id}"]')?.dataset.status === 'rejected' && document.querySelector('[data-attachment-id="${file.id}"] [data-action="wechat-attachment-send"]')?.textContent === '重新发送' && !document.querySelector('[data-attachment-id="${file.id}"] [data-action="wechat-attachment-send"]')?.disabled`), '确认未发送时没有显示显式重发按钮');
    const rejection = await evaluate(`document.querySelector('[data-attachment-id="${file.id}"]')?.textContent`);
    if (!rejection.includes('未发送') || !rejection.includes('请先打开目标微信聊天') || !rejection.includes('本次未提交给微信')) throw Error('未发送状态或修正原因未清楚显示');
    await snapshot('desktop-wechat-media-rejected.png');
    if (submitted.length !== 1) throw Error('预提交拒绝被自动重试或双击重复提交');
    await evaluate(`document.querySelector('[data-action="wechat-attachment-send"][data-id="${file.id}"]').click(); document.querySelector('[data-action="wechat-attachment-send"][data-id="${file.id}"]')?.click()`);
    await waitFor(() => outbox.filter(item => item.attachmentId === file.id).at(-1)?.status === 'delivered', '显式重发没有取得新的文件回执');
    await waitFor(() => evaluate(`document.querySelector('[data-attachment-id="${file.id}"]')?.dataset.status === 'delivered' && document.querySelector('[data-attachment-id="${file.id}"] [data-action="wechat-attachment-send"]')?.disabled`), '文件已送达状态或防重按钮错误');
    if (submitted.length !== 2 || submitted[0].requestId === submitted[1].requestId) throw Error('显式重发未使用新编号或重复点击导致重复文件发送。');
    await evaluate(`document.querySelector('[data-action="wechat-attachment-send"][data-id="${file.id}"]').click()`);
    await pause();
    if (submitted.length !== 2) throw Error('已送达的文件被重复发送。');

    await evaluate(`document.querySelector('[data-action="wechat-attachment-send"][data-id="${picture.id}"]').click()`);
    await waitFor(() => outbox.find(item => item.attachmentId === picture.id)?.status === 'unconfirmed', '合成图片不确定回执未保留');
    await waitFor(() => evaluate(`document.querySelector('[data-attachment-id="${picture.id}"]')?.dataset.status === 'unconfirmed' && document.querySelector('[data-attachment-id="${picture.id}"] [data-action="wechat-attachment-send"]')?.disabled`), '不确定图片发送未锁定');
    await evaluate(`document.querySelector('[data-action="wechat-attachment-send"][data-id="${picture.id}"]').click()`);
    await pause();
    if (submitted.length !== 3 || new Set(submitted.map(item => item.requestId)).size !== 3) throw Error('不确定图片被重发或附件共用了防重编号。');
    const receipts = await evaluate(`document.querySelector('.message-thread')?.textContent`);
    if (!receipts.includes('合成验收材料.pdf') || !receipts.includes('合成图片.png') || !receipts.includes('已送达') || !receipts.includes('未发送') || !receipts.includes('结果待核对')) throw Error('会话中的附件回执记录不完整。');
    await snapshot('desktop-wechat-media-receipts.png');
    await evaluate(`document.querySelector('[data-action="wechat-attachment-remove"][data-id="${picture.id}"]').click()`);
    if (await evaluate(`Boolean(document.querySelector('[data-attachment-id="${picture.id}"]'))`)) throw Error('附件记录未能收起。');
    return { wechatMediaPickerUI: true, wechatMediaNoPathInput: true, wechatMediaSelectionNoSend: true, wechatMediaConversationIsolation: true, wechatMediaDuplicateBlocked: true, wechatMediaRejectedNoAutoRetry: true, wechatMediaRejectedExplicitRetry: true, wechatMediaDeliveredLocked: true, wechatMediaUnconfirmedLocked: true, wechatMediaOutboxShown: true, wechatMediaSyntheticSubmissions: submitted.length, wechatMediaRealSubmissions: 0 };
  } finally {
    Object.assign(service, original);
    changed();
  }
};
