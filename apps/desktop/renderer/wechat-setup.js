// Shared by the standalone desktop and the DSH panel. Only explicit clicks
// prepare components, launch WeChat or bind the selected account.
const api = window.assistant;
const methods = ['getPortableWechatState', 'preparePortableWechat', 'openPortableWechat', 'discoverPortableWechat', 'bindPortableWechat'];
const stateEvent = 'xiaozhushou:wechat-setup-state';
const openEvent = 'xiaozhushou:wechat-setup-open';

function publish(value) {
  window.dispatchEvent(new CustomEvent(stateEvent, { detail: {
    supported: value.supported !== false,
    available: typeof value.available === 'boolean' ? value.available : null,
    prepared: value.prepared === true,
    connectionImported: value.connectionImported === true,
    checkFailed: value.checkFailed === true,
  } }));
}

if (!methods.every(name => typeof api?.[name] === 'function')) {
  publish({ supported: false });
} else {
  initializeSetup();
}

function initializeSetup() {
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'portable-setup-trigger';
  trigger.textContent = '新电脑 · 连接微信'; trigger.hidden = true;
  const dialog = document.createElement('dialog');
  dialog.className = 'portable-setup-dialog'; dialog.setAttribute('aria-labelledby', 'wechat-setup-title');
  dialog.innerHTML = `<header><div><span class="portable-eyebrow">本机微信组件</span><h2 id="wechat-setup-title">准备并连接微信</h2></div><button type="button" class="portable-close" aria-label="关闭微信准备">×</button></header>
    <p class="portable-components">安装包内含专用微信 4.1.10.27、匹配的连接组件和本机读取环境。无需另找微信安装程序；账号登录由你在微信窗口完成。</p>
    <ol class="portable-steps">
      <li data-step="prepare"><span class="portable-step-number" aria-hidden="true">01</span><div><button type="button" data-setup="prepare">准备专用微信</button><p>核对包内组件，在小助手数据目录生成这台电脑的独立连接配置。</p></div></li>
      <li data-step="open"><span class="portable-step-number" aria-hidden="true">02</span><div><button type="button" data-setup="open">打开微信</button><p>在打开的专用微信里扫码或用手机确认登录，等待聊天同步。若另一版微信正在运行，请先从其托盘正常退出。</p></div></li>
      <li data-step="discover"><span class="portable-step-number" aria-hidden="true">03</span><div><button type="button" data-setup="discover">识别已登录账号</button><p>登录并同步后识别；暂未发现时，可以等一会再点一次。</p><label class="portable-account-label" for="portable-wechat-account">选择微信账号<select id="portable-wechat-account" aria-label="选择微信账号"><option value="">请先识别账号</option></select></label></div></li>
      <li data-step="bind"><span class="portable-step-number" aria-hidden="true">04</span><div><button type="button" data-setup="bind">验证并连接</button><p>若提示等待密钥，请在专用微信里退出账号再登录。验证后自行选择允许回复的聊天，再开启自动回复。</p></div></li>
    </ol>
    <p class="portable-setup-status" role="status" aria-live="polite"></p>
    <footer><span>已有微信连接会继续沿用。</span><button type="button" class="secondary-button" data-setup-close>关闭向导</button></footer>`;
  document.body.append(trigger, dialog);
  const status = dialog.querySelector('[role="status"]'), select = dialog.querySelector('select');
  let current, busy = false, timer, stopped = false, pendingRefresh, unsubscribe, localError = '';

  function render(value) {
    value ||= {};
    current = { ...value, connectionImported: value.connectionImported ?? current?.connectionImported ?? false };
    const accounts = Array.isArray(current.accounts) ? current.accounts : [];
    const active = current.job?.state === 'running', imported = current.connectionImported;
    trigger.hidden = current.available !== true || imported;
    dialog.dataset.state = current.job?.state || 'idle';
    status.textContent = localError || current.job?.message || (imported ? '已有微信连接，请到微信页继续使用原连接。' : current.prepared ? '专用微信组件已准备好，可以打开微信并登录。' : '按顺序完成四步。准备组件不会替你登录，也不会授权会话或发送消息。');
    const selected = select.value;
    select.replaceChildren();
    if (!accounts.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '请先识别账号'; select.append(option);
    }
    for (const account of accounts) {
      if (typeof account.id !== 'string') continue;
      const option = document.createElement('option'); option.value = account.id;
      option.textContent = String(account.name || '微信账号') + (account.ready ? '' : '（等待同步）');
      option.disabled = !account.ready; select.append(option);
    }
    if ([...select.options].some(option => option.value === selected && !option.disabled)) select.value = selected;
    else if (!accounts.some(account => account.ready)) select.value = '';
    select.disabled = active || busy || imported || !accounts.some(account => account.ready);
    for (const button of dialog.querySelectorAll('[data-setup]')) button.disabled = active || busy || imported || current.available !== true;
    dialog.querySelector('[data-setup="prepare"]').disabled ||= current.prepared === true;
    dialog.querySelector('[data-setup="open"]').disabled ||= !current.prepared;
    dialog.querySelector('[data-setup="discover"]').disabled ||= !current.prepared;
    dialog.querySelector('[data-setup="bind"]').disabled ||= !select.value;
    for (const step of dialog.querySelectorAll('[data-step]')) {
      step.toggleAttribute('data-active', active && step.dataset.step === current.job.kind);
      step.toggleAttribute('data-complete', step.dataset.step === 'prepare' && current.prepared || step.dataset.step === 'bind' && imported);
    }
    publish(current);
  }

  function schedule(delay = 1000) {
    clearTimeout(timer);
    if (!stopped && (dialog.open || current?.job?.state === 'running')) timer = setTimeout(() => void refresh(), delay);
  }

  async function refresh() {
    if (stopped || pendingRefresh) return pendingRefresh;
    pendingRefresh = Promise.resolve().then(() => api.getPortableWechatState()).then(value => {
      render(value || { available: false });
      return true;
    }, error => {
      status.textContent = error?.message || '暂时无法检查微信组件，请重新打开向导再试。';
      if (!current) {
        stopped = true; trigger.hidden = true;
        publish({ checkFailed: true });
      }
      return false;
    }).finally(() => { pendingRefresh = null; schedule(); });
    return pendingRefresh;
  }

  async function show() {
    if (stopped || current?.available !== true || current.connectionImported) return;
    if (!dialog.open) dialog.showModal();
    clearTimeout(timer); await refresh();
  }
  trigger.addEventListener('click', () => void show());
  window.addEventListener(openEvent, () => void show());
  dialog.querySelector('.portable-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-setup-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => schedule());
  select.addEventListener('change', () => { if (current) render(current); });
  dialog.addEventListener('click', async event => {
    const action = event.target.closest('[data-setup]')?.dataset.setup;
    if (!action || busy || current?.job?.state === 'running' || current?.connectionImported) return;
    const method = { prepare: 'preparePortableWechat', open: 'openPortableWechat', discover: 'discoverPortableWechat', bind: 'bindPortableWechat' }[action];
    if (!method) return;
    busy = true; localError = ''; render(current); clearTimeout(timer);
    try { render(await api[method](...(action === 'bind' ? [{ accountId: select.value }] : []))); }
    catch (error) { localError = error?.message || '这一步没有完成，请检查后重试。'; }
    finally { busy = false; render(current); schedule(300); }
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); unsubscribe?.(); }, { once: true });
  void refresh().then(ok => {
    if (ok && typeof api.onChange === 'function') unsubscribe = api.onChange(() => { if (!stopped && !busy) void refresh(); });
  });
}
