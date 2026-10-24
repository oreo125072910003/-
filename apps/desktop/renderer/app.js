const icons = {
  spark: '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6L20 2Z"/>',
  home: '<rect x="3" y="3" width="7" height="7" rx="1.7"/><rect x="14" y="3" width="7" height="7" rx="1.7"/><rect x="3" y="14" width="7" height="7" rx="1.7"/><rect x="14" y="14" width="7" height="7" rx="1.7"/>',
  tasks: '<rect x="5" y="4" width="15" height="17" rx="2"/><path d="M9 4V2m7 2V2M8 10l1.5 1.5L12 9m2 1h3m-9 6 1.5 1.5L12 15m2 1h3"/>',
  grid: '<path d="m12 3 8.5 4.5V17L12 21l-8.5-4V7.5L12 3Z"/><path d="m3.5 7.5 8.5 5 8.5-5M12 12.5V21M7.5 5.4l9 5"/>',
  settings: '<path d="m9.2 3-.6 2.3-2 .9-2.2-.6-2.1 3.6L4 11v2l-1.7 1.8 2.1 3.6 2.2-.6 2 .9.6 2.3h4l.6-2.3 2-.9 2.2.6 2.1-3.6L18.5 13v-2l1.7-1.8-2.1-3.6-2.2.6-2-.9-.6-2.3h-4Z"/><circle cx="11.2" cy="12" r="3.1"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  attach: '<path d="m20 11-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-9.5A8.5 8.5 0 0 1 10.5 4h2a8.5 8.5 0 0 1 8.5 7.5Z"/><path d="M7 11h10m-10 4h6"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  leaf: '<path d="M20 3c-9-1-16 3-16 10a7 7 0 0 0 7 7c7 0 10-8 9-17Z"/><path d="M3 21 15 9m-5 5v-4m0 4h4"/>',
  engine: '<path d="M9 3h6m-3 0v4m-7 3V7h14v10H5v-3H2v-4h3Zm14 0h3v7h-3M9 10h6"/><path d="m10 13 2 2 3-4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  external: '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 8a7.5 7.5 0 0 1 12.4-3L20 8M4 16l2.4 3A7.5 7.5 0 0 0 18.8 16"/>',
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const api = window.assistant;
const state = { page: 'home', bootstrap: null, settings: {}, tasks: [], filter: 'all', attachments: [], kind: 'agent', prompt: '', sending: false, loading: true, error: '', selectedTask: null, detail: null, detailLoading: false, detailError: '', settingsDirty: false };
const activeStatuses = new Set(['queued', 'running', 'validating', 'waiting_dependency']);
const statusLabels = { queued: '等待开始', running: '正在处理', validating: '检查成果', succeeded: '已完成', failed: '需要处理', cancelled: '已取消', interrupted: '运行中断', waiting_dependency: '等待依赖' };
const statusStyles = { queued: 'neutral', running: '', validating: '', succeeded: '', failed: 'error', cancelled: 'neutral', interrupted: 'offline', waiting_dependency: 'offline' };
const pageTitles = { home: '工作台', tasks: '任务记录', capabilities: '能力中心', settings: '助手设置' };
let toastTimer;
let refreshTimer;
let refreshPromise;
let detailGeneration = 0;
let lastFocus;
const app = document.querySelector('#app');

function pill(label, style = '') { return `<span class="status-pill ${style}"><span class="dot"></span>${escape(label)}</span>`; }
function taskPill(status) { return pill(statusLabels[status] || '状态未知', statusStyles[status] ?? 'neutral'); }
function runtimeState() {
  const runtime = state.bootstrap?.runtime;
  if (!runtime) return { label: state.loading ? '正在连接' : '服务未连接', style: 'neutral', description: state.loading ? '正在获取小助手的运行状态。' : '桌面服务尚未连接，可以尝试重新连接。' };
  if (runtime.available && state.settings.runtimeCredentialConfigured === false && !runtime.credentialsConfigured) return { label: '等待账号配置', style: 'offline', description: '已找到运行引擎。填写账号密钥后，才可以开始 AI 工作。' };
  if (runtime.available && (state.settings.runtimeCredentialConfigured || runtime.credentialsConfigured)) return { label: '账户已配置，待验证', style: 'offline', description: '账户已配置。完成一次真实 AI 任务后，才能验证模型连接。' };
  if (runtime.available) return { label: '引擎已发现', style: 'offline', description: runtime.detail || '运行程序已发现，任务执行时将检查账号与连接。' };
  return { label: '引擎待配置', style: 'offline', description: runtime.detail || '先配置 Harness 引擎。现在也可以整理本地资料。' };
}
function formatTime(value, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '时间未记录';
  if (full) return date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
function fileSize(size) {
  if (!Number.isFinite(Number(size))) return '文件';
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}
function notify(message, error = false) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, error ? 6500 : 3500);
}
async function invoke(method, ...args) {
  if (!api || typeof api[method] !== 'function') throw new Error('桌面服务还没有连接，请通过小助手桌面程序打开。');
  return api[method](...args);
}
function renderShell() {
  const name = state.settings.assistantName || state.bootstrap?.identity?.name || '小助手';
  const runtime = runtimeState();
  const nav = [['home', 'home', '工作台'], ['tasks', 'tasks', '任务记录'], ['capabilities', 'grid', '能力中心'], ['settings', 'settings', '助手设置']];
  app.innerHTML = `<div class="app-shell">
    <aside class="sidebar" aria-label="主导航">
      <div class="brand"><div class="brand-symbol">${icon('spark')}</div><div class="brand-name">${escape(name)}</div></div>
      <div class="brand-caption">YOUR PERSONAL SOUL</div>
      <div class="nav-label">陪伴 · 连接 · 完成</div>
      <nav class="nav">${nav.map(([id, image, title]) => `<button class="nav-button ${state.page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" aria-label="${title}" ${state.page === id ? 'aria-current="page"' : ''}>${icon(image)}<span>${title}</span>${id === 'tasks' && state.tasks.length ? `<span class="count">${state.tasks.length}</span>` : ''}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="sidebar-note">${icon('leaf')}<strong>每一次托付，都认真对待</strong><p>从一件小事开始，<br>慢慢成为懂你的助手。</p></div>
      <div class="sidebar-profile"><div class="avatar">你</div><div><strong>我的私人空间</strong><span>在这台电脑，陪你做事</span></div></div></div>
    </aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb">${icon('home')}<span>我的空间</span><span>/</span><strong>${pageTitles[state.page]}</strong></div><div class="topbar-right"><time>${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time><span id="global-status">${pill(runtime.label, runtime.style)}</span></div></header><main id="main" class="page-content view-enter" tabindex="-1"></main></div>
  </div><div id="drawer-root"></div>`;
  renderPage();
}
function errorBanner() { return state.error ? `<div class="load-error" role="alert"><span>${escape(state.error)}</span><button class="text-button" data-action="refresh">${icon('refresh')}重新连接</button></div>` : ''; }
function renderPage() {
  const main = document.querySelector('#main');
  if (!main) return;
  main.classList.remove('view-enter');
  main.innerHTML = errorBanner() + ({ home: renderHome, tasks: renderTasksPage, capabilities: renderCapabilities, settings: renderSettings }[state.page] || renderHome)();
  requestAnimationFrame(() => main.classList.add('view-enter'));
  if (state.page === 'home') {
    const textarea = document.querySelector('#task-prompt');
    textarea.value = state.prompt;
    renderAttachments();
  }
}
function renderHome() {
  const name = state.settings.assistantName || state.bootstrap?.identity?.name || '小助手';
  const greeting = new Date().getHours() < 6 ? '夜深了，慢慢来' : new Date().getHours() < 12 ? '早上好，新的一天' : new Date().getHours() < 18 ? '下午好，欢迎回来' : '晚上好，欢迎回来';
  return `<div class="content-grid"><section class="main-column" aria-label="与助手一起工作"><div class="eyebrow">${greeting}</div>
    <div class="hero"><div><h1 class="hero-title">把事情交给我，<br>让想法<em>一点点实现。</em></h1><p class="hero-subtitle">我是${escape(name)}。可以陪你梳理思路、起草文字，<br>也可以先从整理一份资料开始。</p></div><div class="soul-scene" aria-hidden="true"><div class="soul-ring"></div><div class="soul-ring second"></div><div class="soul-orb"></div><div class="orbit-dot"></div>${icon('spark', 'orbit-star')}<div class="orbit-small"></div></div></div>
    <form class="composer" id="task-form"><div class="composer-top"><label class="composer-label" for="task-prompt">${icon('spark')}今天，需要我帮你做什么？</label><span class="composer-mode" id="composer-mode">${state.kind === 'organize' ? '本地资料整理 · 无需 AI' : 'AI 对话与写作'}</span></div><textarea id="task-prompt" name="prompt" maxlength="18000" placeholder="说说你想完成的事情，也可以添加相关资料…" aria-describedby="submit-hint" ${state.sending ? 'disabled' : ''}></textarea><div id="attachments" class="attachment-list"></div><div class="composer-footer"><div class="compose-tools"><button class="icon-button" type="button" data-action="attach" aria-label="添加资料" title="添加资料">${icon('attach')}</button><span class="hint" id="submit-hint">Ctrl + Enter 发送</span></div><button class="primary-button" id="send-button" type="submit" ${state.sending ? 'disabled' : ''}>${state.sending ? '正在创建…' : state.kind === 'organize' ? '开始整理' : '交给小助手'}${icon('arrow')}</button></div></form>
    <div class="quick-actions"><button class="quick-action" data-action="quick" data-kind="organize"><span class="quick-icon">${icon('folder')}</span><span><strong>整理资料</strong><small>生成真实文件清单</small></span></button><button class="quick-action" data-action="quick" data-kind="draft"><span class="quick-icon gold">${icon('doc')}</span><span><strong>起草一份文字</strong><small>把零散想法写清楚</small></span></button><button class="quick-action" data-action="quick" data-kind="chat"><span class="quick-icon blue">${icon('chat')}</span><span><strong>一起理清思路</strong><small>从一个问题开始</small></span></button></div>
    <div class="section-heading"><h2>最近的工作<span class="small-count" id="recent-count">${state.tasks.length}</span></h2><button class="text-button" data-action="navigate" data-page="tasks">查看全部${icon('chevron')}</button></div><div id="recent-tasks">${renderTaskList(state.tasks.slice(0, 4), 'home')}</div>
    <div class="footer-line"><span>${icon('shield')}工作记录保存在这台电脑</span><span>一步一步，把事情做好。</span></div>
  </section><aside class="aside" aria-label="助手概况">${renderAside()}</aside></div>`;
}
function renderAside() {
  const runtime = runtimeState();
  const name = state.settings.assistantName || state.bootstrap?.identity?.name || '小助手';
  const available = state.bootstrap?.runtime?.available;
  const pending = state.tasks.filter((task) => activeStatuses.has(task.status)).length;
  return `<section class="aside-card"><div class="aside-title"><h2>此刻的我</h2>${icon('spark')}</div><div class="assistant-avatar"><div class="mini-orb" aria-hidden="true"></div><div><strong>${escape(name)}</strong><small>你的长期个人助手</small></div></div><div class="readiness-row"><span>本地工作台</span><span class="value ${state.bootstrap ? 'ready' : 'wait'}"><span class="dot"></span>${state.bootstrap ? '已连接' : '等待连接'}</span></div><div class="readiness-row"><span>AI 运行引擎</span><span class="value ${available ? 'ready' : 'wait'}">${available ? '已发现程序' : '等待配置'}</span></div><div class="readiness-row"><span>正在进行</span><span class="value">${pending ? `${pending} 项工作` : '等待你的安排'}</span></div><p class="aside-description">${escape(runtime.description)}</p><button class="text-button aside-link" data-action="navigate" data-page="settings">查看引擎与人格设置${icon('chevron')}</button></section>
  <section class="aside-card"><div class="aside-title"><h2>属于你的积累</h2>${icon('leaf')}</div><div class="overview-numbers"><div><strong>${state.tasks.length}</strong><small>件托付的工作</small></div><div><strong>${state.bootstrap?.summary?.artifactCount ?? 0}</strong><small>份真实成果</small></div></div><button class="workspace-link" data-action="open-workspace">${icon('folder')}打开工作文件夹${icon('external')}</button></section>
  <section class="aside-card note-card"><div class="eyebrow">${icon('leaf')}GROWING WITH YOU</div><p>先把一件事做好，<br>再学会更多本领。<br>我们一起慢慢成长。</p></section>`;
}
function renderTaskList(tasks, context = 'tasks') {
  if (state.loading) return '<div class="loading-block" role="status">正在读取工作记录…</div>';
  if (!tasks.length) return `<div class="empty-state"><div class="empty-icon">${icon(context === 'home' ? 'leaf' : 'tasks')}</div><strong>${context === 'home' ? '我们的第一件事，从这里开始' : state.tasks.length ? '这里暂时没有这类工作' : '还没有工作记录'}</strong><p>${context === 'home' ? '写下你的想法，或添加几份资料。完成的每一步，都会好好留在这里。' : '你交给小助手的工作、处理进度和最终成果，都会保存在这里。'}</p></div>`;
  return `<div class="task-list">${tasks.map((task) => `<button class="task-row" data-action="open-task" data-id="${escape(task.id)}"><span class="task-icon">${icon(task.kind === 'organize' ? 'folder' : 'doc')}</span><span class="task-body"><span class="task-title">${escape(task.title || task.prompt || '未命名工作')}</span><span class="task-meta"><span>${task.kind === 'organize' ? '资料整理' : 'AI 工作'}</span><span class="sep">·</span><span>${formatTime(task.createdAt)}</span>${task.attachmentNames?.length ? `<span class="sep">·</span><span>${task.attachmentNames.length} 份资料</span>` : ''}</span></span>${taskPill(task.status)}${icon('chevron', 'task-arrow')}</button>`).join('')}</div>`;
}
function renderTasksPage() {
  const filters = [['all', '全部工作'], ['active', '进行中'], ['succeeded', '已完成'], ['attention', '待处理']];
  const tasks = state.tasks.filter((task) => state.filter === 'all' || (state.filter === 'active' && activeStatuses.has(task.status)) || (state.filter === 'succeeded' && task.status === 'succeeded') || (state.filter === 'attention' && ['failed', 'interrupted'].includes(task.status)));
  return `<div class="page-heading"><div><div class="eyebrow">YOUR WORK, WELL KEPT</div><h1>每件事，都有下文。</h1><p>查看进度、回顾处理过程，或打开小助手交给你的成果。</p></div><button class="secondary-button" data-action="navigate" data-page="home">${icon('spark')}开始新工作</button></div><div class="filters" role="group" aria-label="筛选任务">${filters.map(([id, label]) => `<button class="filter-button ${state.filter === id ? 'active' : ''}" data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')}</div><div id="all-tasks">${renderTaskList(tasks)}</div>`;
}
function capabilityInfo(capability) {
  const status = capability.status;
  if (status === 'configured') return { label: '账户已配置，待任务验证', style: 'offline' };
  if (status === 'needs_account') return { label: '等待账号配置', style: 'offline' };
  const available = ['available', 'ready', 'connected', 'active', 'enabled'].includes(status);
  const label = available ? '可以使用' : ['partial', 'limited'].includes(status) ? '部分可用' : ['not_configured', 'unconfigured', 'needs_config', 'needs_configuration'].includes(status) ? '等待配置' : ['planned', 'not_implemented', 'coming_soon'].includes(status) ? '规划中' : '尚未接通';
  return { label, style: available ? '' : ['partial', 'limited'].includes(status) ? 'offline' : 'neutral' };
}
function capabilityIcon(id = '') {
  if (/mail/i.test(id)) return 'mail';
  if (/wechat|onebot|chat/i.test(id)) return 'chat';
  if (/skill|agent|worker/i.test(id)) return 'spark';
  if (/runtime|harness/i.test(id)) return 'engine';
  if (/search|literature/i.test(id)) return 'search';
  if (/contract|document/i.test(id)) return 'doc';
  if (/file|organize/i.test(id)) return 'folder';
  return 'grid';
}
function renderCapabilities() {
  const capabilities = Array.isArray(state.bootstrap?.capabilities) ? state.bootstrap.capabilities : [];
  return `<div class="page-heading"><div><div class="eyebrow">A LITTLE MORE CAPABLE, EVERY DAY</div><h1>让本领，慢慢生长。</h1><p>能做什么、还缺什么，在这里清楚地告诉你。</p></div></div>${capabilities.length ? `<div class="capability-grid">${capabilities.map((capability) => { const info = capabilityInfo(capability); return `<article class="capability-card"><div class="capability-top"><span class="capability-icon">${icon(capabilityIcon(capability.id))}</span>${pill(info.label, info.style)}</div><h2>${escape(capability.name || capability.title || capability.id)}</h2><p>${escape(capability.description || '能力说明暂未提供。')}</p>${capability.id === 'contract' && capability.status === 'available' ? `<button class="secondary-button" data-action="open-contract">${icon('external')}打开合同工具</button>` : ''}${capability.detail ? `<div class="capability-detail">${escape(capability.detail)}</div>` : ''}</article>`; }).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">${icon('grid')}</div><strong>${state.loading ? '正在读取能力状态' : '还没有读取到能力清单'}</strong><p>能力的接入和可用状态，以本机实际运行情况为准。</p></div>`}<div class="info-note">${icon('info')}<span>插件连接具体工具，Skill 提供做事方法。微信、邮箱和专业工作能力会逐项接入；只有完成实际连接的能力，才会显示为可以使用。</span></div>`;
}
function renderSettings() {
  const settings = state.settings;
  const runtime = state.bootstrap?.runtime || {};
  const health = runtimeState();
  return `<div class="page-heading"><div><div class="eyebrow">MAKE HER YOUR OWN</div><h1>一直是，懂你的她。</h1><p>给她一个名字，告诉她你喜欢的相处方式，再连接思考与工作的引擎。</p></div></div><form id="settings-form"><div class="settings-layout"><section class="settings-card"><h2>${icon('heart')}身份与人格</h2><p>这些设置会用于后续 AI 工作，让不同任务里的小助手保持同样的身份。</p><label class="field"><span>她的名字</span><input name="assistantName" value="${escape(settings.assistantName || state.bootstrap?.identity?.name || '小助手')}" maxlength="30" required autocomplete="off"/><small>你可以继续叫她小助手，也可以取一个亲切的名字。</small></label><label class="field"><span>你希望她怎样陪你做事</span><textarea name="persona" maxlength="6000" placeholder="例如：温暖、直接、细心。遇到问题先尝试解决，工作结果要有依据。">${escape(settings.persona || state.bootstrap?.identity?.persona || '')}</textarea><small>写下语气、习惯和工作偏好。它不会替代任务里的具体要求。</small></label></section><section class="settings-card"><h2>${icon('engine')}连接 Harness 引擎</h2><p>Harness 为小助手提供 AI 运行能力。找到运行程序、配置账号，并成功执行一次任务后，才能确认引擎可用。</p><label class="field"><span>运行程序</span><input name="runtimeCommand" value="${escape(settings.runtimeCommand || runtime.command || '')}" placeholder="自动发现，或填写 dsh 程序的完整路径" autocomplete="off" spellcheck="false"/><small>检测到程序 ≠ 账号已经就绪。支持程序路径，不填写额外命令参数。</small></label><label class="field"><span>运行配置</span><input name="runtimeProfile" value="sdk" readonly aria-readonly="true"/></label><label class="field"><span>小助手的独立引擎目录</span><input name="runtimeHome" value="${escape(settings.runtimeHome || '')}" placeholder="使用小助手的默认独立目录" autocomplete="off" spellcheck="false"/><small>小助手使用自己的运行配置和工作记录。</small></label><label class="field"><span>模型 API 地址（Messages 兼容）</span><input name="runtimeBaseUrl" value="${escape(settings.runtimeBaseUrl || 'https://api.deepseek.com/anthropic')}" type="url" placeholder="https://api.deepseek.com/anthropic" autocomplete="off" spellcheck="false"/></label><label class="field"><span>模型服务密钥</span><input name="runtimeApiKey" type="password" value="" placeholder="${settings.runtimeCredentialConfigured ? '已保存密钥；留空保持现有设置' : '填写你的模型 API 密钥'}" autocomplete="new-password" spellcheck="false"/><small>${settings.runtimeCredentialConfigured ? '已保存的密钥不会显示在界面中。' : '填写后交由桌面程序安全保存，界面不会回显已有密钥。'}</small></label>${settings.runtimeCredentialConfigured ? '<button type="button" class="text-button" data-action="clear-key">清除保存的密钥</button>' : ''}<div class="engine-details">${pill(health.label, health.style)}<div>${escape(runtime.detail || health.description)}</div>${runtime.version ? `<div>检测版本：<strong>${escape(runtime.version)}</strong></div>` : ''}<button type="button" class="text-button" data-action="detect-engine">${icon('refresh')}重新检测</button></div></section></div><div class="settings-footer"><p>设置保存在这台电脑。人格和引擎变更会用于下一次工作。</p><button class="primary-button" id="save-settings" type="submit">${icon('check')}保存设置</button></div></form>`;
}
function renderAttachments() {
  const container = document.querySelector('#attachments');
  if (!container) return;
  container.innerHTML = state.attachments.map((file, index) => `<span class="attachment-chip">${icon('doc')}<span title="${escape(file.name)}">${escape(file.name)}</span><button type="button" data-action="remove-attachment" data-index="${index}" aria-label="移除${escape(file.name)}">${icon('close')}</button></span>`).join('');
}
function updateComposer() {
  const textarea = document.querySelector('#task-prompt');
  if (textarea) textarea.value = state.prompt;
  const mode = document.querySelector('#composer-mode');
  if (mode) mode.textContent = state.kind === 'organize' ? '本地资料整理 · 无需 AI' : 'AI 对话与写作';
  const button = document.querySelector('#send-button');
  if (button) {
    button.disabled = state.sending;
    button.innerHTML = (state.sending ? '正在创建…' : state.kind === 'organize' ? '开始整理' : '交给小助手') + icon('arrow');
  }
}
async function refresh({ initial = false, preserveForm = true } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const results = await Promise.allSettled([invoke('getBootstrap'), invoke('listTasks'), invoke('getSettings')]);
    const errors = [];
    if (results[0].status === 'fulfilled') state.bootstrap = results[0].value;
    else errors.push(results[0].reason?.message || '无法连接桌面服务。');
    if (results[1].status === 'fulfilled') state.tasks = Array.isArray(results[1].value) ? [...results[1].value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];
    else errors.push(results[1].reason?.message || '无法读取工作记录。');
    if (results[2].status === 'fulfilled') state.settings = results[2].value || {};
    else errors.push(results[2].reason?.message || '无法读取助手设置。');
    state.loading = false;
    state.error = [...new Set(errors)].join(' ');
    if (initial || !preserveForm) renderShell();
    else updateVisibleData();
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
function updateVisibleData() {
  const main = document.querySelector('#main');
  const error = main?.querySelector('.load-error');
  if (state.error) {
    if (error) error.outerHTML = errorBanner();
    else main?.insertAdjacentHTML('afterbegin', errorBanner());
  } else error?.remove();
  const runtime = runtimeState();
  const status = document.querySelector('#global-status');
  if (status) status.innerHTML = pill(runtime.label, runtime.style);
  const recent = document.querySelector('#recent-tasks');
  if (recent) recent.innerHTML = renderTaskList(state.tasks.slice(0, 4), 'home');
  const count = document.querySelector('#recent-count');
  if (count) count.textContent = state.tasks.length;
  const aside = document.querySelector('.aside');
  if (aside) aside.innerHTML = renderAside();
  const nav = document.querySelector('[data-page="tasks"].nav-button');
  if (nav) {
    const old = nav.querySelector('.count');
    if (old) old.remove();
    if (state.tasks.length) nav.insertAdjacentHTML('beforeend', `<span class="count">${state.tasks.length}</span>`);
  }
  if (state.page === 'tasks' || state.page === 'capabilities') renderPage();
  if (state.selectedTask) loadTask(state.selectedTask, false);
}
function navigate(page) {
  if (!Object.hasOwn(pageTitles, page)) return;
  state.page = page;
  state.settingsDirty = false;
  renderShell();
  document.querySelector('#main')?.focus({ preventScroll: true });
}
async function addAttachments() {
  try {
    const files = await invoke('pickAttachments');
    if (!Array.isArray(files)) return;
    for (const file of files) if (file.path && !state.attachments.some((item) => item.path === file.path)) state.attachments.push(file);
    renderAttachments();
  } catch (error) { notify(error.message || '没有添加成功，请再试一次。', true); }
}
async function createTask(event) {
  event.preventDefault();
  if (state.sending) return;
  state.prompt = document.querySelector('#task-prompt')?.value || state.prompt;
  if (!state.prompt.trim() && !state.attachments.length) { document.querySelector('#task-prompt')?.focus(); notify('先写下你想做的事，或添加资料。'); return; }
  if (state.kind === 'organize' && !state.attachments.length) { notify('添加需要整理的文件后，就可以生成资料清单。'); await addAttachments(); if (!state.attachments.length) return; }
  state.sending = true;
  updateComposer();
  const textarea = document.querySelector('#task-prompt');
  if (textarea) textarea.disabled = true;
  try {
    const task = await invoke('createTask', { prompt: state.prompt.trim() || '请整理所选资料，生成清晰的文件清单。', attachmentPaths: state.attachments.map((file) => file.path), kind: state.kind });
    if (!task?.id) throw new Error('桌面服务没有返回任务记录，请查看任务列表。');
    state.prompt = '';
    state.attachments = [];
    state.kind = 'agent';
    await refresh();
    updateComposer();
    renderAttachments();
    await openTask(task.id);
  } catch (error) { notify(error.message || '工作没有创建成功，请再试一次。', true); }
  finally { state.sending = false; updateComposer(); const field = document.querySelector('#task-prompt'); if (field) field.disabled = false; }
}
async function loadTask(id, initial = true) {
  const generation = ++detailGeneration;
  if (initial) { state.detailLoading = true; state.detailError = ''; renderDrawer(); }
  try {
    const detail = await invoke('getTask', id);
    if (state.selectedTask !== id || generation !== detailGeneration) return;
    if (!detail?.task) throw new Error('没有找到这项工作的记录。');
    state.detail = detail;
    state.detailError = '';
  } catch (error) { if (state.selectedTask === id && generation === detailGeneration) state.detailError = error.message || '无法读取工作详情。'; }
  finally { if (state.selectedTask === id && generation === detailGeneration) { state.detailLoading = false; renderDrawer(); } }
}
async function openTask(id) {
  lastFocus = document.activeElement;
  state.selectedTask = id;
  state.detail = null;
  await loadTask(id);
  document.querySelector('#close-drawer')?.focus();
}
function closeTask() {
  state.selectedTask = null;
  state.detail = null;
  detailGeneration++;
  document.querySelector('#drawer-root').innerHTML = '';
  document.body.style.overflow = '';
  lastFocus?.focus?.();
}
function renderDrawer() {
  const root = document.querySelector('#drawer-root');
  if (!root || !state.selectedTask) return;
  const oldScroll = root.querySelector('.drawer-content')?.scrollTop || 0;
  const focusId = root.contains(document.activeElement) ? document.activeElement.id : '';
  const task = state.detail?.task;
  const events = Array.isArray(state.detail?.events) ? state.detail.events : [];
  const artifacts = Array.isArray(state.detail?.artifacts) ? state.detail.artifacts : [];
  const progress = task && typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : null;
  root.innerHTML = `<div class="drawer-backdrop" data-action="close-task"></div><section class="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-detail-title"><header class="drawer-header"><span>${icon('tasks')} 工作详情</span><button class="icon-button" id="close-drawer" data-action="close-task" aria-label="关闭工作详情">${icon('close')}</button></header><div class="drawer-content">${state.detailLoading ? '<div class="loading-block" id="task-detail-title">正在读取工作详情…</div>' : state.detailError ? `<div class="task-error" id="task-detail-title">${escape(state.detailError)}</div><button class="secondary-button" data-action="retry-detail">重新读取</button>` : task ? `${taskPill(task.status)}<h2 class="drawer-heading" id="task-detail-title">${escape(task.title || '未命名工作')}</h2><p class="drawer-subtitle">${task.kind === 'organize' ? '本地资料整理' : 'AI 工作'} · ${formatTime(task.createdAt, true)}${task.attachmentNames?.length ? ` · ${task.attachmentNames.length} 份资料` : ''}</p>${activeStatuses.has(task.status) ? `<progress class="task-progress" max="100" ${progress === null ? '' : `value="${progress}"`} aria-label="任务进度"></progress><div class="progress-label"><span>${escape(typeof task.progress === 'string' ? task.progress : statusLabels[task.status] || '处理中')}</span>${progress === null ? '' : `<span>${progress}%</span>`}</div>` : ''}<section class="drawer-section"><h3>${icon('chat')}你的托付</h3><div class="task-prompt">${escape(task.prompt || '整理所选资料。')}</div></section>${task.summary ? `<section class="drawer-section"><h3>${icon('spark')}小助手的反馈</h3><div class="task-summary">${escape(task.summary)}</div></section>` : ''}${task.error ? `<section class="drawer-section"><h3>需要处理的情况</h3><div class="task-error">${escape(task.error)}</div>${task.status === 'waiting_dependency' || /harness|引擎|密钥|api|credential|运行程序/i.test(task.error) ? '<button class="text-button" data-action="task-settings">前往引擎设置</button>' : ''}</section>` : ''}<section class="drawer-section"><h3>${icon('doc')}交给你的成果${artifacts.length ? ` · ${artifacts.length}` : ''}</h3>${artifacts.length ? `<div class="artifact-list">${artifacts.map((artifact) => `<button class="artifact-button" data-action="open-artifact" data-id="${escape(artifact.id)}">${icon('doc')}<span><strong>${escape(artifact.name)}</strong><small>${escape(artifact.type || '文件')} · ${fileSize(artifact.size)}</small></span>${icon('external')}</button>`).join('')}</div>` : `<p class="muted-text">${activeStatuses.has(task.status) ? '小助手生成成果后，会保存在这里。' : '这项工作还没有生成可打开的文件。'}</p>`}</section><section class="drawer-section"><h3>${icon('clock')}处理过程</h3>${events.length ? `<ol class="event-list">${events.map((event) => `<li class="event-item"><p>${escape(event.message || event.type || '状态更新')}</p><time>${formatTime(event.createdAt, true)}</time></li>`).join('')}</ol>` : '<p class="muted-text">暂无处理记录。</p>'}</section>` : ''}</div><footer class="drawer-footer"><button class="secondary-button" data-action="task-workspace">${icon('folder')}打开工作目录</button>${task && activeStatuses.has(task.status) ? '<button class="danger-button" data-action="cancel-task">停止这项工作</button>' : ''}</footer></section>`;
  const content = root.querySelector('.drawer-content');
  if (content) content.scrollTop = oldScroll;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  document.body.style.overflow = 'hidden';
}
async function saveSettings(event) {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const patch = Object.fromEntries(['assistantName', 'persona', 'runtimeCommand', 'runtimeProfile', 'runtimeHome', 'runtimeBaseUrl'].map((key) => [key, String(data.get(key) || '').trim()]));
  const key = String(data.get('runtimeApiKey') || '').trim();
  if (key) patch.runtimeApiKey = key;
  const button = document.querySelector('#save-settings');
  button.disabled = true;
  button.textContent = '正在保存…';
  try { await invoke('saveSettings', patch); state.settingsDirty = false; await refresh({ preserveForm: false }); notify('设置已保存。下一次工作会使用新的设置。'); }
  catch (error) { notify(error.message || '设置没有保存成功。', true); }
  finally { if (button.isConnected) { button.disabled = false; button.innerHTML = icon('check') + '保存设置'; } }
}

document.addEventListener('input', (event) => {
  if (event.target.id === 'task-prompt') state.prompt = event.target.value;
  if (event.target.closest('#settings-form')) state.settingsDirty = true;
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'task-form') createTask(event);
  if (event.target.id === 'settings-form') saveSettings(event);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.selectedTask) closeTask();
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target.id === 'task-prompt') { event.preventDefault(); document.querySelector('#task-form')?.requestSubmit(); }
  if (event.key === 'Tab' && state.selectedTask) {
    const focusable = [...document.querySelectorAll('.task-drawer button:not(:disabled), .task-drawer a, .task-drawer input')];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === 'navigate') navigate(button.dataset.page);
    else if (action === 'refresh') { await refresh({ preserveForm: false }); if (!state.error) notify('已经重新连接。'); }
    else if (action === 'filter') { state.filter = button.dataset.filter; renderPage(); }
    else if (action === 'attach') await addAttachments();
    else if (action === 'remove-attachment') { state.attachments.splice(Number(button.dataset.index), 1); renderAttachments(); }
    else if (action === 'quick') {
      state.kind = button.dataset.kind === 'organize' ? 'organize' : 'agent';
      if (button.dataset.kind === 'organize') { state.prompt = '请整理我添加的资料，生成一份清晰的文件清单。'; updateComposer(); if (!state.attachments.length) await addAttachments(); }
      else { state.prompt = button.dataset.kind === 'draft' ? '请帮我起草一份文字。我的用途是：\n\n需要表达的内容：\n\n' : '我想和你一起梳理这个问题：\n\n'; updateComposer(); }
      document.querySelector('#task-prompt')?.focus();
    }
    else if (action === 'open-task') await openTask(button.dataset.id);
    else if (action === 'close-task') closeTask();
    else if (action === 'retry-detail') await loadTask(state.selectedTask);
    else if (action === 'open-workspace') await invoke('openWorkspace');
    else if (action === 'task-workspace') await invoke('openWorkspace', state.selectedTask);
    else if (action === 'open-artifact') await invoke('openArtifact', button.dataset.id);
    else if (action === 'open-contract') { button.disabled = true; await invoke('openContract'); button.disabled = false; }
    else if (action === 'task-settings') { closeTask(); navigate('settings'); }
    else if (action === 'cancel-task') { button.disabled = true; await invoke('cancelTask', state.selectedTask); await refresh(); }
    else if (action === 'detect-engine') { button.disabled = true; await refresh(); const health = runtimeState(); notify(health.description); button.disabled = false; }
    else if (action === 'clear-key') { button.disabled = true; await invoke('saveSettings', { clearRuntimeApiKey: true }); state.settingsDirty = false; await refresh({ preserveForm: false }); notify('已清除保存的密钥。'); }
  } catch (error) { button.disabled = false; notify(error.message || '没有完成这一步，请再试一次。', true); }
});

renderShell();
refresh({ initial: true });
if (api && typeof api.onChange === 'function') {
  api.onChange(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh(), 180); });
}
