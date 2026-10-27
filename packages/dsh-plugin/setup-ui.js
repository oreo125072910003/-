const api = window.assistant;
const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'portable-setup-trigger'; trigger.textContent = '新电脑 · 连接微信'; trigger.hidden = true;
const dialog = document.createElement('dialog'); dialog.className = 'portable-setup-dialog';
dialog.innerHTML = '<header><h2>连接这台电脑的微信</h2><button type="button" class="portable-close" aria-label="关闭微信准备">×</button></header><p>完整版已带上专用微信与读取组件。账号登录由你在微信窗口完成。</p><ol><li><button type="button" data-setup="prepare">准备专用微信</button><span>校验组件，生成这台电脑的新连接配置</span></li><li><button type="button" data-setup="open">打开微信</button><span>请登录并等待聊天同步，保持一个微信客户端</span></li><li><button type="button" data-setup="discover">识别已登录账号</button><span>同步完成后识别；未发现时可再次点击</span></li></ol><label class="portable-account-label">选择账号<select aria-label="选择微信账号"><option value="">请先识别账号</option></select></label><p class="portable-login-help">点击验证后，若提示等待密钥，请在专用微信中退出账号再登录。验证成功后，到微信页选择允许回复的聊天并开启自动回复。</p><p class="portable-setup-status" role="status" aria-live="polite"></p><footer><button type="button" data-setup="bind">验证并连接</button></footer>';
document.body.append(trigger, dialog);
let current, busy = false, timer, stopped = false;
const status = dialog.querySelector('[role="status"]'), select = dialog.querySelector('select');
function render(value) {
  current = value; trigger.hidden = !value.available || value.connectionImported;
  const active = value.job?.state === 'running';
  status.textContent = value.job?.message || '从第一步开始。已有连接会继续沿用，不会替换。';
  for (const button of dialog.querySelectorAll('[data-setup]')) button.disabled = active || busy;
  dialog.querySelector('[data-setup="open"]').disabled ||= !value.prepared;
  dialog.querySelector('[data-setup="discover"]').disabled ||= !value.prepared;
  dialog.querySelector('[data-setup="bind"]').disabled ||= !select.value;
  const selected = select.value;
  select.replaceChildren();
  if (!value.accounts.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '请先识别账号'; select.append(option); }
  for (const account of value.accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name + (account.ready ? '' : '（等待同步）'); option.disabled = !account.ready; select.append(option); }
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  dialog.querySelector('[data-setup="bind"]').disabled = active || busy || !select.value;
  if (value.connectionImported && dialog.open && value.job?.state !== 'running') status.textContent = value.job?.message || '连接已经导入，请到微信页继续操作。';
}
async function refresh() {
  try { render(await api.getPortableWechatState()); } catch (error) { status.textContent = error.message; }
  if (!stopped) timer = setTimeout(refresh, dialog.open ? 1000 : 5000);
}
trigger.addEventListener('click', () => { dialog.showModal(); clearTimeout(timer); void refresh(); });
dialog.querySelector('.portable-close').addEventListener('click', () => dialog.close());
select.addEventListener('change', () => { if (current) render(current); });
dialog.addEventListener('click', async event => {
  const action = event.target.closest('[data-setup]')?.dataset.setup; if (!action || busy) return;
  busy = true;
  try {
    const method = { prepare: 'preparePortableWechat', open: 'openPortableWechat', discover: 'discoverPortableWechat', bind: 'bindPortableWechat' }[action];
    const value = await api[method](...(action === 'bind' ? [{ accountId: select.value }] : [])); render(value);
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; clearTimeout(timer); if (!stopped) timer = setTimeout(refresh, 300); }
});
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); }, { once: true });
void refresh();
