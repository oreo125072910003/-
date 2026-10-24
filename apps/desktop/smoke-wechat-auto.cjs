// Renderer checks against real persisted settings and synthetic status responses.
// The caller must provide the local smoke fixture; this helper never sends messages.
const fs = require('node:fs');
const path = require('node:path');

exports.verifyWechatAutoUI = async function verifyWechatAutoUI({ window, service, waitFor, artifactsDir, syntheticOnly = false }) {
  if (syntheticOnly !== true) throw Error('自动回复界面验收仅允许使用合成微信连接。');
  const evaluate = source => window.webContents.executeJavaScript(`{${source}\n}`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 220));
  const changed = () => window.webContents.send('assistant:change');
  const original = Object.fromEntries(['getWechatState', 'saveWechatSettings', 'getBootstrap'].map(name => [name, service[name]]));
  const initial = (await original.getWechatState()).settings;
  const saved = { autoReply: initial.autoReply === true, autoConnect: initial.autoConnect === true };
  const writes = [];
  let status = null, rejectSave = false;
  const snapshot = async name => {
    await evaluate(`document.querySelector('#toast').className='toast'`);
    await pause();
    fs.writeFileSync(path.join(artifactsDir, name), (await window.webContents.capturePage()).toPNG());
  };
  service.getBootstrap = async () => {
    const value = await original.getBootstrap();
    return { ...value, runtime: { ...value.runtime, source: 'existing-harness-host', credentialsSource: 'harness-existing-login', available: true, ready: false, modelVerified: false } };
  };
  service.getWechatState = async () => {
    const value = await original.getWechatState();
    return status ? { ...value, autoReply: { ...value.autoReply, ...status } } : value;
  };
  service.saveWechatSettings = async patch => {
    writes.push(patch);
    if (rejectSave) { rejectSave = false; throw Error('合成验收：设置未保存。'); }
    return original.saveWechatSettings(patch);
  };
  const checkbox = (id, checked) => evaluate(`Boolean(document.querySelector('#${id}') && document.querySelector('#${id}').checked === ${checked} && !document.querySelector('#${id}').disabled)`);
  const toggle = async (id, key, enabled) => {
    await waitFor(() => checkbox(id, !enabled), '自动回复设置开关未就绪');
    await evaluate(`document.querySelector('#${id}').click()`);
    await waitFor(async () => (await original.getWechatState()).settings[key] === enabled, '开关没有保存到实际微信设置');
    await waitFor(() => checkbox(id, enabled), '开关未显示实际保存结果');
  };
  try {
    await original.saveWechatSettings({ autoReply: false, autoConnect: false });
    changed();
    await evaluate(`document.querySelector('[data-action="close-task"]')?.click(); document.querySelector('[data-page="wechat"]').click()`);
    await toggle('wechat-auto-reply', 'autoReply', true);
    await toggle('wechat-auto-connect', 'autoConnect', true);
    if (writes.some(patch => Object.keys(patch).length !== 1 || !['autoReply', 'autoConnect'].includes(Object.keys(patch)[0]))) throw Error('自动回复开关覆盖了其他微信配置。');

    rejectSave = true;
    await evaluate(`document.querySelector('#wechat-auto-reply').click()`);
    await waitFor(() => evaluate(`document.querySelector('#toast')?.textContent.includes('设置未保存')`), '保存失败未显示原因');
    await waitFor(() => checkbox('wechat-auto-reply', true), '保存失败后开关没有恢复实际设置');
    if ((await original.getWechatState()).settings.autoReply !== true) throw Error('保存失败改变了实际开关状态。');

    const stages = [
      ['generating', '正在思考回复', '合成状态：DSH 正在处理新消息。'],
      ['sending', '正在发送回复', '合成状态：正在提交微信接口。'],
      ['unconfirmed', '发送结果待核对', '合成状态：回执不明，不会重复发送。'],
      ['error', '自动回复需要处理', '合成状态：DSH 服务暂时不可用。'],
      ['paused', '自动回复已暂停', '合成状态：微信连接已断开。'],
      ['idle', '等待新消息', '合成状态：只处理已选择聊天的新消息。'],
      ['closed', '自动回复已停止', '合成状态：回复服务已关闭。'],
      ['disabled', '自动回复已关闭', '合成状态：自动回复功能已关闭。'],
    ];
    for (const [state, label, detail] of stages) {
      status = { enabled: true, state, detail, lastError: state === 'error' ? '合成异常原因' : '', taskId: state === 'generating' ? 'smoke-auto-ui-task' : null };
      changed();
      await waitFor(() => evaluate(`document.querySelector('.wechat-auto-status')?.dataset.state === ${JSON.stringify(state)} && document.querySelector('.wechat-auto-status')?.textContent.includes(${JSON.stringify(label)}) && document.querySelector('.wechat-auto-status')?.textContent.includes(${JSON.stringify(detail)})`), '自动回复状态与服务结果不一致');
      if (state === 'generating') {
        const link = await evaluate(`document.querySelector('.wechat-auto-status [data-action="open-task"]')?.dataset.id`);
        if (link !== 'smoke-auto-ui-task') throw Error('自动回复任务入口没有使用服务返回的任务编号。');
        await snapshot('desktop-wechat-auto.png');
      }
      if (state === 'unconfirmed') await snapshot('desktop-wechat-auto-unconfirmed.png');
    }
    status = null;
    await toggle('wechat-auto-reply', 'autoReply', false);
    await toggle('wechat-auto-connect', 'autoConnect', false);
    const copy = await evaluate(`({help:document.querySelector('#wechat-automation-help')?.textContent,manual:document.querySelector('.reply-caption label')?.textContent,old:document.body.textContent.includes('回复仍由你点击发送')})`);
    if (!copy.help?.includes('新文字消息') || !copy.help.includes('历史消息不会补发') || copy.old || (copy.manual && !copy.manual.startsWith('手动写给'))) throw Error('自动回复范围或手动写信文案不正确。');
    return { wechatAutoSettingsUI: true, wechatAutoSettingsPersisted: true, wechatAutoPartialPatchOnly: true, wechatAutoSaveFailureRollback: true, wechatAutoControlsBeforeModelVerification: true, wechatAutoStatusStages: stages.map(stage => stage[0]), wechatAutoMessagesSentByHelper: 0 };
  } finally {
    Object.assign(service, original);
    await original.saveWechatSettings(saved);
    changed();
  }
};
