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
  image: '<rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
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
const state = { page: 'home', bootstrap: null, settings: {}, tasks: [], filter: 'all', attachments: [], kind: 'agent', prompt: '', sending: false, loading: true, error: '', selectedTask: null, detail: null, detailLoading: false, detailError: '', settingsDirty: false,
  wechat: null, wechatError: '', wechatTab: 'inbox', wechatConnectionExpanded: null, selectedMessageId: null, selectedConversationKey: '', wechatReply: '', wechatReplyByConversation: {}, wechatBusy: '', wechatSettingsDraft: null,
  wechatContactKind: 'private', wechatContactKeyword: '', wechatContactResults: { private: [], groups: [] }, wechatContactNames: {}, wechatAllowedDraft: null, wechatContactsSearched: false,
  wechatHistoryLoaded: {}, wechatImages: {}, wechatStickers: {}, wechatStickerPanel: false, wechatStickerQuery: '', wechatSendAttempts: {}, wechatAttachmentsByConversation: {}, wechatAccountKey: '',
  mail: null, mailError: '', mailTab: 'inbox', mailAccountId: '', mailMessageId: null, mailBusy: '', mailCompose: { accountId: '', to: '', cc: '', bcc: '', subject: '', text: '', inReplyTo: '' }, mailSavedDraft: null, mailAccountDraft: null, mailDraftTasks: {}, mailAttachment: null,
  extensions: null, extensionsError: '', capabilityTab: 'overview', nativeCatalogQuery: '', extensionsBusy: '', selectedMcpId: null, mcpDiagnostics: {}, mcpToolSelections: {}, skillIds: [], workflowId: 'single', workflows: null, workflowsError: '', exportingFormat: '', dshAccess: null, dshAccessError: '', dshGrantDraft: null, dshGrantsDirty: false, dshGrantQuery: '' };
const activeStatuses = new Set(['queued', 'running', 'validating', 'waiting_dependency']);
const statusLabels = { planned: '准备协作', queued: '等待开始', running: '正在处理', validating: '检查成果', succeeded: '已完成', failed: '需要处理', partial: '部分完成', cancelled: '已取消', interrupted: '运行中断', waiting_dependency: '等待依赖', skipped: '未执行', stop_unconfirmed: '停止待核对', deadline_exceeded: '执行超时' };
const statusStyles = { planned: 'neutral', queued: 'neutral', running: '', validating: '', succeeded: '', failed: 'error', partial: 'offline', cancelled: 'neutral', interrupted: 'offline', waiting_dependency: 'offline', skipped: 'neutral', stop_unconfirmed: 'error', deadline_exceeded: 'error' };
const pageTitles = { home: '工作台', tasks: '任务记录', workers: '协作帮手', wechat: '微信通信', mail: '邮箱通信', capabilities: '能力中心', settings: '控制面板' };
let toastTimer;
let refreshTimer;
let refreshPromise;
let detailGeneration = 0;
let lastFocus;
const app = document.querySelector('#app');

function pill(label, style = '') { return `<span class="status-pill ${style}"><span class="dot"></span>${escape(label)}</span>`; }
function taskPill(status) { return pill(statusLabels[status] || '状态未知', statusStyles[status] ?? 'neutral'); }
function hasSharedHarnessAccount() { const runtime = state.bootstrap?.runtime; return Boolean(runtime?.available && (runtime.source === 'existing-harness-host' || runtime.credentialsSource === 'harness-existing-login')); }
function runtimeState() {
  const runtime = state.bootstrap?.runtime;
  if (!runtime) return { label: state.loading ? '正在连接 DSH' : 'DSH 尚未连接', style: 'neutral', description: state.loading ? '正在连接小助手 DSH，读取现有 Harness 登录。' : '桌面服务尚未连接，可以尝试刷新。' };
  if (hasSharedHarnessAccount()) return runtime.ready || runtime.modelVerified ? { label: '小助手 DSH 已就绪', style: '', description: runtime.detail || '已沿用 Harness 现有登录，并完成过真实模型回复。' } : { label: '已沿用登录 · 待任务验证', style: 'offline', description: runtime.detail || '已连接现有 Harness，可直接提交工作；真实模型回复尚待任务验证。' };
  const detail = runtime.detail || '';
  const description = !detail || /ENOENT|ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND/i.test(detail) ? '尚未连接小助手宿主插件。启动已登录的 Harness 并启用小助手插件后重试；已有账户无需重新填写密钥。' : detail;
  return { label: 'DSH 宿主待连接', style: 'offline', description };
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
  const nav = [['home', 'home', '工作台', '发起工作'], ['tasks', 'tasks', '任务记录', '进度与成果'], ['workers', 'heart', '协作帮手', '流程与角色'], ['wechat', 'chat', '微信通信', '收信与回复'], ['mail', 'mail', '邮箱通信', '多账号邮件'], ['capabilities', 'grid', '能力中心', '工具与扩展'], ['settings', 'settings', '控制面板', '人格与引擎']];
  const navGroups = [['工作', ['home', 'tasks', 'workers']], ['通信', ['wechat', 'mail']], ['管理', ['capabilities', 'settings']]];
  const navButton = ([id, image, title, subtitle]) => `<button class="nav-button ${state.page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" aria-label="${title}" ${state.page === id ? 'aria-current="page"' : ''}><span class="nav-icon nav-icon-${id}">${icon(image)}</span><span class="nav-copy"><strong>${title}</strong><small>${subtitle}</small></span>${id === 'tasks' && state.tasks.length ? `<span class="count">${state.tasks.length}</span>` : ''}</button>`;
  app.innerHTML = `<a class="skip-link" href="#main">跳到主要内容</a><div class="desktop-frame">
    <header class="app-titlebar"><div class="app-brand"><span class="brand-symbol">${icon('spark')}</span><strong>${escape(name)}<span>DSH</span></strong><span class="app-edition">个人工作空间</span></div><nav class="app-commands" aria-label="快捷命令"><button data-action="navigate" data-page="home">${icon('doc')}新建工作</button><button data-action="open-workspace">${icon('folder')}工作文件夹</button><button data-action="refresh" aria-label="刷新工作空间" title="刷新工作空间">${icon('refresh')}</button></nav></header>
    <div class="app-shell"><aside class="sidebar" aria-label="主导航">${navGroups.map(([title, ids]) => `<section class="explorer-group nav-group"><h2>${title}</h2><nav class="nav" aria-label="${title}">${nav.filter(item => ids.includes(item[0])).map(navButton).join('')}</nav></section>`).join('')}
    <section class="explorer-group sidebar-system"><h2>本机状态</h2><div class="system-item">${icon('engine')}<span>小助手 DSH</span></div><div id="sidebar-runtime">${pill(runtime.label, runtime.style)}</div><p>任务与成果保存在这台电脑。</p><button class="text-button" data-action="navigate" data-page="settings">查看 DSH 连接</button></section><div class="sidebar-profile"><span class="avatar">${icon('heart')}</span><div><strong>${escape(name)}</strong><span>你的长期个人助手</span></div></div></aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb">${icon(nav.find(item => item[0] === state.page)?.[1] || 'home')}<span>我的小助手</span><span aria-hidden="true">/</span><strong>${pageTitles[state.page]}</strong></div><time>${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time></header><main id="main" class="page-content view-enter" tabindex="-1"></main></div></div>
    <footer class="app-statusbar"><span>${icon('shield')}资料保存在本机</span><span id="global-status">${pill(runtime.label, runtime.style)}</span><span class="app-version">v${escape(state.bootstrap?.appVersion || '预览版')}</span></footer>
  </div><div id="drawer-root"></div>`;
  renderPage();
}
function errorBanner() { return state.error ? `<div class="load-error" role="alert"><span>${escape(state.error)}</span><button class="text-button" data-action="refresh">${icon('refresh')}重新连接</button></div>` : ''; }
function renderPage() {
  const main = document.querySelector('#main');
  if (!main) return;
  main.classList.remove('view-enter');
  main.innerHTML = errorBanner() + ({ home: renderHome, tasks: renderTasksPage, workers: renderWorkers, wechat: renderWechat, mail: renderMail, capabilities: renderCapabilities, settings: renderSettings }[state.page] || renderHome)();
  requestAnimationFrame(() => main.classList.add('view-enter'));
  if (state.page === 'home') {
    const textarea = document.querySelector('#task-prompt');
    textarea.value = state.prompt;
    renderAttachments();
    updateComposer();
  }
}
function renderHome() {
  const name = state.settings.assistantName || state.bootstrap?.identity?.name || '小助手';
  const greeting = new Date().getHours() < 6 ? '夜深了，慢慢来' : new Date().getHours() < 12 ? '早上好，新的一天' : new Date().getHours() < 18 ? '下午好，欢迎回来' : '晚上好，欢迎回来';
  return `<div class="content-grid"><section class="main-column" aria-label="与助手一起工作"><div class="hero"><div><div class="eyebrow">${greeting}</div><h1 class="hero-title">今天，想一起做点什么？</h1><p class="hero-subtitle">告诉${escape(name)}你的目标，或添加几份资料。进度和成果都会留在这里。</p></div></div>
    <form class="composer" id="task-form"><div class="composer-top"><label class="composer-label" for="task-prompt">${icon('doc')}新建工作</label><span class="composer-mode" id="composer-mode">${state.kind === 'organize' ? '本地资料整理 · 无需 AI' : 'AI 对话与写作'}</span></div><div class="composer-body"><label class="field-label" for="task-prompt">请描述你想完成的事情：</label><textarea id="task-prompt" name="prompt" maxlength="18000" placeholder="例如：帮我梳理这份材料，再拟一份回复…" aria-describedby="submit-hint" ${state.sending ? 'disabled' : ''}></textarea><div class="attachment-format-hint">支持文字文件、Word（.docx）和可选中文字的 PDF；扫描件暂不能识别。</div><div id="attachments" class="attachment-list"></div><details class="work-options"><summary>工作选项与技能</summary><div class="task-type-field"><label for="task-type">工作类型</label><select id="task-type" name="taskType"><option value="agent" ${state.kind === 'agent' ? 'selected' : ''}>AI 对话与写作</option><option value="organize" ${state.kind === 'organize' ? 'selected' : ''}>本地资料整理</option><option value="literature" ${state.kind === 'literature' ? 'selected' : ''}>文献检索</option></select></div><div id="work-mode-slot">${renderWorkMode()}</div><div id="skill-picker-slot">${renderSkillPicker()}</div></details><div class="composer-footer"><div class="compose-tools"><button class="secondary-button" type="button" data-action="attach" aria-label="添加资料" title="添加资料">${icon('attach')}添加资料</button><span class="hint" id="submit-hint">Ctrl + Enter 提交</span></div><button class="primary-button" id="send-button" type="submit" ${state.sending ? 'disabled' : ''}>${state.sending ? '正在创建…' : state.kind === 'organize' ? '开始整理' : '交给小助手'}${icon('arrow')}</button></div></div></form>
    <div class="quick-actions"><button class="quick-action" data-action="quick" data-kind="organize"><span class="quick-icon">${icon('folder')}</span><span><strong>整理资料</strong><small>生成真实文件清单</small></span></button><button class="quick-action" data-action="quick" data-kind="draft"><span class="quick-icon gold">${icon('doc')}</span><span><strong>起草一份文字</strong><small>把零散想法写清楚</small></span></button><button class="quick-action" data-action="quick" data-kind="chat"><span class="quick-icon blue">${icon('chat')}</span><span><strong>一起理清思路</strong><small>从一个问题开始</small></span></button><button class="quick-action" data-action="quick" data-kind="literature"><span class="quick-icon blue">${icon('search')}</span><span><strong>查找学术文献</strong><small>检索真实论文信息</small></span></button></div>
    <div class="section-heading"><h2>最近的工作<span class="small-count" id="recent-count">${state.tasks.length}</span></h2><button class="text-button" data-action="navigate" data-page="tasks">查看全部${icon('chevron')}</button></div><div id="recent-tasks">${renderTaskList(state.tasks.slice(0, 4), 'home')}</div>
    <div class="footer-line"><span>${icon('shield')}任务、处理记录与成果都可回看</span><button class="text-button" data-action="open-workspace">打开工作文件夹</button></div>
  </section><aside class="aside" aria-label="助手概况">${renderAside()}</aside></div>`;
}
function renderAside() {
  const runtime = runtimeState();
  const name = state.settings.assistantName || state.bootstrap?.identity?.name || '小助手';
  const available = state.bootstrap?.runtime?.available;
  const pending = state.tasks.filter((task) => activeStatuses.has(task.status)).length;
  return `<section class="aside-card"><div class="aside-title"><h2>${icon('engine')}助手状态</h2></div><div class="aside-card-body"><div class="assistant-avatar"><span class="profile-icon">${icon('spark')}</span><div><strong>${escape(name)}</strong><small>你的长期个人助手</small></div></div><div class="readiness-row"><span>本地工作台</span><span class="value ${state.bootstrap ? 'ready' : 'wait'}"><span class="dot"></span>${state.bootstrap ? '已连接' : '等待连接'}</span></div><div class="readiness-row"><span>小助手 DSH</span><span class="value ${hasSharedHarnessAccount() ? 'ready' : 'wait'}">${hasSharedHarnessAccount() ? '已沿用登录' : '等待连接'}</span></div><div class="readiness-row"><span>当前任务</span><span class="value">${pending ? `${pending} 项待完成` : '暂无进行中任务'}</span></div><p class="aside-description">${escape(runtime.description)}</p><button class="text-button aside-link" data-action="navigate" data-page="settings">打开控制面板${icon('chevron')}</button></div></section>
  <section class="aside-card"><div class="aside-title"><h2>${icon('tasks')}工作统计</h2></div><div class="aside-card-body"><div class="overview-numbers"><div><strong>${state.tasks.length}</strong><small>项工作</small></div><div><strong>${state.bootstrap?.summary?.artifactCount ?? 0}</strong><small>份成果</small></div></div><button class="workspace-link" data-action="open-workspace">${icon('folder')}打开工作文件夹${icon('external')}</button></div></section>
  <section class="aside-card"><div class="aside-title"><h2>${icon('chat')}通信入口</h2></div><div class="aside-card-body"><p class="aside-description">在微信通信中选择聊天，开启小助手 DSH 自动回复，或随时自己写信。</p><button class="secondary-button" data-action="navigate" data-page="wechat">${icon('chat')}进入微信通信</button></div></section>`;
}
function renderTaskList(tasks, context = 'tasks') {
  if (state.loading) return '<div class="loading-block" role="status">正在读取工作记录…</div>';
  if (!tasks.length) return `<div class="empty-state"><div class="empty-icon">${icon(context === 'home' ? 'leaf' : 'tasks')}</div><strong>${context === 'home' ? '我们的第一件事，从这里开始' : state.tasks.length ? '这里暂时没有这类工作' : '还没有工作记录'}</strong><p>${context === 'home' ? '写下你的想法，或添加几份资料。完成的每一步，都会好好留在这里。' : '你交给小助手的工作、处理进度和最终成果，都会保存在这里。'}</p></div>`;
  return `<div class="task-list">${tasks.map((task) => `<button class="task-row" data-action="open-task" data-id="${escape(task.id)}"><span class="task-icon">${icon(task.kind === 'organize' ? 'folder' : 'doc')}</span><span class="task-body"><span class="task-title">${escape(task.title || task.prompt || '未命名工作')}</span><span class="task-meta"><span>${escape(taskTypeLabel(task))}</span><span class="sep">·</span><span>${formatTime(task.createdAt)}</span>${task.attachmentNames?.length ? `<span class="sep">·</span><span>${task.attachmentNames.length} 份资料</span>` : ''}</span></span>${taskPill(task.status)}${icon('chevron', 'task-arrow')}</button>`).join('')}</div>`;
}
function taskTypeLabel(task) {
  if (task.kind === 'organize') return '本地资料整理';
  if (task.kind === 'literature') return '文献检索';
  return task.workflowId && task.workflowId !== 'single' ? workflowInfo[task.workflowId]?.name || 'AI 协作' : 'AI 工作';
}
function renderTasksPage() {
  const filters = [['all', '全部工作'], ['active', '进行中'], ['succeeded', '已完成'], ['attention', '待处理']];
  const tasks = state.tasks.filter((task) => state.filter === 'all' || (state.filter === 'active' && activeStatuses.has(task.status)) || (state.filter === 'succeeded' && task.status === 'succeeded') || (state.filter === 'attention' && ['failed', 'partial', 'interrupted', 'waiting_dependency'].includes(task.status)));
  return `<div class="page-heading"><div><h1>${icon('tasks')}任务记录</h1><p>查看处理进度、工作过程和保存的成果。</p></div><button class="secondary-button" data-action="navigate" data-page="home">${icon('doc')}新建工作</button></div><div class="filters" role="group" aria-label="筛选任务">${filters.map(([id, label]) => `<button class="filter-button ${state.filter === id ? 'active' : ''}" data-action="filter" data-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join('')}</div><div id="all-tasks">${renderTaskList(tasks)}</div>`;
}
function capabilityInfo(capability) {
  const status = capability.status;
  if (status === 'configured') return capability.id === 'agent' ? runtimeState() : { label: '账户已配置，待任务验证', style: 'offline' };
  if (status === 'needs_account') return { label: '等待连接 DSH', style: 'offline' };
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
function renderCapabilityOverview() {
  const capabilities = Array.isArray(state.bootstrap?.capabilities) ? state.bootstrap.capabilities : [];
  const groups = [
    { title: '日常工作', description: '整理文件、分析材料和起草文字。', match: id => /organize|contract|document|^agent$|search|literature/i.test(id) },
    { title: '通信连接', description: '与外部消息、邮箱和联系人连接。', match: id => /wechat|mail|onebot|chat/i.test(id) },
    { title: '技能与扩展', description: '通过插件、Skill 与专业帮手增加本领。', match: () => true },
  ];
  const remaining = [...capabilities];
  const sections = groups.map(group => {
    const items = remaining.filter(item => group.match(item.id));
    for (const item of items) remaining.splice(remaining.indexOf(item), 1);
    if (!items.length) return '';
    return `<section class="capability-section"><div class="section-heading"><h2>${group.title}</h2><span class="section-help">${group.description}</span></div><div class="capability-grid">${items.map(capability => {
      const info = capabilityInfo(capability);
      return `<article class="capability-card"><div class="capability-top"><span class="capability-icon">${icon(capabilityIcon(capability.id))}</span>${pill(info.label, info.style)}</div><h3>${escape(capability.name || capability.title || capability.id)}</h3><p>${escape(capability.description || '能力说明暂未提供。')}</p>${capability.id === 'contract' && capability.status === 'available' ? `<button class="secondary-button" data-action="open-contract">${icon('external')}打开合同工具</button>` : capability.id === 'wechat' ? `<button class="secondary-button" data-action="navigate" data-page="wechat">${icon('chat')}打开微信通信</button>` : capability.id === 'mail' ? `<button class="secondary-button" data-action="navigate" data-page="mail">${icon('mail')}打开邮箱通信</button>` : capability.id === 'literature' ? `<button class="secondary-button" data-action="start-literature">${icon('search')}前往检索</button>` : capability.id === 'organize' ? `<button class="secondary-button" data-action="navigate" data-page="home">${icon('folder')}前往工作台</button>` : ''}${capability.detail ? `<div class="capability-detail">${escape(capability.detail)}</div>` : ''}</article>`;
    }).join('')}</div></section>`;
  }).join('');
  return `${capabilities.length ? sections : `<div class="empty-state"><div class="empty-icon">${icon('grid')}</div><strong>${state.loading ? '正在读取能力状态' : '还没有读取到能力清单'}</strong><p>能力的接入和可用状态，以本机实际运行情况为准。</p></div>`}<div class="info-note">${icon('info')}<span>插件负责连接工具，Skill 提供做事方法。显示为待接入的能力仍在开发中，连接状态以本机实际检测为准。</span></div>`;
}
const builtinSkillNames = { 'contract-drafting': '合同资料准备', 'file-organization': '文件整理', 'literature-review': '文献综述', 'literature-search': '文献检索', 'mail-triage': '邮件分类', 'material-writing': '材料写作', 'project-followup': '项目跟进', 'task-review': '成果检查' };
const capabilityNames = { 'agent.text': 'AI 文字任务', 'files.organize': '本地文件整理', 'contract.generate': '合同生成', 'literature.search': '文献检索接口', 'documents.write': '文档写入', 'mail.read': '邮件读取', 'projects.read': '项目读取', 'artifact.read': '成果读取' };
function skillName(skill) { return builtinSkillNames[skill.id] || skill.name || skill.id; }
function capabilityName(id) { return capabilityNames[id] || id; }
function usableTextSkills() { return (state.extensions?.skills || []).filter(skill => skill.enabled && skill.usable && (skill.executors || ['harness-text']).includes('harness-text')); }
function renderCapabilities() {
  const tabs = [['overview', 'grid', '能力总览'], ['mcp', 'engine', 'MCP 插件'], ['skills', 'spark', 'Skills 技能'], ['legacy', 'folder', '原有能力']];
  const installedMcp = state.extensions?.mcp?.length || 0;
  const installedSkills = state.extensions?.skills?.length || 0;
  return `<div class="page-heading"><div><h1>${icon('grid')}能力中心</h1><p>按工作类型查找工具，管理插件与工作方法。</p></div></div><div class="xp-tabs capability-tabs" role="tablist" aria-label="能力分类">${tabs.map(([id, image, title]) => `<button id="capability-tab-${id}" role="tab" aria-selected="${state.capabilityTab === id}" aria-controls="capability-panel" class="${state.capabilityTab === id ? 'active' : ''}" data-action="capability-tab" data-tab="${id}">${icon(image)}${title}${id === 'mcp' || id === 'skills' ? `<span class="tab-count">${id === 'mcp' ? installedMcp : installedSkills}</span>` : ''}</button>`).join('')}<button class="tab-refresh" data-action="extensions-refresh">${icon('refresh')}刷新</button></div><section id="capability-panel" class="tab-panel capability-panel" role="tabpanel" aria-labelledby="capability-tab-${state.capabilityTab}">${state.extensionsError && state.capabilityTab !== 'overview' ? `<div class="load-error" role="alert">${escape(state.extensionsError)}</div>` : ''}${state.capabilityTab === 'mcp' ? renderMcpManager() : state.capabilityTab === 'skills' ? renderSkillManager() : state.capabilityTab === 'legacy' ? renderLegacyManager() : renderCapabilityOverview()}</section>`;
}
function dshGrantSelection() {
  if (!state.dshGrantDraft) state.dshGrantDraft = { skills: [...(state.dshAccess?.saved?.skills || [])], tools: [...(state.dshAccess?.saved?.tools || [])] };
  return state.dshGrantDraft;
}
function renderDshAccessManager() {
  const access = state.dshAccess;
  const catalog = access?.catalog || {};
  const selection = dshGrantSelection();
  const query = state.dshGrantQuery.trim().toLocaleLowerCase();
  const matches = item => !query || `${item.name} ${item.description || ''}`.toLocaleLowerCase().includes(query);
  const tools = (catalog.tools || []).filter(matches);
  const skills = (catalog.skills || []).filter(matches);
  const busy = Boolean(state.extensionsBusy);
  const ready = access?.connected === true;
  const unavailable = [...(access?.unavailable?.skills || []).map(name=>({name,kind:'skills'})),...(access?.unavailable?.tools || []).map(name=>({name,kind:'tools'}))];
  const effective = access?.effective || {};
  const label = name => typeof name === 'string' ? name : name?.name || name?.id || '';
  return `<section class="dsh-access-section"><div class="section-heading"><h2>${icon('shield')}主人桌面任务授权</h2><button class="secondary-button" data-action="dsh-access-refresh" ${busy || typeof api?.refreshDshAccessCatalog !== 'function' ? 'disabled' : ''}>${icon('refresh')}${state.extensionsBusy === 'dsh-catalog' ? '正在读取…' : '读取可授权能力'}</button></div><div class="dsh-access-intro">${pill(ready ? 'DSH 授权目录已连接' : '等待连接 DSH', ready ? '' : 'offline')}<p>逐项勾选并保存后，小助手才可在你从本机发起的 DSH 任务中使用这些能力。微信来信和邮件正文不会继承主人的这份授权。</p></div>${state.dshAccessError ? `<div class="load-error">${escape(state.dshAccessError)}</div>` : ''}${access?.detail ? `<p class="field-help">${escape(access.detail)}</p>` : ''}<div class="dsh-access-summary"><span>已保存：技能 ${access?.saved?.skills?.length || 0} 项，工具 ${access?.saved?.tools?.length || 0} 项</span><span>当前有效：技能 ${effective.skills?.length || 0} 项，工具 ${effective.tools?.length || 0} 项</span></div>${ready ? `<form id="dsh-grants-search" class="wechat-contact-search"><label for="dsh-grants-keyword">${icon('search')}</label><input id="dsh-grants-keyword" name="query" value="${escape(state.dshGrantQuery)}" placeholder="查找需要授权的技能或工具"/><button class="secondary-button" type="submit">查找</button></form><form id="dsh-grants-form"><details class="legacy-catalog-group" open><summary>DSH 技能 <span>${skills.length}</span></summary><div class="dsh-grant-list">${skills.length ? skills.map(skill=>`<label class="dsh-grant-row"><input type="checkbox" data-dsh-kind="skills" value="${escape(skill.name)}" ${selection.skills.includes(skill.name) ? 'checked' : ''} ${busy ? 'disabled' : ''}/><span><strong>${escape(skill.name)}</strong><small>${escape(skill.description || '未提供说明。')}</small></span></label>`).join('') : '<p class="field-help">没有匹配的技能。</p>'}</div></details><details class="legacy-catalog-group" ${query ? 'open' : ''}><summary>DSH 工具 <span>${tools.length}</span></summary><div class="dsh-grant-list">${tools.length ? tools.map(tool=>`<${tool.grantable === true ? 'label' : 'div'} class="dsh-grant-row ${tool.grantable === true ? '' : 'unavailable'}">${tool.grantable === true ? `<input type="checkbox" data-dsh-kind="tools" value="${escape(tool.name)}" ${selection.tools.includes(tool.name) ? 'checked' : ''} ${busy ? 'disabled' : ''}/>` : icon('info')}<span><strong>${escape(tool.name)}</strong><small>${escape(tool.description || '未提供说明。')}</small>${tool.grantable === true ? '' : `<em>尚不能授权：${escape(tool.grantReason || tool.reason || '参数或执行接口仍需适配')}</em>`}</span></${tool.grantable === true ? 'label' : 'div'}>`).join('') : '<p class="field-help">没有匹配的工具。</p>'}</div></details>${unavailable.length ? `<div class="dsh-unavailable-grants"><strong>已保存但当前不可用</strong><p>这些名称没有计入有效授权；你可以移除后重新保存。</p><div>${unavailable.map(item=>`<button class="secondary-button compact" type="button" data-action="dsh-grant-remove" data-kind="${item.kind}" data-name="${escape(label(item.name))}" ${busy ? 'disabled' : ''}>${escape(label(item.name))}${icon('close')}</button>`).join('')}</div></div>` : ''}<div class="settings-footer"><p>本次选择：技能 ${selection.skills.length} 项 · 工具 ${selection.tools.length} 项。保存后生效。</p><div><button class="secondary-button" type="button" data-action="dsh-grants-clear" ${busy ? 'disabled' : ''}>清空选择</button><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${icon('check')}${state.extensionsBusy === 'dsh-grants' ? '正在保存…' : '保存主人授权'}</button></div></div></form>` : '<div class="tools-placeholder"><p>连接小助手 DSH 后读取目录，再按实际名称选择需要的能力。默认不新增任何工具授权。</p></div>'}</section>`;
}
function renderLegacyManager() {
  const migration = state.extensions?.migration;
  const sources = migration?.sources || [];
  const report = migration?.report;
  const catalog = report?.nativeCatalog;
  const summary = report?.summary || {};
  const query = state.nativeCatalogQuery.trim().toLocaleLowerCase();
  const matches = item => !query || `${item.name || item.id} ${item.description || ''}`.toLocaleLowerCase().includes(query);
  const skills = (catalog?.skills || []).filter(matches);
  const tools = (catalog?.tools || []).filter(matches);
  const nativePlugins = migration?.nativePlugins || report?.nativePlugins || [];
  const sourceName = id => sources.find(source => source.id === id)?.name || id;
  const statuses = { ready: ['已迁入 · 已启用', ''], 'already-imported': ['已有同名能力', 'neutral'], 'needs-adaptation': ['需要适配', 'offline'], 'dsh-managed': ['由 DSH 管理', 'neutral'] };
  const busy = Boolean(state.extensionsBusy);
  const groups = [
    { name: '文档与合同', match: name => /contract|document|docx|pdf|material|writing/i.test(name) },
    { name: '通信与联系人', match: name => /wechat|mail|message|contact|group|session|reply|social/i.test(name) },
    { name: '检索与研究', match: name => /search|research|literature|arxiv|crossref|web|browse|fetch/i.test(name) },
    { name: '其他工具', match: () => true },
  ];
  const remaining = [...tools];
  return `<div class="extension-toolbar"><div><h2>沿用原有插件与技能</h2><p>读取已配置的旧工程和 Harness 能力目录，逐项报告迁移与适配情况。</p></div><button class="primary-button" data-action="legacy-import" ${busy || !migration ? 'disabled' : ''}>${icon('folder')}${state.extensionsBusy === 'legacy-import' ? '正在清点与迁入…' : '导入原有能力'}</button></div>${!sources.length ? '<div class="info-note">'+icon('info')+'<span>尚未发现已配置的原有能力来源。请先导入现有微信连接，或检查本机 Harness 配置。</span></div>' : `<div class="legacy-source-grid">${sources.map(source => `<article><span>${icon('folder')}</span><div><strong>${escape(source.name || source.id)}</strong><small>发现 ${source.skillCount || 0} 项技能 · ${source.pluginCount || 0} 项插件配置</small></div></article>`).join('')}</div>`}${renderDshAccessManager()}<section class="legacy-catalog-section"><div class="section-heading"><h2>${icon('engine')}现有 DSH 能力目录</h2><button class="secondary-button" data-action="legacy-catalog-refresh" ${busy || !migration ? 'disabled' : ''}>${icon('refresh')}${state.extensionsBusy === 'legacy-catalog' ? '正在读取…' : '刷新 DSH 目录'}</button></div><div class="legacy-catalog-status">${pill(catalog?.connected ? 'DSH 目录已连通' : '目录待连接', catalog?.connected ? '' : 'offline')}<span>${escape(catalog?.detail || '点击刷新，读取现有 Harness 实际提供的技能与工具。')}</span></div>${catalog?.connected ? `<div class="legacy-catalog-overview"><div><strong>${catalog.skills?.length || 0}</strong><span>项 DSH 技能</span></div><div><strong>${catalog.tools?.length || 0}</strong><span>项 DSH 工具</span></div><p>这里显示 Harness 实际返回的清单。目录中存在某项能力，仅表示宿主已登记；桌面任务的调用权限和执行结果另行核验。</p></div><form id="dsh-catalog-search" class="wechat-contact-search"><label for="dsh-catalog-keyword">${icon('search')}</label><input id="dsh-catalog-keyword" name="query" value="${escape(state.nativeCatalogQuery)}" placeholder="按名称或说明查找原有能力"/><button class="secondary-button" type="submit">查找</button></form><details class="legacy-catalog-group" ${query ? 'open' : ''}><summary>DSH 技能 <span>${skills.length}</span></summary><div class="legacy-native-skills">${skills.length ? skills.map(skill => `<article><strong>${escape(skill.name)}</strong><p>${escape(skill.description || '未提供说明。')}</p><small>由 DSH 宿主管理</small></article>`).join('') : '<p class="field-help">没有匹配的技能。</p>'}</div></details>${groups.map(group => { const items=remaining.filter(item=>group.match(item.name)); for(const item of items)remaining.splice(remaining.indexOf(item),1); return items.length ? `<details class="legacy-catalog-group" ${query ? 'open' : ''}><summary>${group.name} <span>${items.length}</span></summary><div class="legacy-tool-list">${items.map(tool=>`<article><strong>${escape(tool.name)}</strong><p>${escape(tool.description || '未提供说明。')}</p>${tool.provider ? `<small>提供方：${escape(tool.provider)}</small>` : ''}</article>`).join('')}</div></details>` : ''; }).join('')}` : ''}</section>${nativePlugins.length ? `<section class="legacy-installed-section"><div class="section-heading"><h2>原 Harness 的插件安装配置</h2><span class="section-help">${nativePlugins.length} 项配置</span></div><div class="legacy-plugin-grid">${nativePlugins.map(plugin=>`<article><div>${icon('grid')}<strong>${escape(plugin.name || plugin.id)}</strong></div><small>${escape(plugin.version || '')}</small><p>${escape(plugin.detail || '沿用原 Harness 的安装配置。')}</p>${pill('安装配置已保留','neutral')}</article>`).join('')}</div></section>` : ''}<section class="legacy-report-section"><div class="section-heading"><h2>逐项迁移结果</h2>${report?.at ? `<span class="section-help">${formatTime(report.at,true)}</span>` : ''}</div>${report ? `<div class="legacy-summary"><span>已迁入启用 <strong>${summary.ready || 0}</strong></span><span>已有 / DSH 管理 <strong>${summary.preserved || 0}</strong></span><span>需要适配 <strong>${summary.needsAdaptation || 0}</strong></span></div>${report.entries?.length ? `<div class="legacy-report-table"><table><thead><tr><th>能力</th><th>来源</th><th>实际状态</th><th>说明</th></tr></thead><tbody>${report.entries.map(entry=>{const status=statuses[entry.status] || ['状态待核对','neutral'];return `<tr><td><strong>${escape(entry.name || entry.id)}</strong><small>${entry.kind === 'skill' ? 'Skill 工作方法' : 'DSH 原生扩展'}</small></td><td>${escape(sourceName(entry.sourceId))}</td><td>${pill(status[0],status[1])}</td><td>${escape(entry.detail || '')}${entry.diagnostics?.length ? `<details><summary>检查记录</summary><ul>${entry.diagnostics.map(item=>`<li>${escape(item.message || item.code || '')}</li>`).join('')}</ul></details>` : ''}</td></tr>`;}).join('')}</tbody></table></div>` : '<p class="field-help">尚未执行逐项导入。可先刷新 DSH 目录查看宿主已有能力。</p>'}` : '<div class="tools-placeholder"><p>点击“导入原有能力”进行清点和迁移，并在这里查看每一项的结果。</p></div>'}</section><div class="info-note">${icon('info')}<span>已发现、已保留和可执行会分别标注。原生扩展沿用 DSH 宿主；需要适配的项目会保留检查结果。</span></div>`;
}
function renderMcpManager() {
  const plugins = state.extensions?.mcp || [];
  const selected = plugins.find(plugin => plugin.id === state.selectedMcpId) || plugins[0];
  if (selected) state.selectedMcpId = selected.id;
  const busy = Boolean(state.extensionsBusy);
  const builtin = state.extensions?.builtinMcp || [];
  return `<div class="extension-toolbar"><div><h2>MCP 插件管理</h2><p>连接本机已安装的工具程序。导入后默认停用，检测会启动所选插件。</p></div><button class="secondary-button" data-action="mcp-import" ${busy ? 'disabled' : ''}>${icon('folder')}导入插件配置</button></div>${builtin.length ? `<div class="builtin-mcp-strip">${builtin.map(plugin => { const installed = plugins.some(item => item.id === plugin.id); return `<div><span class="extension-row-icon">${icon('doc')}</span><span><strong>${escape(plugin.name || plugin.id)}</strong><small>内置插件 · ${escape(plugin.version || '')}</small></span><button class="secondary-button compact" data-action="mcp-install-builtin" data-id="${escape(plugin.id)}" ${busy || installed ? 'disabled' : ''}>${installed ? '已经安装' : '安装内置插件'}</button></div>`; }).join('')}</div>` : ''}${!plugins.length ? `<div class="extension-empty"><div class="empty-icon">${icon('engine')}</div><h3>还没有导入 MCP 插件</h3><p>准备好插件程序和 JSON 配置后，点击“导入插件配置”。<br>当前支持本地 stdio 插件；导入配置本身不会启动程序。</p></div>` : `<div class="extension-manager"><aside class="extension-list" aria-label="已安装插件">${plugins.map(plugin => `<button class="extension-list-row ${plugin.id === selected.id ? 'active' : ''}" data-action="mcp-select" data-id="${escape(plugin.id)}"><span class="extension-row-icon">${icon('engine')}</span><span><strong>${escape(plugin.name || plugin.id)}</strong><small>${escape(plugin.version)} · ${plugin.enabled ? '已启用' : '已停用'}</small></span></button>`).join('')}</aside>${renderMcpDetail(selected)}</div>`}<div class="info-note">${icon('info')}<span>只导入你信任的本机插件。插件程序以当前 Windows 用户权限运行；启用与工具清单不构成系统沙箱。此处检测不会调用业务工具。</span></div>`;
}
function renderMcpDetail(plugin) {
  const report = state.mcpDiagnostics[plugin.id];
  const diagnostic = report || plugin.lastDiagnostic;
  const busy = Boolean(state.extensionsBusy);
  const stateLabels = { stopped: '未启动', ready: '已连接', connecting: '正在连接', closed: '已停止', error: '连接出错', failed: '连接出错' };
  const selection = state.mcpToolSelections[plugin.id] || plugin.allowedTools || [];
  const tools = Array.isArray(report?.tools) ? report.tools : [];
  return `<section class="extension-detail"><header class="extension-detail-heading"><div><h2>${escape(plugin.name || plugin.id)}</h2><span class="extension-id">${escape(plugin.id)} · ${escape(plugin.version)}</span></div>${pill(plugin.enabled ? stateLabels[plugin.state] || '已启用' : '已停用', plugin.enabled && plugin.state === 'ready' ? '' : 'neutral')}</header><dl class="extension-properties"><div><dt>来源</dt><dd>${escape(plugin.source || '本地导入')}</dd></div><div><dt>程序</dt><dd class="monospace">${escape(plugin.command || '')}</dd></div><div><dt>连接方式</dt><dd>本地 stdio</dd></div><div><dt>声明权限</dt><dd>${plugin.permissions?.length ? plugin.permissions.map(escape).join('、') : '无额外权限声明'}</dd></div></dl><div class="extension-actions">${plugin.enabled ? `<button class="secondary-button" data-action="mcp-disable" data-id="${escape(plugin.id)}" ${busy ? 'disabled' : ''}>停用插件</button><button class="primary-button" data-action="mcp-test" data-id="${escape(plugin.id)}" ${busy ? 'disabled' : ''}>${icon('refresh')}${state.extensionsBusy === `test:${plugin.id}` ? '检测中…' : '检测连接与工具'}</button>` : `<button class="primary-button" data-action="mcp-enable" data-id="${escape(plugin.id)}" ${busy ? 'disabled' : ''}>启用插件</button><span class="field-help">启用后可检测连接；启用本身不启动程序。</span>`}</div>${diagnostic ? `<div class="plugin-diagnostic ${diagnostic.ok ? '' : 'diagnostic-error'}">${icon(diagnostic.ok ? 'check' : 'info')}<div><strong>${diagnostic.ok ? '最近检测成功' : '最近检测未通过'}</strong><p>${diagnostic.ok ? `${diagnostic.toolCount ?? diagnostic.tools?.length ?? 0} 个工具 · 协议 ${escape(diagnostic.protocolVersion || '未记录')}` : escape(diagnostic.message || diagnostic.error || '请重新检测查看详细信息。')}${diagnostic.at ? ` · ${formatTime(diagnostic.at, true)}` : ''}</p></div></div>` : ''}<div class="section-heading tools-heading"><h3>工具允许清单</h3><span class="section-help">检测后逐项选择</span></div>${tools.length ? `<form id="mcp-tools-form" data-id="${escape(plugin.id)}"><div class="mcp-tool-list">${tools.map(tool => `<label class="mcp-tool-row ${tool.available === false ? 'unavailable' : ''}"><input type="checkbox" name="tools" value="${escape(tool.name)}" ${selection.includes(tool.name) ? 'checked' : ''} ${busy || tool.available === false ? 'disabled' : ''}/><span><strong>${escape(tool.name)}</strong><small>${escape(tool.description || '此工具未提供说明。')}</small>${tool.available === false ? `<em>当前参数结构不受支持：${escape(tool.reason || '无法验证')}</em>` : ''}</span></label>`).join('')}</div><div class="tools-footer"><span>已勾选 ${selection.length} 项。保存清单不会调用工具。</span><button class="secondary-button" type="submit" ${busy ? 'disabled' : ''}>${icon('check')}保存允许清单</button></div></form>` : `<div class="tools-placeholder"><p>${report ? '此插件未返回工具。' : '点击“检测连接与工具”获取实际工具清单。'}</p>${plugin.allowedTools?.length ? `<small>已保存允许项：${plugin.allowedTools.map(escape).join('、')}</small>` : '<small>尚未允许任何工具。</small>'}</div>`}</section>`;
}
function skillMissingCapabilities(skill) {
  if (Array.isArray(skill.missingCapabilities)) return skill.missingCapabilities;
  const available = new Set(state.extensions?.availableCapabilities || []);
  return (skill.requiredCapabilities || []).filter(id => !available.has(id));
}
function renderSkillCard(skill, installed = false) {
  const missing = skillMissingCapabilities(skill);
  const diagnostics = skill.diagnostics || [];
  const errors = diagnostics.filter(item => item.severity === 'error');
  const busy = Boolean(state.extensionsBusy);
  const enabled = installed && skill.enabled;
  const label = enabled && skill.usable ? '已启用 · 可用' : missing.length ? '缺少依赖' : errors.length ? '需移植检查' : enabled ? '暂不可用' : installed ? '已导入 · 未启用' : skill.installed ? '已导入' : '未导入';
  const reason = missing.length ? `缺少：${missing.map(capabilityName).join('、')}` : errors.length ? errors.map(item => item.message).join('；') : '';
  return `<article class="skill-card"><div class="skill-card-heading"><span class="skill-card-icon">${icon('spark')}</span><div><h3>${escape(skillName(skill))}</h3><small>${escape(skill.id)} · ${escape(skill.version || '版本未记录')}</small></div>${pill(label, enabled && skill.usable ? '' : missing.length || errors.length ? 'offline' : 'neutral')}</div><p class="skill-description">${escape(skill.description || '暂无说明。')}</p>${reason ? `<p class="skill-blocker">${icon('info')}${escape(reason)}</p>` : ''}<div class="skill-metadata"><span>依赖：${skill.requiredCapabilities?.length ? skill.requiredCapabilities.map(capabilityName).map(escape).join('、') : '无额外依赖'}</span><span>执行方式：${(skill.executors || ['harness-text']).map(id => id === 'harness-text' ? 'Harness 文字任务' : id === 'deterministic' ? '本地确定流程' : id).map(escape).join('、')}</span></div>${diagnostics.length ? `<details class="skill-diagnostics"><summary>查看导入检查（${diagnostics.length} 项）</summary><ul>${diagnostics.map(item => `<li class="${item.severity === 'error' ? 'error' : ''}">${escape(item.message || item.code)}</li>`).join('')}</ul></details>` : ''}<footer class="skill-card-footer">${installed ? enabled ? `<button class="secondary-button" data-action="skill-disable" data-id="${escape(skill.id)}" ${busy ? 'disabled' : ''}>停用技能</button>` : `<button class="secondary-button" data-action="skill-enable" data-id="${escape(skill.id)}" ${busy || missing.length || errors.length ? 'disabled' : ''}>启用技能</button>` : `<button class="secondary-button" data-action="skill-import-bundled" data-id="${escape(skill.id)}" ${busy || skill.installed ? 'disabled' : ''}>${skill.installed ? '已经导入' : '导入此技能'}</button>`}${installed && skill.usable && (skill.executors || []).includes('harness-text') ? '<button class="text-button" data-action="navigate" data-page="home">前往工作台使用</button>' : ''}</footer></article>`;
}
function renderSkillManager() {
  const installed = state.extensions?.skills || [];
  const bundled = state.extensions?.bundledSkills || [];
  return `<div class="extension-toolbar"><div><h2>Skills 技能管理</h2><p>技能提供可复用的做事方法。启用后，可在工作台为 AI 任务选择。</p></div><button class="secondary-button" data-action="skill-import" ${state.extensionsBusy ? 'disabled' : ''}>${icon('folder')}导入本地技能</button></div><section class="skill-section"><div class="section-heading"><h2>已导入的技能 <span class="small-count">${installed.length}</span></h2></div>${installed.length ? `<div class="skill-grid">${installed.map(skill => renderSkillCard(skill, true)).join('')}</div>` : '<div class="skill-empty-line">还没有导入技能。可以先选择下方内置工作方法，或导入包含 SKILL.md 的本地目录。</div>'}</section><section class="skill-section"><div class="section-heading"><h2>内置工作方法</h2><span class="section-help">导入后需手动启用</span></div>${bundled.length ? `<div class="skill-grid">${bundled.map(skill => renderSkillCard(skill)).join('')}</div>` : '<div class="skill-empty-line">尚未读取到内置方法，请刷新扩展状态。</div>'}</section><div class="info-note">${icon('info')}<span>导入检查会列出缺少的工具或不兼容内容。脚本目前作为资料保存；技能不能自行获得工具权限，缺少依赖时不会启用。</span></div>`;
}
function renderSkillPicker() {
  const skills = usableTextSkills();
  const selected = new Set(state.skillIds);
  if (state.kind === 'literature') return '';
  if (state.kind !== 'agent') return '<div class="skill-picker-note">本地资料整理使用固定流程，无需选择 AI 技能。</div>';
  if (!skills.length) return `<div class="skill-picker-note">工作方法：暂未启用文字任务技能。<button type="button" class="text-button" data-action="manage-skills">前往技能管理</button></div>`;
  return `<fieldset class="skill-picker"><legend>工作方法 <span>可选，最多 3 项</span></legend><div class="skill-picker-options">${skills.map(skill => `<label title="${escape(skill.description)}"><input type="checkbox" name="skillIds" value="${escape(skill.id)}" ${selected.has(skill.id) ? 'checked' : ''}/><span>${escape(skillName(skill))}</span></label>`).join('')}</div><button type="button" class="text-button" data-action="manage-skills">管理技能</button></fieldset>`;
}
const workflowInfo = {
  single: { name: '单助手工作', description: '由小助手完成一次文字工作。', calls: 1 },
  'writing-review': { name: '起草 + 审查', description: '先起草，再由独立审查角色检查遗漏与问题。', calls: 2 },
  'research-compare': { name: '双路分析 + 比较', description: '两个分析角色分别处理所给资料，再对照审查。', calls: 3 },
};
function renderWorkMode() {
  if (state.kind === 'literature') return '<div class="work-mode-local">'+icon('search')+'检索 Crossref 与 arXiv 的论文信息，合计最多 20 条；不调用 AI 模型，不下载全文。结果保留来源并导出 BibTeX。</div>';
  if (state.kind !== 'agent') return '<div class="work-mode-local">'+icon('folder')+'本地资料整理 · 使用固定流程，不调用 AI 模型</div>';
  const selected = workflowInfo[state.workflowId] || workflowInfo.single;
  const configured = hasSharedHarnessAccount();
  return `<div class="work-mode"><label for="work-mode">工作方式</label><select id="work-mode" name="workflowId" ${state.sending ? 'disabled' : ''}>${Object.entries(workflowInfo).map(([id, workflow]) => `<option value="${id}" ${id === state.workflowId ? 'selected' : ''}>${workflow.name}${workflow.calls > 1 ? `（${workflow.calls} 次模型调用）` : ''}</option>`).join('')}</select><span class="work-mode-status ${configured ? '' : 'needs-account'}">${configured ? '沿用 Harness 登录' : '等待连接 DSH'}</span><p>${escape(selected.description)}${state.workflowId !== 'single' ? ' 使用同一个已配置模型的不同角色；仅分析提供的文字资料。' : ''}</p>${state.workflowId !== 'single' ? `<small>预计调用 ${selected.calls} 次模型；DSH 未连接时保留等待状态。审查结果仍需你核对。</small>` : ''}</div>`;
}
function renderWorkers() {
  const workflows = state.workflows?.workflows || [];
  const workers = state.workflows?.workers || [];
  const configured = hasSharedHarnessAccount();
  const roleNames = Object.fromEntries(workers.map(worker => [worker.id, worker.name]));
  const descriptions = {
    writer: '根据目标和给定资料起草文字，标明待确认的信息。',
    reviewer: '对照原始资料检查草稿，指出遗漏、数字与逻辑问题。',
    'analyst-a': '梳理主要观点、证据与可行方案。',
    'analyst-b': '分析反例、替代解释与潜在遗漏。',
  };
  const calls = id => workflowInfo[id]?.calls || 0;
  return `<div class="page-heading"><div><h1>${icon('heart')}协作帮手</h1><p>让不同工作角色分步处理同一项文字任务，保留各自的成果。</p></div><button class="secondary-button" data-action="navigate" data-page="home">${icon('doc')}返回工作台</button></div>${state.workflowsError ? `<div class="load-error">${escape(state.workflowsError)}</div>` : ''}<div class="worker-account-note">${pill(configured ? '沿用 Harness 登录' : '等待连接 DSH', configured ? '' : 'offline')}<span>${configured ? '协作任务由小助手 DSH 使用现有 Harness 登录执行。' : '请先连接已登录的 Harness，小助手会沿用现有账户。'}</span>${configured ? '' : '<button class="text-button" data-action="navigate" data-page="settings">查看连接</button>'}</div><div class="workflow-grid">${workflows.length ? workflows.filter(workflow => Object.hasOwn(workflowInfo, workflow.id)).map(workflow => `<article class="workflow-card"><div class="workflow-card-top"><span class="capability-icon">${icon(workflow.id === 'writing-review' ? 'doc' : 'search')}</span><div><h2>${escape(workflow.name || workflowInfo[workflow.id].name)}</h2><small>${calls(workflow.id)} 次模型调用 · 文字任务</small></div></div><p>${escape(workflowInfo[workflow.id].description)}</p><div class="workflow-diagram" aria-label="协作步骤">${workflow.id === 'research-compare' ? `<div class="workflow-parallel"><span>${icon('search')}${escape(roleNames['analyst-a'] || '分析助手甲')}</span><span>${icon('search')}${escape(roleNames['analyst-b'] || '分析助手乙')}</span></div>${icon('arrow')}<span class="workflow-step">${icon('shield')}${escape(roleNames.reviewer || '审查助手')}</span>` : `<span class="workflow-step">${icon('doc')}${escape(roleNames.writer || '写作助手')}</span>${icon('arrow')}<span class="workflow-step">${icon('shield')}${escape(roleNames.reviewer || '审查助手')}</span>`}</div><div class="workflow-detail-line">${workflow.id === 'research-compare' ? '分析甲与分析乙可并行；比较审查在两份原稿完成后开始。' : '保留原始草稿与审查意见，当前不自动追加修订。'}</div><button class="primary-button" data-action="choose-workflow" data-id="${escape(workflow.id)}">${icon('arrow')}在工作台选择此流程</button></article>`).join('') : '<div class="empty-state"><div class="empty-icon">'+icon('heart')+'</div><strong>正在读取可用协作流程</strong><p>协作入口只展示当前服务实际提供的流程。</p></div>'}</div><section class="worker-roles-section"><div class="section-heading"><h2>工作角色</h2><span class="section-help">由同一个已配置模型分别执行</span></div><div class="worker-role-grid">${workers.filter(worker => Object.hasOwn(descriptions, worker.id)).map(worker => `<article class="worker-role-card">${icon(worker.id === 'reviewer' ? 'shield' : worker.id === 'writer' ? 'doc' : 'search')}<div><h3>${escape(worker.name || worker.id)}</h3><p>${escape(descriptions[worker.id])}</p></div></article>`).join('')}</div></section><div class="info-note">${icon('info')}<span>当前协作只使用你提供的文字资料，不含实时检索与电脑操作。不同角色仍使用同一个模型账户；模型审查意见需要结合原始证据核对。调用次数会增加，实际费用以模型服务账单为准。</span></div>`;
}
function renderWorkerResult(result) {
  if (!result) return '';
  const names = { writer: '写作助手', reviewer: '审查助手', 'analyst-a': '分析助手甲', 'analyst-b': '分析助手乙', reviser: '修订助手' };
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const budget = result.budget || {};
  return `<section class="drawer-section"><h3>${icon('heart')}协作步骤</h3><div class="worker-result-overview">${taskPill(result.status)}<span>${escape(workflowInfo[result.workflow]?.name || '文字协作')}${Number.isFinite(budget.callsUsed) ? ` · 已调用 ${budget.callsUsed}${Number.isFinite(budget.maxCalls) ? ` / ${budget.maxCalls}` : ''} 次模型` : ''}</span></div>${steps.length ? `<ol class="worker-step-list">${steps.map((step, index) => `<li><span class="worker-step-number">${index + 1}</span><div><div class="worker-step-title"><strong>${escape(step.name || names[step.role] || step.role || step.id)}</strong>${taskPill(step.status)}</div>${step.error ? `<p class="worker-step-error">${escape(typeof step.error === 'object' ? step.error.message || step.error.code || '此步骤没有完成' : step.error)}</p>` : ''}${step.reviewOf?.length ? '<small>对照前序角色的实际成果进行审查。</small>' : ''}</div></li>`).join('')}</ol>` : '<p class="muted-text">协作步骤记录尚未生成。</p>'}<p class="worker-result-note">${result.status === 'partial' ? '部分步骤未完成；已生成的成果仍保留在下方。' : '各角色使用独立工作目录；审查意见需要结合原始证据核对。'}</p></section>`;
}
function renderDocumentExports(task) {
  if (!task || !['succeeded', 'partial'].includes(task.status) || !String(task.summary || '').trim()) return '';
  return `<div class="document-export-bar"><span>将这项工作的正文导出为：</span><button class="secondary-button compact" data-action="export-task" data-format="docx" ${state.exportingFormat ? 'disabled' : ''}>${icon('doc')}${state.exportingFormat === 'docx' ? '正在生成 Word…' : '导出 Word'}</button><button class="secondary-button compact" data-action="export-task" data-format="pdf" ${state.exportingFormat ? 'disabled' : ''}>${icon('doc')}${state.exportingFormat === 'pdf' ? '正在生成 PDF…' : '导出 PDF'}</button></div>`;
}
function wechatMessages() {
  return (Array.isArray(state.wechat?.messages) ? [...state.wechat.messages] : []).sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
}
function wechatConversations() {
  const conversations = new Map();
  const allowed = (kind, id) => (kind === 'group' ? state.wechat?.settings?.allowedGroups : state.wechat?.settings?.allowedPrivate)?.map(String).includes(String(id)) || false;
  const add = record => {
    const kind = record.kind === 'group' || record.kind === 'groups' ? 'group' : 'private';
    const id = String(record.id ?? record.conversationId ?? '');
    if (!id) return;
    const key = `${kind}:${id}`;
    if (!conversations.has(key)) conversations.set(key, { key, id, kind, name: record.name || record.conversationName || wechatContactLabel(id, kind), allowed: allowed(kind, id), messages: [] });
  };
  for (const session of state.wechat?.sessions || []) if (session.allowed !== false) add(session);
  for (const contact of state.wechat?.allowedContacts || []) add(contact);
  for (const message of wechatMessages()) {
    add({ ...message, id: message.conversationId });
    conversations.get(`${message.kind}:${message.conversationId}`)?.messages.push(message);
  }
  return [...conversations.values()];
}
function selectedWechatConversation() {
  const conversations = wechatConversations();
  const selected = conversations.find(conversation => conversation.key === state.selectedConversationKey) || conversations[0];
  if (selected && selected.key !== state.selectedConversationKey) {
    if (state.selectedConversationKey) state.wechatReplyByConversation[state.selectedConversationKey] = state.wechatReply;
    state.wechatReply = state.wechatReplyByConversation[selected.key] || '';
    state.selectedConversationKey = selected.key;
    state.selectedMessageId = selected.messages[0]?.id || null;
  }
  return selected;
}
function selectedWechatMessage() {
  const conversation = selectedWechatConversation();
  const selected = conversation?.messages.find(message => message.id === state.selectedMessageId) || conversation?.messages[0];
  if (selected) state.selectedMessageId = selected.id;
  return selected;
}
function wechatConnectionInfo() {
  const connection = state.wechat?.connection || {};
  const labels = { offline: '微信未连接', connecting: '正在连接微信', ready: '微信收发已连接', error: '微信连接出错' };
  return { state: connection.state || 'offline', label: labels[connection.state] || '未连接', style: connection.state === 'ready' ? '' : connection.state === 'error' ? 'error' : 'offline',
    detail: connection.detail || (state.wechat?.settings?.connectionImported ? '现有连接配置已导入，请手动连接。' : '先导入这台电脑现有的 WeChatAgent 连接配置。') };
}
function wechatContactLabel(id, kind) {
  const record = (state.wechat?.allowedContacts || []).find(contact => String(contact.id) === String(id) && (contact.kind === kind || (kind === 'groups' && contact.kind === 'group')));
  return record?.name || state.wechatContactNames[`${kind === 'groups' ? 'group' : kind}:${id}`] || (kind === 'group' || kind === 'groups' ? '名称待同步的群聊' : '名称待同步的联系人');
}
function wechatConversationName(message) {
  const name = message.conversationName;
  return name && String(name) !== String(message.conversationId) ? name : wechatContactLabel(message.conversationId, message.kind);
}
function wechatSenderName(message) {
  const name = message.senderName;
  return name && String(name) !== String(message.senderId) ? name : message.kind === 'group' ? '群成员' : wechatConversationName(message);
}
function renderWechatProfile() {
  const profile = state.wechat?.profile || {};
  const connection = wechatConnectionInfo();
  const verified = profile.verified === true && profile.loginState === 'ready' && connection.state === 'ready';
  const cached = profile.source === 'cached';
  const name = profile.nickname || (connection.state === 'connecting' ? '正在识别微信账号…' : '微信账号待识别');
  const loginLabels = { ready: verified ? '已登录 · 账号已核验' : '账号待核验', offline: '微信未连接', connecting: '正在连接微信', error: '账号状态需检查' };
  const label = loginLabels[profile.loginState] || (connection.state === 'ready' ? '正在读取账号信息' : loginLabels[connection.state] || '微信未连接');
  return `<div class="wechat-account-card"><span class="wechat-account-avatar" aria-hidden="true">${profile.nickname ? escape(Array.from(profile.nickname)[0]) : icon('chat')}</span><div class="wechat-account-identity"><small>${cached ? '上次识别的微信账号' : '当前微信账号'}</small><h2>${escape(name)}</h2><div class="wechat-account-fields"><span>微信号：<strong>${escape(profile.alias || '尚未读取')}</strong></span>${profile.wxid ? `<span>账号标识：<strong>${escape(profile.wxid)}</strong></span>` : ''}</div></div><div class="wechat-account-status">${pill(label, verified ? '' : profile.loginState === 'error' ? 'error' : 'offline')}<small>${cached ? '当前状态以重新连接后的核验为准' : verified ? '已核对这台电脑当前登录的微信' : '连接后读取当前微信的账号信息'}</small><button class="text-button" data-action="wechat-profile-refresh" ${state.wechatBusy || connection.state !== 'ready' ? 'disabled' : ''}>${icon('refresh')}${state.wechatBusy === 'profile' ? '正在识别…' : '重新识别账号'}</button></div></div>`;
}
function renderWechatAutomation() {
  const settings = state.wechat?.settings || {};
  const automatic = state.wechat?.autoReply || {};
  const enabled = settings.autoReply === true;
  const status = automatic.state || (enabled ? 'idle' : 'disabled');
  const labels = { disabled: '自动回复已关闭', paused: '自动回复已暂停', idle: '等待新消息', generating: '正在思考回复', sending: '正在发送回复', unconfirmed: '发送结果待核对', error: '自动回复需要处理', closed: '自动回复已停止' };
  const label = !enabled && !['generating', 'sending', 'unconfirmed'].includes(status) ? '自动回复已关闭' : labels[status] || '正在同步回复状态';
  const detail = [automatic.detail || (enabled ? '已开启，正在等待微信服务同步状态。' : '你可以在下方查看消息或自己写信。'), automatic.lastError].filter((value, index, values) => value && (index === 0 || !String(values[0]).includes(value))).join(' · ');
  const busy = Boolean(state.wechatBusy) || !state.wechat;
  return `<div class="wechat-automation" aria-label="小助手 DSH 自动回复设置"><div class="wechat-automation-options"><label for="wechat-auto-reply"><input id="wechat-auto-reply" type="checkbox" ${enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-describedby="wechat-automation-help"/><span>自动回复</span></label><label for="wechat-auto-connect"><input id="wechat-auto-connect" type="checkbox" ${settings.autoConnect === true ? 'checked' : ''} ${busy ? 'disabled' : ''}/><span>下次启动自动连接</span></label>${state.wechatBusy === 'autoReply' || state.wechatBusy === 'autoConnect' ? '<small>正在保存设置…</small>' : ''}</div><p id="wechat-automation-help">开启后，小助手 DSH 会回复已选择聊天中的新文字消息；历史消息不会补发。开关更改后立即保存。</p><div class="wechat-auto-status ${['error', 'unconfirmed'].includes(status) ? 'error' : ''}" data-state="${escape(status)}" role="status" aria-live="polite">${icon(['error', 'unconfirmed'].includes(status) ? 'info' : ['generating', 'sending'].includes(status) ? 'clock' : 'engine')}<strong>小助手 DSH · ${escape(label)}</strong><span>${escape(detail)}</span>${automatic.taskId ? `<button type="button" class="text-button" data-action="open-task" data-id="${escape(automatic.taskId)}">查看回复任务</button>` : ''}</div></div>`;
}
function renderWechat() {
  const connection = wechatConnectionInfo();
  const settings = state.wechat?.settings || {};
  const busy = Boolean(state.wechatBusy);
  const connected = ['ready', 'connecting'].includes(connection.state);
  const allowedCount = (settings.allowedPrivate?.length || 0) + (settings.allowedGroups?.length || 0);
  const detail = connection.detail.replace(/\s*[（(]WECHAT_[A-Z_]+[）)]/g, '');
  const automaticState = state.wechat?.autoReply?.state;
  const automaticLabel = ({ generating: '正在思考回复', sending: '正在发送回复', unconfirmed: '发送结果待核对', error: '自动回复需要处理', paused: '自动回复已暂停', closed: '自动回复已停止' })[automaticState] || (settings.autoReply ? '自动回复已开启' : '自动回复已关闭');
  return `<div class="page-heading"><div><h1>${icon('chat')}微信通信</h1><p>连接自己的微信，让小助手 DSH 在你选择的好友和群聊中收信、回复。</p></div></div>
    ${state.wechatError ? `<div class="load-error" role="alert">${escape(state.wechatError)}<button class="text-button" data-action="wechat-refresh">${icon('refresh')}重试</button></div>` : ''}
    <details id="wechat-connection-details" class="wechat-connection-details" ${(state.wechatConnectionExpanded ?? connection.state !== 'ready') ? 'open' : ''}><summary class="wechat-connection-summary"><span class="wechat-summary-icon">${icon('chat')}</span><span class="wechat-summary-identity"><strong>${escape(state.wechat?.profile?.nickname || '我的微信')}</strong><small class="${['error', 'unconfirmed'].includes(automaticState) ? 'attention' : ''}">${escape(automaticLabel)}</small></span>${pill(connection.label, connection.style)}<span class="wechat-summary-action">连接与自动回复设置${icon('chevron')}</span></summary><section class="connection-panel"><div class="panel-heading"><h2>${icon('chat')}我的微信</h2>${pill(connection.label, connection.style)}</div>${renderWechatProfile()}<div class="wechat-connect-footer"><div class="connection-copy"><strong>${escape(detail)}</strong><p>${settings.connectionImported ? '已导入本机连接' : '首次使用请导入现有微信连接'} · 已选择 ${settings.allowedPrivate?.length || 0} 位好友、${settings.allowedGroups?.length || 0} 个群${!allowedCount ? ' · 尚不接收任何会话' : ''}</p></div><div class="wechat-connection-buttons"><button class="secondary-button" data-action="wechat-import" ${busy || connected ? 'disabled' : ''}>${icon('folder')}${state.wechatBusy === 'import' ? '正在导入…' : '导入现有微信连接'}</button>${connected ? `<button class="secondary-button" data-action="wechat-disconnect" ${busy ? 'disabled' : ''}>断开连接</button>` : `<button class="primary-button" data-action="wechat-connect" ${busy || !settings.connectionImported ? 'disabled' : ''}>${icon('engine')}${state.wechatBusy === 'connect' ? '正在连接…' : '连接我的微信'}</button>`}</div></div>${renderWechatAutomation()}</section></details>
    <div class="xp-tabs" role="tablist" aria-label="微信功能">${[['inbox', 'mail', '消息与回复'], ['contacts', 'heart', '好友与群聊'], ['settings', 'settings', '连接设置']].map(([id, image, title]) => `<button id="wechat-tab-${id}" role="tab" aria-selected="${state.wechatTab === id}" aria-controls="wechat-panel" class="${state.wechatTab === id ? 'active' : ''}" data-action="wechat-tab" data-tab="${id}">${icon(image)}${title}${id === 'inbox' ? `<span class="tab-count">${wechatMessages().length}</span>` : ''}</button>`).join('')}<button class="tab-refresh" data-action="wechat-refresh" title="刷新微信状态">${icon('refresh')}刷新</button></div>
    <section id="wechat-panel" class="tab-panel" role="tabpanel" aria-labelledby="wechat-tab-${state.wechatTab}">${state.wechatTab === 'settings' ? renderWechatSettings() : state.wechatTab === 'contacts' ? renderWechatContacts() : renderWechatInbox()}</section>`;
}
function renderWechatSettings() {
  const settings = state.wechatSettingsDraft || state.wechat?.settings || {};
  return `<form id="wechat-settings-form"><div class="wechat-settings-intro">${icon('info')}<span>好友与群聊请在“好友与群聊”中按名字选择。这里保留本机连接的高级设置；保存时会应用新的连接参数。</span></div><fieldset ${state.wechatBusy ? 'disabled' : ''}><legend>本地通信接口（高级）</legend><p class="field-help">通常直接使用导入的设置。修改前请确认对应本机微信读取与发送服务正在运行。</p><div class="two-fields"><label class="field"><span>消息读取接口</span><input name="readerBaseUrl" type="url" value="${escape(settings.readerBaseUrl || '')}" placeholder="导入配置后显示" autocomplete="off" spellcheck="false"/></label><label class="field"><span>微信发送接口</span><input name="hookBaseUrl" type="url" value="${escape(settings.hookBaseUrl || '')}" placeholder="导入配置后显示" autocomplete="off" spellcheck="false"/></label></div></fieldset><div class="wechat-privacy-note">${icon('shield')}<span>连接凭据由桌面程序安全保存。仅接收已选择聊天的文字消息；自动回复由上方开关控制，也可以随时自己写信。</span></div><div class="settings-footer"><p>更改连接参数后，小助手会重新连接微信。</p><button class="primary-button" type="submit" ${state.wechatBusy ? 'disabled' : ''}>${icon('check')}保存连接设置</button></div></form>`;
}
function wechatAllowedSelection() {
  if (!state.wechatAllowedDraft) state.wechatAllowedDraft = { private: [...(state.wechat?.settings?.allowedPrivate || [])].map(String), groups: [...(state.wechat?.settings?.allowedGroups || [])].map(String) };
  return state.wechatAllowedDraft;
}
function renderWechatContacts() {
  const selection = wechatAllowedSelection();
  const kind = state.wechatContactKind;
  const group = kind === 'groups';
  const selected = selection[kind];
  const contacts = state.wechatContactResults[kind] || [];
  const busy = Boolean(state.wechatBusy);
  return `<div class="wechat-contacts-intro"><div><h2>选择小助手可以接收的聊天</h2><p>搜索微信里的好友昵称、备注或群名，勾选需要的聊天，再保存范围。</p></div><button class="secondary-button" data-action="wechat-contacts-refresh" ${busy ? 'disabled' : ''}>${icon('refresh')}同步联系人</button></div><div class="contact-kind-tabs" role="group" aria-label="联系人类型">${[['private', '好友'], ['groups', '群聊']].map(([id, title]) => `<button class="filter-button ${kind === id ? 'active' : ''}" data-action="wechat-contact-kind" data-kind="${id}">${title}<span>${selection[id].length}</span></button>`).join('')}</div><div class="selected-contacts"><div class="selected-contacts-heading">已选择的${group ? '群聊' : '好友'} <strong>${selected.length}</strong></div>${selected.length ? `<div class="contact-chip-list">${selected.map(id => `<span class="contact-name-chip">${icon(group ? 'grid' : 'chat')}<span>${escape(wechatContactLabel(id, group ? 'group' : 'private'))}</span><button type="button" data-action="wechat-contact-remove" data-id="${escape(id)}" data-kind="${kind}" aria-label="移除${escape(wechatContactLabel(id, group ? 'group' : 'private'))}" ${busy ? 'disabled' : ''}>${icon('close')}</button></span>`).join('')}</div>` : `<p class="selected-contacts-empty">尚未选择${group ? '群聊' : '好友'}，小助手不会接收这一类聊天。</p>`}</div><form id="wechat-contact-search-form" class="wechat-contact-search"><label for="wechat-contact-keyword">${icon('search')}</label><input id="wechat-contact-keyword" name="keyword" value="${escape(state.wechatContactKeyword)}" placeholder="搜索${group ? '群聊名称' : '好友昵称或备注'}" autocomplete="off"/><button class="secondary-button" type="submit" ${busy ? 'disabled' : ''}>${state.wechatBusy === 'contacts' ? '正在查找…' : '搜索'}</button></form><div class="wechat-contact-results" aria-label="联系人搜索结果">${contacts.length ? contacts.map(contact => `<label class="wechat-contact-option ${contact.ambiguous || contact.selectable === false ? 'unavailable' : ''}"><input type="checkbox" data-contact-id="${escape(contact.id)}" data-kind="${kind}" ${selected.includes(String(contact.id)) ? 'checked' : ''} ${busy || contact.ambiguous || contact.selectable === false ? 'disabled' : ''}/><span class="contact-person-icon">${icon(group ? 'grid' : 'chat')}</span><span><strong>${escape(contact.name || (group ? '名称待同步的群聊' : '名称待同步的联系人'))}</strong><small>${contact.ambiguous || contact.selectable === false ? '名称或会话存在歧义，暂不能选择' : selected.includes(String(contact.id)) ? '已选择' : group ? '微信中的群聊' : '微信中的好友'}</small></span></label>`).join('') : `<div class="contact-search-empty">${icon('search')}<strong>${state.wechatBusy === 'contacts' ? '正在读取微信通讯录…' : state.wechatContactsSearched ? '没有找到匹配的聊天' : '按名字查找好友与群聊'}</strong><p>${state.wechatContactsSearched ? '试试昵称、备注或群名中的其他字词，也可以同步联系人后再搜索。' : '先连接自己的微信，再点击同步联系人或输入名字搜索。'}</p></div>`}</div><details class="contact-advanced"><summary>查看已选择会话的标识（高级）</summary><ul>${[...selection.private.map(id => ({ id, kind: 'private' })), ...selection.groups.map(id => ({ id, kind: 'group' }))].map(contact => `<li><strong>${escape(wechatContactLabel(contact.id, contact.kind))}</strong><code>${escape(contact.id)}</code></li>`).join('') || '<li>尚未选择聊天。</li>'}</ul></details><div class="settings-footer"><p>好友 ${selection.private.length} 位 · 群聊 ${selection.groups.length} 个。保存后按此范围接收消息。</p><button class="primary-button" data-action="wechat-save-contacts" ${busy ? 'disabled' : ''}>${icon('check')}保存聊天范围</button></div>`;
}
function renderWechatImages(message, conversation) {
  return (message.images || []).map(item => {
    const key = `${conversation.key}:${item.id}`;
    const cached = state.wechatImages[key];
    return `<div class="wechat-image-item">${cached?.uri ? `<img class="wechat-message-image" src="${cached.uri}" alt="${item.kind === 'sticker' ? '微信表情' : '微信图片'}"/>` : `<button class="secondary-button compact" data-action="wechat-image" data-image-id="${escape(item.id)}" ${state.wechatBusy ? 'disabled' : ''}>${icon('doc')}${state.wechatBusy === `image:${item.id}` ? '正在读取图片…' : item.kind === 'sticker' ? '查看表情' : '查看图片'}</button>`}${cached?.error ? `<small class="send-error">${escape(cached.error)}</small>` : ''}</div>`;
  }).join('');
}
function renderWechatStickerPicker(conversation) {
  if (!state.wechatStickerPanel) return '';
  const result = state.wechatStickers[conversation.key];
  return `<div class="wechat-sticker-picker"><form id="wechat-sticker-form"><label for="wechat-sticker-query">查找已有表情</label><input id="wechat-sticker-query" name="query" value="${escape(state.wechatStickerQuery)}" placeholder="输入表情关键词"/><button class="secondary-button compact" type="submit" ${state.wechatBusy ? 'disabled' : ''}>搜索</button></form><p>点击下方表情名称会直接发送给 ${escape(conversation.name)}。</p>${result?.enabled === false ? '<p class="field-help">当前微信接口未启用表情发送。</p>' : result?.stickers?.length ? `<div class="wechat-sticker-list">${result.stickers.map(sticker => `<button class="secondary-button" data-action="wechat-sticker-send" data-id="${escape(sticker.id)}" ${state.wechatBusy || !conversation.allowed || wechatConnectionInfo().state !== 'ready' ? 'disabled' : ''}>${escape(sticker.description || sticker.tags?.join('、') || '微信表情')}</button>`).join('')}</div>` : '<p class="field-help">没有找到可发送的表情。可以换一个关键词。</p>'}</div>`;
}
const wechatDeliveryLabels = { selected: '待发送', sent: '已提交发送', succeeded: '已提交发送', delivered: '已送达', sending: '正在发送', queued: '等待发送', rejected: '未发送', failed: '发送失败', uncertain: '结果待核对', unconfirmed: '结果待核对', unknown: '结果待核对' };
function renderWechatOutgoing(outgoing) {
  if (!['image', 'file'].includes(outgoing.mediaType)) return `<p class="message-text">${escape(outgoing.text || (outgoing.stickerId ? '微信表情' : ''))}</p>`;
  return `<div class="wechat-outgoing-attachment">${icon(outgoing.mediaType === 'image' ? 'image' : 'doc')}<span><strong>${escape(outgoing.name || (outgoing.mediaType === 'image' ? '微信图片' : '微信文件'))}</strong><small>${outgoing.mediaType === 'image' ? '图片' : '文件'}${Number.isFinite(Number(outgoing.size)) ? ` · ${fileSize(outgoing.size)}` : ''}</small></span></div>`;
}
function wechatAttachmentStatus(conversation, attachment) {
  const outgoing = (state.wechat?.outbox || []).find(item => item.kind === conversation.kind && String(item.target ?? item.conversationId) === conversation.id && (attachment.requestId ? item.requestId === attachment.requestId : item.attachmentId === attachment.id));
  return outgoing || attachment;
}
function renderWechatAttachments(conversation) {
  const disabled = Boolean(state.wechatBusy) || !conversation.allowed || wechatConnectionInfo().state !== 'ready';
  const attachments = state.wechatAttachmentsByConversation[conversation.key] || [];
  return `<section class="wechat-attachments" aria-label="发送图片与文件"><div class="wechat-attachments-toolbar"><strong>${icon('attach')}图片与文件</strong><button type="button" class="secondary-button compact" data-action="wechat-attachment-pick" data-media-type="image" ${disabled ? 'disabled' : ''}>${icon('image')}${state.wechatBusy === 'pick-image' ? '正在选择…' : '添加图片'}</button><button type="button" class="secondary-button compact" data-action="wechat-attachment-pick" data-media-type="file" ${disabled ? 'disabled' : ''}>${icon('folder')}${state.wechatBusy === 'pick-file' ? '正在选择…' : '添加文件'}</button></div>${attachments.length ? `<div class="wechat-attachment-list">${attachments.map(attachment => {
    const delivery = wechatAttachmentStatus(conversation, attachment);
    const status = delivery.status || 'selected';
    return `<article class="wechat-selected-attachment" data-attachment-id="${escape(attachment.id)}" data-status="${escape(status)}">${icon(attachment.mediaType === 'image' ? 'image' : 'doc')}<div class="wechat-attachment-copy"><strong>${escape(attachment.name)}</strong><small>${attachment.mediaType === 'image' ? '图片' : '文件'} · ${fileSize(attachment.size)} · <span class="wechat-attachment-status">${escape(wechatDeliveryLabels[status] || '结果待核对')}</span></small>${delivery.error ? `<p class="send-error">${escape(delivery.error)}</p>` : ''}${status === 'rejected' ? '<p class="field-help">本次未提交给微信。处理上述原因后，可点击重新发送。</p>' : ['uncertain', 'unconfirmed', 'unknown'].includes(status) ? '<p class="field-help">请先在微信中核对结果，避免重复发送。</p>' : ''}</div><div class="wechat-attachment-actions"><button type="button" class="secondary-button compact" data-action="wechat-attachment-send" data-id="${escape(attachment.id)}" ${disabled || !['selected', 'rejected'].includes(status) ? 'disabled' : ''}>${status === 'selected' ? `发送${attachment.mediaType === 'image' ? '图片' : '文件'}` : status === 'rejected' ? '重新发送' : escape(wechatDeliveryLabels[status] || '结果待核对')}</button><button type="button" class="text-button" data-action="wechat-attachment-remove" data-id="${escape(attachment.id)}" aria-label="${['selected', 'rejected'].includes(status) ? '移除' : '收起'}${escape(attachment.name)}" ${state.wechatBusy ? 'disabled' : ''}>${['selected', 'rejected'].includes(status) ? '移除' : '收起'}</button></div></article>`;
  }).join('')}</div>` : '<p class="wechat-attachments-help">从电脑中选择图片或文件，再单独发送；添加附件不会立即外发。</p>'}</section>`;
}
function renderWechatInbox() {
  const conversations = wechatConversations();
  const conversation = selectedWechatConversation();
  const selected = selectedWechatMessage();
  if (!conversation) return `<div class="wechat-empty"><div class="empty-icon">${icon('mail')}</div><h2>先选择你要联系的人</h2><p>连接自己的微信，在“好友与群聊”按名字选择聊天。<br>保存后便可查看历史消息、写信和接收新消息。</p><button class="secondary-button" data-action="wechat-tab" data-tab="contacts">${icon('heart')}选择好友与群聊</button></div>`;
  const threadMessages = conversation.messages;
  const ids = new Set(threadMessages.map(message => message.id));
  const thread = threadMessages.map(message => ({ type: message.outgoing === true || message.direction === 'outgoing' || message.isSelf ? 'history-outgoing' : 'incoming', time: message.receivedAt, message }));
  for (const outgoing of state.wechat?.outbox || []) if (ids.has(outgoing.messageId) || (String(outgoing.target ?? outgoing.conversationId) === conversation.id && outgoing.kind === conversation.kind)) thread.push({ type: 'outgoing', time: outgoing.createdAt, outgoing });
  thread.sort((a, b) => new Date(a.time) - new Date(b.time));
  const outboxLabels = wechatDeliveryLabels;
  const connection = wechatConnectionInfo();
  const disabled = Boolean(state.wechatBusy) || connection.state !== 'ready' || !conversation.allowed;
  const loaded = state.wechatHistoryLoaded[conversation.key];
  return `<div class="wechat-inbox"><aside class="conversation-pane" aria-label="微信会话"><div class="pane-caption">${icon('chat')}会话列表<span>${conversations.length}</span><button class="text-button" data-action="wechat-sessions" aria-label="同步会话列表" title="同步会话列表" ${state.wechatBusy ? 'disabled' : ''}>${icon('refresh')}</button></div><div class="conversation-list">${conversations.map(item => `<button class="conversation-row ${item.key === conversation.key ? 'active' : ''}" data-action="wechat-conversation" data-key="${escape(item.key)}"><span class="contact-avatar ${item.kind === 'group' ? 'group' : ''}">${icon(item.kind === 'group' ? 'grid' : 'chat')}</span><span class="conversation-copy"><strong>${escape(item.name)}</strong><small>${item.kind === 'group' ? '微信群聊' : '微信好友'}${item.allowed ? '' : ' · 未授权'}</small><span class="conversation-preview">${escape(item.messages[0]?.text || '点击查看历史或开始写信')}</span></span><span class="conversation-meta">${item.messages[0] ? `<time>${formatTime(item.messages[0].receivedAt)}</time>` : ''}${item.messages.length ? `<span class="message-count">${item.messages.length}</span>` : ''}</span></button>`).join('')}</div></aside><div class="message-pane"><header class="conversation-header"><div><h2>${escape(conversation.name)}</h2><p>${conversation.kind === 'group' ? '微信群聊' : '微信好友'} · ${conversation.allowed ? '已选择的聊天' : '不在当前接收范围，暂不能发送'}</p><details class="conversation-identity"><summary>会话标识（高级）</summary><code>${escape(conversation.id)}</code></details></div><button class="secondary-button compact" data-action="wechat-history" ${disabled ? 'disabled' : ''}>${icon('refresh')}${state.wechatBusy === 'history' ? '正在读取…' : loaded ? '刷新历史' : '查看历史'}</button></header><div class="message-thread" aria-label="会话消息">${loaded ? '<div class="history-range-note">显示最近最多 100 条消息；当前未提供更早消息翻页。</div>' : ''}${thread.length ? thread.map(entry => entry.type !== 'outgoing' ? `<article class="wechat-message ${entry.type === 'history-outgoing' ? 'outgoing' : 'incoming'} ${entry.message.id === selected?.id ? 'selected' : ''}"><div class="message-heading"><strong>${entry.type === 'history-outgoing' ? '我' : escape(wechatSenderName(entry.message))}</strong><time>${formatTime(entry.time, true)}</time>${entry.type === 'incoming' ? `<button class="text-button reply-target" data-action="wechat-target" data-id="${escape(entry.message.id)}">${entry.message.id === selected?.id ? '当前起草参考' : '作为起草参考'}</button>` : ''}</div>${entry.message.text ? `<div class="message-text">${escape(entry.message.text)}</div>` : ''}${renderWechatImages(entry.message, conversation)}</article>` : `<article class="wechat-message outgoing"><div class="message-heading"><strong>我</strong><time>${formatTime(entry.time, true)}</time><span class="outbox-status ${entry.outgoing.status === 'failed' ? 'failed' : ''}">${escape(outboxLabels[entry.outgoing.status] || '结果待核对')}</span></div>${renderWechatOutgoing(entry.outgoing)}${entry.outgoing.error ? `<p class="send-error">${escape(entry.outgoing.error)}</p>` : ''}</article>`).join('') : `<div class="wechat-thread-empty">${icon('chat')}<strong>与 ${escape(conversation.name)} 的会话</strong><p>点击“查看历史”读取已有消息，或在下方直接写信。</p></div>`}</div><div class="reply-composer"><form id="wechat-reply-form"><div class="reply-caption"><label for="wechat-reply">手动写给 ${escape(conversation.name)}</label><div>${selected?.taskId ? `<button class="text-button" type="button" data-action="open-task" data-id="${escape(selected.taskId)}">查看起草任务</button>` : ''}${selected?.replyDraft ? '<button class="secondary-button compact" type="button" data-action="wechat-use-draft">填入 AI 草稿</button>' : ''}<button class="secondary-button compact" type="button" data-action="wechat-draft" ${state.wechatBusy || !selected || selected.outgoing === true || selected.direction === 'outgoing' || selected.isSelf ? 'disabled' : ''}>${icon('spark')}${state.wechatBusy === 'draft' ? '正在创建…' : '请 AI 起草'}</button><button class="secondary-button compact" type="button" data-action="wechat-stickers" ${disabled ? 'disabled' : ''}>${state.wechatStickerPanel ? '收起表情' : '表情'}</button></div></div><textarea id="wechat-reply" name="reply" maxlength="12000" placeholder="需要自己回复时，在这里写信并点击发送。">${escape(state.wechatReply)}</textarea><div class="reply-footer"><small>${connection.state === 'ready' ? `手动发送给：${escape(conversation.name)} · ${state.wechat?.settings?.autoReply ? "DSH 已开启自动回复" : "自动回复未开启"}` : '当前未连接，编辑的文字会保留在此页面。'}</small><button class="primary-button" type="submit" ${disabled || !state.wechatReply.trim() ? 'disabled' : ''}>${icon('arrow')}${state.wechatBusy === 'send' ? '正在发送…' : '发送文字'}</button></div></form>${renderWechatAttachments(conversation)}${renderWechatStickerPicker(conversation)}</div></div></div>`;
}
const mailProviders = { qq: { name: 'QQ 邮箱', imap: 'imap.qq.com', smtp: 'smtp.qq.com', smtpPort:465 }, '163': { name: '163 邮箱', imap: 'imap.163.com', smtp: 'smtp.163.com', smtpPort:465 }, gmail: { name: 'Gmail', imap: 'imap.gmail.com', smtp: 'smtp.gmail.com', smtpPort:465 }, outlook: { name: 'Outlook', imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort:587 }, custom: { name: '其他邮箱 / 自定义', imap: '', smtp: '', smtpPort:465 } };
function mailAddressText(addresses = []) { return addresses.map(item => typeof item === 'string' ? item : item.name ? `${item.name} <${item.address}>` : item.address || '').filter(Boolean).join('，'); }
function mailMessages() { return (state.mail?.messages || []).filter(message=>!state.mailAccountId || message.accountId===state.mailAccountId).sort((a,b)=>new Date(b.date)-new Date(a.date)); }
function selectedMailMessage() { const messages = mailMessages(); const selected=messages.find(message=>message.id===state.mailMessageId)||messages[0]; if(selected)state.mailMessageId=selected.id; return selected; }
function mailAccountName(id) { const account = state.mail?.accounts?.find(item => item.id === id); return account ? account.name || account.address : '邮箱账号'; }
function mailDraftStatus(status) { return ({ draft: '已保存 · 未发送', sending: '正在发送', 'smtp-accepted': '已提交邮件服务器', unconfirmed: '结果待核对' })[status] || '状态待核对'; }
function mailReplyTask(message) { return state.tasks.find(task=>task.id===state.mailDraftTasks[message?.id]); }
function renderMail() {
  const accounts = state.mail?.accounts || [];
  return `<div class="page-heading"><div><h1>${icon('mail')}邮箱通信</h1><p>多个邮箱分开管理，在这里收取邮件、起草和发送。</p></div><button class="secondary-button" data-action="mail-new" ${!accounts.some(account=>account.smtp) || state.mailBusy ? 'disabled' : ''}>${icon('doc')}写新邮件</button></div>${state.mailError ? `<div class="load-error" role="alert">${escape(state.mailError)}</div>` : ''}<div class="xp-tabs" role="tablist" aria-label="邮箱功能">${[['inbox','收件箱'],['compose','草稿与写信'],['accounts','邮箱账号']].map(([id,name])=>`<button id="mail-tab-${id}" role="tab" aria-selected="${state.mailTab===id}" aria-controls="mail-panel" class="${state.mailTab===id?'active':''}" data-action="mail-tab" data-tab="${id}">${icon(id==='accounts'?'settings':id==='compose'?'doc':'mail')}${name}</button>`).join('')}<button class="tab-refresh" data-action="mail-refresh">${icon('refresh')}刷新</button></div><section id="mail-panel" class="tab-panel mail-panel" role="tabpanel" aria-labelledby="mail-tab-${state.mailTab}">${state.mailTab==='accounts'?renderMailAccounts():state.mailTab==='compose'?renderMailCompose():renderMailInbox()}</section>`;
}
function renderMailInbox() {
  const accounts=state.mail?.accounts||[];
  if(!accounts.length)return `<div class="wechat-empty"><div class="empty-icon">${icon('mail')}</div><h2>添加你的第一个邮箱</h2><p>支持标准 IMAP / SMTP 邮箱，可添加多个账号。<br>部分服务商需要先开通邮件协议，并生成专用授权码。</p><button class="primary-button" data-action="mail-tab" data-tab="accounts">${icon('settings')}添加或导入账号</button></div>`;
  const selected=selectedMailMessage();
  const messages=mailMessages();
  const task=mailReplyTask(selected);
  const bodyLabels={truncated:'正文较长，当前显示已读取的部分。','omitted-size-limit':'邮件过大，暂未读取正文与附件。',unavailable:'正文未能读取，请检查邮箱后重新收取。'};
  return `<div class="mail-inbox-toolbar"><label for="mail-account-filter">查看邮箱</label><select id="mail-account-filter"><option value="">全部账号</option>${accounts.map(account=>`<option value="${escape(account.id)}" ${state.mailAccountId===account.id?'selected':''}>${escape(account.name||account.address)}</option>`).join('')}</select><button class="secondary-button" data-action="mail-sync" ${state.mailBusy?'disabled':''}>${icon('refresh')}${state.mailBusy==='sync'?'正在收取…':'收取邮件'}</button><small>最近 50 封，不自动标记已读</small></div><div class="mail-inbox"><aside class="mail-message-list" aria-label="邮件列表">${messages.length?messages.map(message=>`<button class="mail-message-row ${message.id===selected?.id?'active':''}" data-action="mail-message" data-id="${escape(message.id)}"><strong>${message.unread?'<span class="mail-unread-dot" aria-label="未读"></span>':''}${escape(message.subject||'（无主题）')}</strong><span>${escape(mailAddressText(message.from))}</span><small>${escape(mailAccountName(message.accountId))} · ${formatTime(message.date)}</small></button>`).join(''):'<div class="mail-empty-list">暂无邮件。点击“收取邮件”从邮箱读取。</div>'}</aside><article class="mail-reading-pane">${selected?`<header><h2>${escape(selected.subject||'（无主题）')}</h2><dl><div><dt>发件人</dt><dd>${escape(mailAddressText(selected.from))}</dd></div><div><dt>收件人</dt><dd>${escape(mailAddressText(selected.to))}</dd></div><div><dt>时间</dt><dd>${formatTime(selected.date,true)} · ${escape(mailAccountName(selected.accountId))}</dd></div></dl><div class="mail-reading-actions"><button class="secondary-button compact" data-action="mail-reply">${icon('doc')}回复</button><button class="secondary-button compact" data-action="mail-ai-draft" ${state.mailBusy?'disabled':''}>${icon('spark')}请 AI 起草</button>${task?`<button class="text-button" data-action="open-task" data-id="${escape(task.id)}">查看起草任务</button>`:''}${task?.status==='succeeded'&&task.summary?'<button class="secondary-button compact" data-action="mail-use-draft">填入 AI 草稿</button>':''}</div></header>${bodyLabels[selected.bodyStatus]?`<p class="mail-body-note">${escape(bodyLabels[selected.bodyStatus])}</p>`:''}<div class="mail-body">${escape(selected.text||'本封邮件暂无可显示的文字正文。')}</div>${selected.attachments?.length?`<div class="mail-attachments"><strong>附件 ${selected.attachments.length} 个</strong>${selected.attachments.map(attachment=>`<button class="secondary-button" data-action="mail-attachment" data-message-id="${escape(selected.id)}" data-id="${escape(attachment.id)}" ${state.mailBusy||attachment.unavailable?'disabled':''}>${icon('attach')}${escape(attachment.name||'附件')} · 另存为 <small>${fileSize(attachment.size)}${attachment.unavailable?' · 暂未读取':''}</small></button>`).join('')}<p>点击附件可另存到你选择的位置。</p></div>`:''}${state.mailAttachment?.messageId===selected.id?`<div class="mail-attachment-info"><strong>${escape(state.mailAttachment.name)}</strong><span>${fileSize(state.mailAttachment.size)}</span><label>本机保存位置<input type="text" readonly value="${escape(state.mailAttachment.path)}"/></label></div>`:''}`:'<div class="wechat-thread-empty">'+icon('mail')+'<strong>选择一封邮件阅读</strong><p>正文以纯文字显示。</p></div>'}</article></div>`;
}
function renderMailCompose() {
  const draft=state.mailCompose,saved=state.mailSavedDraft;
  const accounts=state.mail?.accounts||[];
  if(!draft.accountId&&accounts.length)draft.accountId=(accounts.find(account=>account.smtp)||accounts[0]).id;
  const busy=Boolean(state.mailBusy);
  return `<div class="mail-compose-layout"><section class="mail-compose-main"><h2>写邮件</h2><form id="mail-compose-form"><fieldset ${busy?'disabled':''}><label class="field"><span>发件邮箱</span><select id="mail-compose-account" name="accountId" required ${draft.inReplyTo?'disabled':''}>${accounts.map(account=>`<option value="${escape(account.id)}" ${draft.accountId===account.id?'selected':''}>${escape(account.name||account.address)}</option>`).join('')}</select>${draft.inReplyTo?'<small>回复使用原来的收信邮箱。</small>':''}</label><label class="field"><span>收件人</span><input id="mail-compose-to" name="to" value="${escape(draft.to)}" placeholder="name@example.com，多个地址用逗号分隔" required/></label><details class="mail-recipient-details"><summary>抄送与密送</summary><div class="two-fields"><label class="field"><span>抄送</span><input id="mail-compose-cc" name="cc" value="${escape(draft.cc)}"/></label><label class="field"><span>密送</span><input id="mail-compose-bcc" name="bcc" value="${escape(draft.bcc)}"/></label></div></details><label class="field"><span>主题</span><input id="mail-compose-subject" name="subject" value="${escape(draft.subject)}" maxlength="998"/></label><label class="field"><span>正文</span><textarea id="mail-compose-text" name="text" maxlength="100000" placeholder="在这里写下邮件内容，保存草稿后再发送。" required>${escape(draft.text)}</textarea></label></fieldset><div class="mail-compose-note">${saved?pill(mailDraftStatus(saved.status),saved.status==='smtp-accepted'?'':'neutral'):'<span>编辑后的内容需要重新保存草稿。</span>'}${saved?.error?`<p class="send-error">${escape(saved.error)}</p>`:''}${saved?.receipt?.rejected?.length?`<p class="send-error">服务器未接受：${saved.receipt.rejected.map(escape).join('，')}</p>`:''}</div><div class="settings-footer"><p>${saved?.status==='unconfirmed'?'请先在邮箱中核对发送结果；这份草稿不会再次提交。':'先保存，再发送。服务器接收不等于对方已收到或阅读。'}</p><div><button class="secondary-button" type="submit" ${busy||!accounts.length||(saved&&saved.status!=='draft')?'disabled':''}>${icon('doc')}${state.mailBusy==='draft-save'?'正在保存…':'保存草稿'}</button><button class="primary-button" type="button" data-action="mail-send" ${busy||saved?.status!=='draft'||!accounts.find(account=>account.id===draft.accountId)?.smtp?'disabled':''}>${icon('arrow')}${state.mailBusy==='send'?'正在发送…':'发送已保存的草稿'}</button></div></div></form></section><aside class="mail-draft-list"><h3>草稿与发送记录</h3>${(state.mail?.drafts||[]).length?state.mail.drafts.map(item=>`<button data-action="mail-open-draft" data-id="${escape(item.id)}"><strong>${escape(item.subject||'（无主题）')}</strong><span>${escape(mailDraftStatus(item.status))}</span><small>${formatTime(item.createdAt,true)}</small></button>`).join(''):'<p>保存后的草稿和发送回执会保留在这里。</p>'}</aside></div>`;
}
function defaultMailAccount(provider='qq') {
  const preset=mailProviders[provider]||mailProviders.custom;
  return {provider,address:'',name:'',username:'',authType:'password',secret:'',imapHost:preset.imap,imapPort:993,imapSecure:true,mailbox:'INBOX',smtpEnabled:true,smtpHost:preset.smtp,smtpPort:preset.smtpPort,smtpSecure:preset.smtpPort===465,smtpUsername:'',separateSmtpAuth:false,smtpAuthType:'password',smtpSecret:''};
}
function renderMailAccounts() {
  const accounts=state.mail?.accounts||[];
  const draft=state.mailAccountDraft||(state.mailAccountDraft=defaultMailAccount());
  const busy=Boolean(state.mailBusy);
  return `<div class="extension-toolbar"><div><h2>我的邮箱账号</h2><p>支持标准 IMAP / SMTP。可逐个添加，也可导入账号 JSON 文件。</p></div><button class="secondary-button" data-action="mail-import" ${busy||!state.mail?'disabled':''}>${icon('folder')}导入邮箱账号</button></div><div class="mail-account-cards">${accounts.map(account=>`<article class="mail-account-card"><div>${icon('mail')}<span><strong>${escape(account.name||account.address)}</strong><small>${escape(account.address)}</small></span>${pill(account.status==='ready'?'最近收取成功':account.status==='error'?'连接需检查':'已保存 · 待收取',account.status==='ready'?'':account.status==='error'?'error':'neutral')}</div><p>${escape(account.error||(account.lastSyncAt?`最近收取：${formatTime(account.lastSyncAt,true)}`:'手动收取邮件时验证连接。'))}</p><footer><button class="secondary-button compact" data-action="mail-account-sync" data-id="${escape(account.id)}" ${busy||account.busy?'disabled':''}>${icon('refresh')}收取并检查连接</button><button class="secondary-button compact" data-action="mail-account-edit" data-id="${escape(account.id)}" ${busy||account.busy?'disabled':''}>更新账号配置</button></footer></article>`).join('')}</div><form id="mail-account-form" class="mail-account-form"><div class="section-heading"><h2>${draft.id?'更新邮箱账号':'添加邮箱账号'}</h2>${draft.id?'<button class="text-button" type="button" data-action="mail-account-new">添加其他邮箱</button>':''}</div><fieldset ${busy||!state.mail?'disabled':''}><div class="two-fields"><label class="field"><span>邮箱类型</span><select id="mail-provider" name="provider">${Object.entries(mailProviders).map(([id,preset])=>`<option value="${id}" ${draft.provider===id?'selected':''}>${preset.name}</option>`).join('')}</select></label><label class="field"><span>邮箱地址</span><input id="mail-account-address" name="address" type="email" value="${escape(draft.address)}" placeholder="name@example.com" ${draft.id?'readonly':''} required/></label><label class="field"><span>显示名称</span><input id="mail-account-name" name="name" value="${escape(draft.name)}" placeholder="例如：工作邮箱" maxlength="100"/></label><label class="field"><span>收件登录用户名</span><input id="mail-account-username" name="username" value="${escape(draft.username)}" placeholder="留空时使用邮箱地址"/></label><label class="field"><span>授权方式</span><select id="mail-auth-type" name="authType"><option value="password" ${draft.authType==='password'?'selected':''}>邮箱授权码 / 密码</option><option value="oauth2" ${draft.authType==='oauth2'?'selected':''}>已有 OAuth 访问令牌</option></select></label><label class="field"><span>${draft.authType==='oauth2'?'OAuth 访问令牌':'邮箱密码或专用授权码'}</span><input id="mail-account-secret" name="secret" type="password" value="${escape(draft.secret)}" autocomplete="new-password" placeholder="${draft.id?'更新配置需要重新提供凭据':'保存后不回显'}" required/></label></div><p class="field-help">${draft.authType==='oauth2'?'接收已经取得的访问令牌；当前没有网页登录与令牌自动刷新。':'请先在邮箱设置中开启 IMAP / SMTP。QQ、163、Gmail 等可能需要专用授权码；Outlook 等可能要求 OAuth。'}</p><details class="mail-protocol-settings" ${draft.provider==='custom'?'open':''}><summary>服务器与收取文件夹</summary><div class="mail-endpoint-fields"><div><h3>收件 IMAP</h3><label class="field"><span>服务器</span><input id="mail-imap-host" name="imapHost" value="${escape(draft.imapHost)}" required/></label><div class="mail-endpoint-port"><label class="field"><span>端口</span><input id="mail-imap-port" name="imapPort" type="number" min="1" max="65535" value="${draft.imapPort}" required/></label><label class="mail-secure"><input id="mail-imap-secure" name="imapSecure" type="checkbox" ${draft.imapSecure?'checked':''}/>直接 TLS</label></div><label class="field"><span>收取文件夹</span><input id="mail-mailbox" name="mailbox" value="${escape(draft.mailbox)}"/></label></div><div><h3>发件 SMTP</h3><label class="mail-secure"><input id="mail-smtp-enabled" name="smtpEnabled" type="checkbox" ${draft.smtpEnabled?'checked':''}/>启用发件</label><label class="field"><span>服务器</span><input id="mail-smtp-host" name="smtpHost" value="${escape(draft.smtpHost)}" ${draft.smtpEnabled?'required':'disabled'}/></label><div class="mail-endpoint-port"><label class="field"><span>端口</span><input id="mail-smtp-port" name="smtpPort" type="number" min="1" max="65535" value="${draft.smtpPort}" ${draft.smtpEnabled?'required':'disabled'}/></label><label class="mail-secure"><input id="mail-smtp-secure" name="smtpSecure" type="checkbox" ${draft.smtpSecure?'checked':''} ${draft.smtpEnabled?'':'disabled'}/>直接 TLS</label></div><label class="field"><span>发件登录用户名</span><input id="mail-smtp-username" name="smtpUsername" value="${escape(draft.smtpUsername)}" placeholder="留空时使用收件登录用户名" ${draft.smtpEnabled?'':'disabled'}/></label></div></div><p class="field-help">未勾选“直接 TLS”时，会使用 STARTTLS 升级加密连接。</p><label class="mail-secure"><input id="mail-separate-smtp" name="separateSmtpAuth" type="checkbox" ${draft.separateSmtpAuth?'checked':''} ${draft.smtpEnabled?'':'disabled'}/>发件使用另一套凭据</label>${draft.separateSmtpAuth&&draft.smtpEnabled?`<div class="two-fields"><label class="field"><span>发件授权方式</span><select id="mail-smtp-auth-type" name="smtpAuthType"><option value="password" ${draft.smtpAuthType==='password'?'selected':''}>授权码 / 密码</option><option value="oauth2" ${draft.smtpAuthType==='oauth2'?'selected':''}>OAuth 访问令牌</option></select></label><label class="field"><span>发件凭据</span><input id="mail-smtp-secret" name="smtpSecret" type="password" value="${escape(draft.smtpSecret)}" autocomplete="new-password" required/></label></div>`:''}</details></fieldset><div class="settings-footer"><p>凭据由 Windows 安全保存。配置更新时需重新提供凭据。</p><button class="primary-button" type="submit" ${busy||!state.mail?'disabled':''}>${icon('check')}${state.mailBusy==='account-save'?'正在保存…':'保存邮箱账号'}</button></div></form>`;
}
function renderSettings() {
  const settings = state.settings;
  const runtime = state.bootstrap?.runtime || {};
  const health = runtimeState();
  return `<div class="page-heading"><div><h1>${icon('settings')}控制面板</h1><p>设置助手的身份、工作习惯与小助手 DSH 连接。</p></div></div><form id="settings-form"><input type="hidden" name="runtimeMode" value="hosted"/><div class="settings-layout"><section class="settings-card"><h2>${icon('heart')}身份与人格</h2><p>这些设置会用于后续工作，让小助手在不同任务中保持持续的身份。</p><label class="field"><span>她的名字</span><input name="assistantName" value="${escape(settings.assistantName || state.bootstrap?.identity?.name || '小助手')}" maxlength="30" required autocomplete="off"/><small>你可以继续叫她小助手，也可以取一个亲切的名字。</small></label><label class="field"><span>你希望她怎样陪你做事</span><textarea name="persona" maxlength="6000" placeholder="例如：温暖、直接、细心。遇到问题先尝试解决，工作结果要有依据。">${escape(settings.persona || state.bootstrap?.identity?.persona || '')}</textarea><small>写下语气、习惯和工作偏好。</small></label></section><section class="settings-card"><h2>${icon('engine')}小助手 DSH</h2><div class="dsh-core-card"><span class="dsh-core-icon">${icon('engine')}</span><div><strong>沿用 Harness 现有登录</strong><p>她的持续身份、对话和工作由 DSH 核心组织。已有账户会由 Harness 管理，无需再次填写密钥。</p></div></div><div class="engine-details">${pill(health.label, health.style)}<div>${escape(health.description)}</div>${hasSharedHarnessAccount() ? `<dl class="dsh-account-details"><div><dt>账户来源</dt><dd>Harness 现有登录</dd></div>${runtime.provider ? `<div><dt>模型服务</dt><dd>${escape(runtime.provider)}</dd></div>` : ''}${runtime.model ? `<div><dt>当前模型</dt><dd>${escape(runtime.model)}</dd></div>` : ''}<div><dt>真实模型验证</dt><dd>${runtime.modelVerified || runtime.ready ? '已有实际回复' : '可提交任务，等待首次验证'}</dd></div></dl>` : '<p class="field-help">启动已登录的 Harness 并启用小助手宿主插件后，点击重新检测。</p>'}<button type="button" class="secondary-button" data-action="detect-engine">${icon('refresh')}重新检测 DSH 连接</button></div><details class="runtime-advanced"><summary>高级：程序位置与独立工作目录</summary><label class="field"><span>Harness 程序</span><input name="runtimeCommand" value="${escape(settings.runtimeCommand || runtime.command || '')}" placeholder="自动发现，或填写 dsh 程序路径" autocomplete="off" spellcheck="false"/></label><input type="hidden" name="runtimeProfile" value="sdk"/><label class="field"><span>小助手工作目录</span><input name="runtimeHome" value="${escape(settings.runtimeHome || '')}" placeholder="使用小助手的默认目录" autocomplete="off" spellcheck="false"/></label>${runtime.endpoint ? `<p class="field-help">宿主接口：${escape(runtime.endpoint)}</p>` : ''}${runtime.detail && runtime.detail !== health.description ? `<p class="field-help">技术诊断：${escape(runtime.detail)}</p>` : ''}</details><details class="runtime-advanced"><summary>高级：额外模型 API 辅助配置</summary><p class="field-help">额外 API 可作为辅助能力配置；小助手的核心始终由 DSH 提供。保存密钥不会替代现有 Harness 登录。</p><label class="field"><span>额外模型 API 地址</span><input name="runtimeBaseUrl" value="${escape(settings.runtimeBaseUrl || 'https://api.deepseek.com/anthropic')}" type="url" autocomplete="off" spellcheck="false"/></label><label class="field"><span>额外模型服务密钥</span><input name="runtimeApiKey" type="password" value="" placeholder="${settings.runtimeCredentialConfigured ? '已保存；留空保持' : '可选，无需为 DSH 核心重复填写'}" autocomplete="new-password" spellcheck="false"/><small>保存后不回显，仅供显式配置的辅助能力使用。</small></label>${settings.runtimeCredentialConfigured ? '<button type="button" class="text-button" data-action="clear-key">清除额外密钥</button>' : ''}</details></section></div><div class="settings-footer"><p>设置保存在这台电脑。身份和偏好用于下一次工作。</p><button class="primary-button" id="save-settings" type="submit">${icon('check')}保存设置</button></div></form>`;
}
function renderAttachments() {
  const container = document.querySelector('#attachments');
  if (!container) return;
  container.innerHTML = state.attachments.map((file, index) => `<span class="attachment-chip">${icon('doc')}<span title="${escape(file.name)}">${escape(file.name)}</span><button type="button" data-action="remove-attachment" data-index="${index}" aria-label="移除${escape(file.name)}">${icon('close')}</button></span>`).join('');
}
function updateComposer() {
  const textarea = document.querySelector('#task-prompt');
  if (textarea) { textarea.value = state.prompt; textarea.maxLength = state.kind === 'literature' ? 500 : 18000; textarea.placeholder = state.kind === 'literature' ? '输入研究主题、论文标题或关键词，例如：quantum simulation Rydberg atoms' : '例如：帮我梳理这份材料，再拟一份回复…'; }
  const type = document.querySelector('#task-type');
  if (type) { type.value = state.kind; type.disabled = state.sending; }
  for (const element of document.querySelectorAll('.attachment-format-hint, #attachments, [data-action="attach"]')) element.hidden = state.kind === 'literature';
  const mode = document.querySelector('#composer-mode');
  if (mode) mode.textContent = state.kind === 'literature' ? '文献检索 · 真实来源' : state.kind === 'organize' ? '本地资料整理 · 无需 AI' : 'AI 对话与写作';
  const workMode = document.querySelector('#work-mode-slot');
  if (workMode) workMode.innerHTML = renderWorkMode();
  const skillPicker = document.querySelector('#skill-picker-slot');
  if (skillPicker) skillPicker.innerHTML = renderSkillPicker();
  const button = document.querySelector('#send-button');
  if (button) {
    button.disabled = state.sending;
    button.innerHTML = (state.sending ? '正在创建…' : state.kind === 'literature' ? '开始检索' : state.kind === 'organize' ? '开始整理' : '交给小助手') + icon('arrow');
  }
}
async function refresh({ initial = false, preserveForm = true } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const results = await Promise.allSettled([invoke('getBootstrap'), invoke('listTasks'), invoke('getSettings'), api && typeof api.getWechatState === 'function' ? invoke('getWechatState') : Promise.resolve(null), api && typeof api.getExtensionsState === 'function' ? invoke('getExtensionsState') : Promise.resolve(null), api && typeof api.getWorkflowsState === 'function' ? invoke('getWorkflowsState') : Promise.resolve(null), api && typeof api.getDshAccessState === 'function' ? invoke('getDshAccessState') : Promise.resolve(null), api && typeof api.getMailState === 'function' ? invoke('getMailState') : Promise.resolve(null)]);
    const errors = [];
    if (results[0].status === 'fulfilled') state.bootstrap = results[0].value;
    else errors.push(results[0].reason?.message || '无法连接桌面服务。');
    if (results[1].status === 'fulfilled') state.tasks = Array.isArray(results[1].value) ? [...results[1].value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) : [];
    else errors.push(results[1].reason?.message || '无法读取工作记录。');
    if (results[2].status === 'fulfilled') state.settings = results[2].value || {};
    else errors.push(results[2].reason?.message || '无法读取助手设置。');
    if (results[3].status === 'fulfilled') { applyWechatState(results[3].value); state.wechatError = results[3].value ? '' : '当前桌面服务尚未提供微信接口，请使用最新的小助手版本。'; }
    else state.wechatError = results[3].reason?.message || '无法读取微信连接状态。';
    if (results[4].status === 'fulfilled') { state.extensions = results[4].value; state.extensionsError = results[4].value ? '' : '当前桌面服务尚未提供扩展管理接口，请使用最新版本。'; }
    else state.extensionsError = results[4].reason?.message || '无法读取插件和技能状态。';
    const usableIds = new Set(usableTextSkills().map(skill => skill.id));
    state.skillIds = state.skillIds.filter(id => usableIds.has(id));
    if (results[5].status === 'fulfilled') { state.workflows = results[5].value; state.workflowsError = results[5].value ? '' : '当前服务尚未提供协作流程接口。'; }
    else state.workflowsError = results[5].reason?.message || '无法读取协作流程。';
    if (results[6].status === 'fulfilled') { state.dshAccess = results[6].value; state.dshAccessError = ''; if (!state.dshGrantsDirty) state.dshGrantDraft = null; }
    else state.dshAccessError = results[6].reason?.message || '无法读取 DSH 主人授权。';
    if (results[7].status === 'fulfilled') { state.mail = results[7].value; state.mailError = results[7].value ? '' : '当前服务尚未提供邮件接口。'; if (state.mailSavedDraft) state.mailSavedDraft = state.mail?.drafts?.find(draft=>draft.id===state.mailSavedDraft.id) || state.mailSavedDraft; }
    else state.mailError = results[7].reason?.message || '无法读取邮件插件状态。';
    state.loading = false;
    state.error = [...new Set(errors)].join(' ');
    if (initial || !preserveForm) renderShell();
    else updateVisibleData();
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
function applyWechatState(value) {
  const account = String(value?.settings?.boundAccountId || value?.profile?.wxid || '');
  if (account && state.wechatAccountKey && account !== state.wechatAccountKey) {
    state.selectedMessageId = null; state.selectedConversationKey = ''; state.wechatReply = ''; state.wechatReplyByConversation = {};
    state.wechatContactResults = { private: [], groups: [] }; state.wechatContactNames = {}; state.wechatAllowedDraft = null; state.wechatContactsSearched = false;
    state.wechatHistoryLoaded = {}; state.wechatImages = {}; state.wechatStickers = {}; state.wechatStickerPanel = false; state.wechatSendAttempts = {}; state.wechatAttachmentsByConversation = {};
  }
  if (account) state.wechatAccountKey = account;
  state.wechat = value;
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
  const sidebarStatus = document.querySelector('#sidebar-runtime');
  if (sidebarStatus) sidebarStatus.innerHTML = pill(runtime.label, runtime.style);
  const recent = document.querySelector('#recent-tasks');
  if (recent) recent.innerHTML = renderTaskList(state.tasks.slice(0, 4), 'home');
  const workMode = document.querySelector('#work-mode-slot');
  if (workMode) workMode.innerHTML = renderWorkMode();
  const skillPicker = document.querySelector('#skill-picker-slot');
  if (skillPicker) skillPicker.innerHTML = renderSkillPicker();
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
  if (['tasks', 'capabilities', 'workers'].includes(state.page)) renderPage();
  if (state.page === 'wechat') renderWechatPreservingFocus();
  if (state.page === 'mail') renderMailPreservingFocus();
  if (state.selectedTask) loadTask(state.selectedTask, false);
}
function navigate(page) {
  if (!Object.hasOwn(pageTitles, page)) return;
  state.page = page;
  state.settingsDirty = false;
  renderShell();
  document.querySelector('#main')?.focus({ preventScroll: true });
}
function renderMailPreservingFocus() {
  const current=document.activeElement;
  const focus=current?.closest('#mail-panel')&&current.id?{id:current.id,start:current.selectionStart,end:current.selectionEnd}:null;
  const readerScroll=document.querySelector('.mail-reading-pane')?.scrollTop;
  const listScroll=document.querySelector('.mail-message-list')?.scrollTop;
  const openDetails=[...document.querySelectorAll('#mail-panel details[open]')].map(node=>node.className);
  renderPage();
  for(const name of openDetails)document.querySelector(`#mail-panel details.${name}`)?.setAttribute('open','');
  const reader=document.querySelector('.mail-reading-pane');if(reader)reader.scrollTop=readerScroll||0;
  const list=document.querySelector('.mail-message-list');if(list)list.scrollTop=listScroll||0;
  if(focus){const next=document.getElementById(focus.id);next?.focus({preventScroll:true});try{if(focus.start!==null)next?.setSelectionRange(focus.start,focus.end);}catch{}}
}
function readMailAccountForm(form) {
  const data=new FormData(form),previous=state.mailAccountDraft||defaultMailAccount();
  const text=(name)=>data.has(name)?String(data.get(name)||'').trim():previous[name]||'';
  return {...previous,provider:text('provider'),address:text('address'),name:text('name'),username:text('username'),authType:text('authType'),secret:text('secret'),imapHost:text('imapHost'),imapPort:Number(text('imapPort')),imapSecure:data.has('imapSecure'),mailbox:text('mailbox')||'INBOX',smtpEnabled:data.has('smtpEnabled'),smtpHost:text('smtpHost'),smtpPort:Number(text('smtpPort')),smtpSecure:data.has('smtpSecure'),smtpUsername:text('smtpUsername'),separateSmtpAuth:data.has('separateSmtpAuth'),smtpAuthType:text('smtpAuthType')||'password',smtpSecret:text('smtpSecret')};
}
function readMailComposeForm(form) {
  const data=new FormData(form);
  return {...state.mailCompose,...Object.fromEntries(['accountId','to','cc','bcc','subject','text'].map(name=>[name,data.has(name)?String(data.get(name)||''):state.mailCompose[name]||'']))};
}
async function mailOperation(name,operation) {
  if(state.mailBusy)return;
  state.mailBusy=name;if(state.page==='mail')renderMailPreservingFocus();
  try{await operation();await refresh();}
  catch(error){notify(error.message||'邮件操作没有完成。',true);await refresh();}
  finally{state.mailBusy='';if(state.page==='mail')renderMailPreservingFocus();}
}
async function saveMailAccount(event) {
  event.preventDefault();if(state.mailBusy)return;
  const draft=readMailAccountForm(event.target);
  state.mailAccountDraft=draft;
  const auth=(type,secret)=>type==='oauth2'?{type:'oauth2',accessToken:secret}:{type:'password',password:secret};
  const address=draft.address.trim(),username=draft.username||address;
  const account={...(draft.id?{id:draft.id}:{}),name:draft.name||address,address,imap:{host:draft.imapHost,port:draft.imapPort,secure:draft.imapSecure,username,mailbox:draft.mailbox},smtp:draft.smtpEnabled?{host:draft.smtpHost,port:draft.smtpPort,secure:draft.smtpSecure,username:draft.smtpUsername||username}:null,auth:auth(draft.authType,draft.secret),...(draft.smtpEnabled&&draft.separateSmtpAuth?{smtpAuth:auth(draft.smtpAuthType,draft.smtpSecret)}:{})};
  await mailOperation('account-save',async()=>{await invoke('importMailAccounts',{accounts:[account]});state.mailAccountDraft=null;notify('邮箱账号已保存。点击收取邮件验证连接。');});
}
async function syncMailAccounts(accountId=state.mailAccountId) {
  const accounts=(state.mail?.accounts||[]).filter(account=>!accountId||account.id===accountId);
  if(!accounts.length)return;
  await mailOperation('sync',async()=>{
    const errors=[];let received=0;
    for(const account of accounts){try{const result=await invoke('syncMail',{accountId:account.id,limit:50});received+=result?.received||0;}catch(error){errors.push(`${account.name||account.address}：${error.message}`);}}
    if(errors.length)notify(errors.join('；'),true);else notify(`已读取最近的 ${received} 封邮件，没有自动标记已读。`);
  });
}
function newMail() {
  state.mailCompose={accountId:(state.mail?.accounts||[]).find(account=>account.smtp)?.id||'',to:'',cc:'',bcc:'',subject:'',text:'',inReplyTo:''};
  state.mailSavedDraft=null;state.mailTab='compose';renderPage();document.querySelector('#mail-compose-to')?.focus();
}
function replyMail(useAI=false) {
  const message=selectedMailMessage();if(!message)return;
  const task=mailReplyTask(message);
  state.mailCompose={accountId:message.accountId,to:(message.from||[]).map(item=>item.address).filter(Boolean).join(', '),cc:'',bcc:'',subject:/^re\s*:/i.test(message.subject)?message.subject:`Re: ${message.subject||''}`,text:useAI&&task?.status==='succeeded'?task.summary:'',inReplyTo:message.id};
  state.mailSavedDraft=null;state.mailTab='compose';renderPage();document.querySelector('#mail-compose-text')?.focus();
}
async function saveMailDraft(event) {
  event.preventDefault();if(state.mailBusy)return;
  state.mailCompose=readMailComposeForm(event.target);
  const draft=state.mailCompose,addresses=value=>value.split(/[\s,，;；]+/).map(item=>item.trim()).filter(Boolean);
  await mailOperation('draft-save',async()=>{
    state.mailSavedDraft=await invoke('createMailDraft',{accountId:draft.accountId,to:addresses(draft.to),cc:addresses(draft.cc),bcc:addresses(draft.bcc),subject:draft.subject,text:draft.text,...(draft.inReplyTo?{inReplyTo:draft.inReplyTo}:{})});
    notify('草稿已保存，尚未发送。请核对后点击发送。');
  });
}
async function sendMailDraft() {
  const draft=state.mailSavedDraft;if(!draft||draft.status!=='draft'||state.mailBusy)return;
  await mailOperation('send',async()=>{
    const result=await invoke('sendMailDraft',{draftId:draft.id});
    if(state.mailSavedDraft?.id===draft.id)state.mailSavedDraft=result;
    notify(result?.status==='smtp-accepted'?'邮件已提交服务器，请在邮箱中核对发送结果。':result?.error||'发送结果待核对，不会再次提交同一份草稿。',result?.status!=='smtp-accepted');
  });
}
function openMailDraft(id) {
  const draft=state.mail?.drafts?.find(item=>item.id===id);if(!draft)return;
  const source=(state.mail.messages||[]).find(message=>message.accountId===draft.accountId&&message.messageId===draft.inReplyTo);
  state.mailCompose={accountId:draft.accountId,to:(draft.to||[]).join(', '),cc:(draft.cc||[]).join(', '),bcc:(draft.bcc||[]).join(', '),subject:draft.subject||'',text:draft.text||'',inReplyTo:source?.id||''};
  state.mailSavedDraft=draft;state.mailTab='compose';renderPage();
}
function editMailAccount(id) {
  const account=state.mail?.accounts?.find(item=>item.id===id);if(!account)return;
  state.mailAccountDraft={...defaultMailAccount('custom'),id:account.id,name:account.name,address:account.address,username:account.imap.username,imapHost:account.imap.host,imapPort:account.imap.port,imapSecure:account.imap.secure,mailbox:account.imap.mailbox,smtpEnabled:!!account.smtp,smtpHost:account.smtp?.host||'',smtpPort:account.smtp?.port||465,smtpSecure:account.smtp?.secure!==false,smtpUsername:account.smtp?.username||''};
  state.mailTab='accounts';renderPage();document.querySelector('#mail-account-form')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function renderWechatPreservingFocus() {
  const focused = document.activeElement;
  const field = focused?.matches('input, textarea') ? { id: focused.id, name: focused.name, start: focused.selectionStart, end: focused.selectionEnd } : null;
  const oldThread = document.querySelector('.message-thread');
  const threadScroll = oldThread?.scrollTop;
  const wasNearEnd = oldThread ? oldThread.scrollHeight - oldThread.clientHeight - oldThread.scrollTop < 40 : true;
  const listScroll = document.querySelector('.conversation-list')?.scrollTop;
  renderPage();
  const thread = document.querySelector('.message-thread');
  if (thread) thread.scrollTop = wasNearEnd ? thread.scrollHeight : threadScroll || 0;
  const list = document.querySelector('.conversation-list');
  if (list) list.scrollTop = listScroll || 0;
  if (field) {
    const next = field.id ? document.getElementById(field.id) : document.querySelector(`#wechat-settings-form [name="${field.name}"]`);
    next?.focus({ preventScroll: true });
    try { if (field.start !== null) next?.setSelectionRange(field.start, field.end); } catch { /* URL fields do not expose text selection. */ }
  }
}
function selectWechatMessage(id) {
  const messages = wechatMessages();
  const previous = selectedWechatMessage();
  const selected = messages.find(message => message.id === id);
  if (!selected) return;
  const key = message => `${message.kind}:${message.conversationId}`;
  if (previous) state.wechatReplyByConversation[key(previous)] = state.wechatReply;
  state.selectedMessageId = selected.id;
  if (!previous || key(previous) !== key(selected)) state.wechatReply = state.wechatReplyByConversation[key(selected)] || '';
  state.selectedConversationKey = key(selected);
  renderPage();
  const thread = document.querySelector('.message-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}
function selectWechatConversation(key) {
  const conversation = wechatConversations().find(item => item.key === key);
  if (!conversation) return;
  if (state.selectedConversationKey) state.wechatReplyByConversation[state.selectedConversationKey] = state.wechatReply;
  state.selectedConversationKey = key;
  state.selectedMessageId = conversation.messages.find(message => !message.outgoing && message.direction !== 'outgoing' && !message.isSelf)?.id || null;
  state.wechatReply = state.wechatReplyByConversation[key] || '';
  state.wechatStickerPanel = false;
  renderPage();
  const thread = document.querySelector('.message-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}
async function loadWechatSessions() {
  await wechatOperation('sessions', async () => { await invoke('getWechatSessions', { limit: 500 }); });
}
async function loadWechatHistory() {
  const conversation = selectedWechatConversation();
  if (!conversation || !conversation.allowed) return;
  await wechatOperation('history', async () => {
    await invoke('getWechatHistory', { kind: conversation.kind, target: conversation.id, limit: 100 });
    state.wechatHistoryLoaded[conversation.key] = true;
  });
}
async function previewWechatImage(id) {
  const conversation = selectedWechatConversation();
  if (!conversation) return;
  const key = `${conversation.key}:${id}`;
  await wechatOperation(`image:${id}`, async () => {
    try {
      const result = await invoke('resolveWechatImage', { kind: conversation.kind, target: conversation.id, id });
      if (!/^image\/(?:png|jpeg|gif|webp|bmp)$/i.test(result?.mime || '') || typeof result?.b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.b64)) throw new Error('图片格式暂不支持。');
      state.wechatImages[key] = { uri: `data:${result.mime};base64,${result.b64}` };
    } catch (error) { state.wechatImages[key] = { error: error.message || '图片读取失败。' }; throw error; }
  });
}
async function searchWechatStickers() {
  const conversation = selectedWechatConversation();
  if (!conversation) return;
  await wechatOperation('stickers', async () => { state.wechatStickers[conversation.key] = await invoke('getWechatStickers', { kind: conversation.kind, target: conversation.id, query: state.wechatStickerQuery.trim() }); });
}
function wechatSendRequest(key, value) {
  const previous = state.wechatSendAttempts[key];
  if (previous?.value === value) return previous.requestId;
  const requestId = `request_${crypto.randomUUID()}`;
  state.wechatSendAttempts[key] = { value, requestId };
  return requestId;
}
async function pickWechatAttachments(mediaType) {
  const conversation = selectedWechatConversation();
  if (!conversation?.allowed || state.wechatBusy || wechatConnectionInfo().state !== 'ready' || !['image', 'file'].includes(mediaType)) return;
  const account = state.wechatAccountKey;
  await wechatOperation(`pick-${mediaType}`, async () => {
    const chosen = await invoke('pickWechatAttachments', { mediaType });
    if (!chosen?.length) return;
    if (account !== state.wechatAccountKey) throw new Error('微信账号已改变，请在当前账号下重新选择附件。');
    if (!Array.isArray(chosen) || chosen.some(item => typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !Number.isSafeInteger(item.size) || item.size < 0 || item.mediaType !== mediaType)) throw new Error('附件选择结果无效，请重新选择。');
    const attachments = state.wechatAttachmentsByConversation[conversation.key] ||= [];
    for (const item of chosen) if (!attachments.some(attachment => attachment.id === item.id)) attachments.push({ id: item.id, name: item.name, size: item.size, mediaType: item.mediaType, status: 'selected' });
  });
}
async function sendWechatAttachment(id) {
  const conversation = selectedWechatConversation();
  if (!conversation?.allowed || state.wechatBusy || wechatConnectionInfo().state !== 'ready') return;
  const attachment = state.wechatAttachmentsByConversation[conversation.key]?.find(item => item.id === id);
  if (!attachment) return;
  const status = wechatAttachmentStatus(conversation, attachment).status;
  if (!['selected', 'rejected'].includes(status)) return;
  const requestKey = `attachment:${conversation.key}:${attachment.id}`;
  if (status === 'rejected') delete state.wechatSendAttempts[requestKey];
  attachment.requestId = wechatSendRequest(requestKey, attachment.id);
  attachment.status = 'sending';
  attachment.error = '';
  await wechatOperation('attachment-send', async () => {
    try {
      const delivery = await invoke('sendWechatAttachment', { kind: conversation.kind, target: conversation.id, attachmentId: attachment.id, requestId: attachment.requestId });
      attachment.status = delivery?.status || 'unconfirmed';
      attachment.error = delivery?.error || '';
      notify(attachment.status === 'delivered' ? `${attachment.mediaType === 'image' ? '图片' : '文件'}已送达。` : delivery?.error || '附件发送已有记录，请查看回执；结果待核对时不会重复发送。', attachment.status !== 'delivered');
    } catch (error) {
      attachment.status = 'uncertain';
      attachment.error = error.message || '未能确认附件发送结果，请先核对微信记录。';
      throw error;
    }
  });
}
function removeWechatAttachment(id) {
  if (state.wechatBusy) return;
  const conversation = selectedWechatConversation();
  if (!conversation) return;
  state.wechatAttachmentsByConversation[conversation.key] = (state.wechatAttachmentsByConversation[conversation.key] || []).filter(item => item.id !== id);
  renderWechatPreservingFocus();
}
async function sendWechatSticker(stickerId) {
  const conversation = selectedWechatConversation();
  if (!conversation?.allowed || state.wechatBusy) return;
  const key = `sticker:${conversation.key}`;
  const requestId = wechatSendRequest(key, stickerId);
  await wechatOperation('sticker-send', async () => {
    const outgoing = await invoke('sendWechatSticker', { kind: conversation.kind, target: conversation.id, stickerId, requestId });
    if (['sent', 'succeeded', 'delivered'].includes(outgoing?.status)) { delete state.wechatSendAttempts[key]; notify('表情已提交微信接口，请核对微信中的发送结果。'); }
    else notify(outgoing?.error || '请查看表情发送状态，结果待核对时不会重复提交。', true);
  });
}
function readWechatSettings(form) {
  const data = new FormData(form);
  const current = state.wechatSettingsDraft || state.wechat?.settings || {};
  const ids = key => [...new Set(String(data.get(key) || '').split(/[\s,，;；]+/).map(id => id.trim()).filter(Boolean))];
  return { allowedPrivate: data.has('allowedPrivate') ? ids('allowedPrivate') : current.allowedPrivate || [], allowedGroups: data.has('allowedGroups') ? ids('allowedGroups') : current.allowedGroups || [], readerBaseUrl: data.has('readerBaseUrl') ? String(data.get('readerBaseUrl') || '').trim() : current.readerBaseUrl || '', hookBaseUrl: data.has('hookBaseUrl') ? String(data.get('hookBaseUrl') || '').trim() : current.hookBaseUrl || '' };
}
async function saveWechatAutomation(key, enabled) {
  if (!['autoReply', 'autoConnect'].includes(key) || state.wechatBusy) return;
  await wechatOperation(key, async () => {
    await invoke('saveWechatSettings', { [key]: enabled });
    const actual = await invoke('getWechatState');
    applyWechatState(actual);
    if (actual?.settings?.[key] !== enabled) throw new Error('微信设置尚未保存，请重试。');
    notify(key === 'autoReply' ? enabled ? '小助手 DSH 自动回复已开启。' : '小助手 DSH 自动回复已关闭。' : enabled ? '下次启动小助手时会自动连接微信。' : '下次启动自动连接已关闭。');
  });
}
async function saveWechatSettings(event) {
  event.preventDefault();
  if (state.wechatBusy) return;
  const settings = readWechatSettings(event.target);
  if ([...settings.allowedPrivate, ...settings.allowedGroups].some(id => !/^\d+$/.test(id))) { notify('保存的聊天范围需要重新选择，请前往好友与群聊。', true); return; }
  await wechatOperation('settings', async () => { await invoke('saveWechatSettings', settings); state.wechatSettingsDraft = null; notify('微信连接设置已保存。'); });
}
async function searchWechatContacts({ refresh: forceRefresh = false } = {}) {
  const kind = state.wechatContactKind;
  const keyword = state.wechatContactKeyword.trim();
  await wechatOperation('contacts', async () => {
    const result = await invoke('searchWechatContacts', { kind, keyword, refresh: forceRefresh });
    const contacts = Array.isArray(result?.contacts) ? result.contacts : [];
    state.wechatContactResults[kind] = contacts.map(contact => ({ ...contact, id: String(contact.id) }));
    for (const contact of contacts) if (contact.name) state.wechatContactNames[`${contact.kind || (kind === 'groups' ? 'group' : 'private')}:${contact.id}`] = contact.name;
    state.wechatContactsSearched = true;
  });
}
async function saveWechatContacts() {
  const selection = wechatAllowedSelection();
  const current = state.wechat?.settings || {};
  await wechatOperation('contacts-save', async () => {
    await invoke('saveWechatSettings', { allowedPrivate: selection.private, allowedGroups: selection.groups, readerBaseUrl: current.readerBaseUrl, hookBaseUrl: current.hookBaseUrl });
    state.wechatAllowedDraft = null;
    notify('好友与群聊范围已保存。小助手会按新的范围接收消息。');
  });
}
async function wechatOperation(name, operation) {
  if (state.wechatBusy) return;
  state.wechatBusy = name;
  if (state.page === 'wechat') renderWechatPreservingFocus();
  try { await operation(); await refresh(); }
  catch (error) { notify(error.message || '微信操作没有完成，请检查连接状态。', true); await refresh(); }
  finally { state.wechatBusy = ''; if (state.page === 'wechat') renderWechatPreservingFocus(); }
}
async function sendWechatReply(event) {
  event.preventDefault();
  const conversation = selectedWechatConversation();
  const message = selectedWechatMessage();
  const text = state.wechatReply.trim();
  if (!conversation?.allowed || !text || state.wechatBusy) return;
  const key = `text:${conversation.key}`;
  const requestId = wechatSendRequest(key, text);
  await wechatOperation('send', async () => {
    const outgoing = typeof api?.sendWechatMessage === 'function' ? await invoke('sendWechatMessage', { kind: conversation.kind, target: conversation.id, text, requestId }) : message ? await invoke('sendWechatReply', { messageId: message.id, text }) : null;
    if (!outgoing) throw new Error('当前服务尚未提供主动写信接口。');
    if (outgoing?.status === 'failed') { notify(outgoing.error || '发送失败，请查看发送记录。', true); return; }
    if (outgoing?.status === 'sent' || outgoing?.status === 'succeeded' || outgoing?.status === 'delivered') {
      if (state.selectedConversationKey === conversation.key && state.wechatReply.trim() === text) state.wechatReply = '';
      state.wechatReplyByConversation[conversation.key] = '';
      delete state.wechatSendAttempts[key];
      notify(outgoing.status === 'delivered' ? '回复已送达。' : '回复已提交本地微信接口，请核对微信中的发送结果。');
    } else notify('发送请求已有记录，请查看会话中的发送状态并核对微信结果。');
  });
}
async function extensionOperation(name, operation) {
  if (state.extensionsBusy) return;
  state.extensionsBusy = name;
  if (state.page === 'capabilities') renderPage();
  try { await operation(); await refresh(); }
  catch (error) { notify(error.message || '扩展操作没有完成，请检查诊断信息。', true); await refresh(); }
  finally { state.extensionsBusy = ''; if (state.page === 'capabilities') renderPage(); }
}
async function saveMcpTools(event) {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.id;
  const allowedTools = new FormData(form).getAll('tools').map(String);
  await extensionOperation(`tools:${id}`, async () => {
    await invoke('setMcpTools', { id, allowedTools });
    delete state.mcpToolSelections[id];
    const report = state.mcpDiagnostics[id];
    if (report) for (const tool of report.tools || []) tool.authorized = allowedTools.includes(tool.name);
    notify('工具允许清单已保存。此操作没有调用工具。');
  });
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
  if (state.kind === 'literature' && (!state.prompt.trim() || state.prompt.trim().length > 500)) { notify('请填写 1 至 500 字的文献检索关键词。', true); return; }
  if (state.kind === 'organize' && !state.attachments.length) { notify('添加需要整理的文件后，就可以生成资料清单。'); await addAttachments(); if (!state.attachments.length) return; }
  state.sending = true;
  updateComposer();
  const textarea = document.querySelector('#task-prompt');
  if (textarea) textarea.disabled = true;
  try {
    const task = await invoke('createTask', { prompt: state.prompt.trim() || '请整理所选资料，生成清晰的文件清单。', attachmentPaths: state.kind === 'literature' ? [] : state.attachments.map((file) => file.path), kind: state.kind, skillIds: state.kind === 'agent' ? state.skillIds : [], ...(state.kind === 'agent' && state.workflowId !== 'single' ? { workflowId: state.workflowId } : {}) });
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
  root.innerHTML = `<div class="drawer-backdrop" data-action="close-task"></div><section class="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-detail-title"><header class="drawer-header"><span>${icon('tasks')} 工作详情</span><button class="icon-button" id="close-drawer" data-action="close-task" aria-label="关闭工作详情">${icon('close')}</button></header><div class="drawer-content">${state.detailLoading ? '<div class="loading-block" id="task-detail-title">正在读取工作详情…</div>' : state.detailError ? `<div class="task-error" id="task-detail-title">${escape(state.detailError)}</div><button class="secondary-button" data-action="retry-detail">重新读取</button>` : task ? `${taskPill(task.status)}<h2 class="drawer-heading" id="task-detail-title">${escape(task.title || '未命名工作')}</h2><p class="drawer-subtitle">${escape(taskTypeLabel(task))} · ${formatTime(task.createdAt, true)}${task.attachmentNames?.length ? ` · ${task.attachmentNames.length} 份资料` : ''}</p>${activeStatuses.has(task.status) ? `<progress class="task-progress" max="100" ${progress === null ? '' : `value="${progress}"`} aria-label="任务进度"></progress><div class="progress-label"><span>${escape(typeof task.progress === 'string' ? task.progress : statusLabels[task.status] || '处理中')}</span>${progress === null ? '' : `<span>${progress}%</span>`}</div>` : ''}<section class="drawer-section"><h3>${icon('chat')}你的托付</h3><div class="task-prompt">${escape(task.prompt || '整理所选资料。')}</div></section>${renderWorkerResult(state.detail?.workerResult)}${task.summary ? `<section class="drawer-section"><h3>${icon('spark')}小助手的反馈</h3><div class="task-summary">${escape(task.summary)}</div></section>` : ''}${task.error ? `<section class="drawer-section"><h3>需要处理的情况</h3><div class="task-error">${escape(task.error)}</div>${task.status === 'waiting_dependency' || /harness|引擎|密钥|api|credential|运行程序/i.test(task.error) ? '<button class="text-button" data-action="task-settings">前往引擎设置</button>' : ''}</section>` : ''}<section class="drawer-section"><h3>${icon('doc')}交给你的成果${artifacts.length ? ` · ${artifacts.length}` : ''}</h3>${renderDocumentExports(task)}${artifacts.length ? `<div class="artifact-list">${artifacts.map((artifact) => `<button class="artifact-button" data-action="open-artifact" data-id="${escape(artifact.id)}">${icon('doc')}<span><strong>${escape(artifact.name)}</strong><small>${escape(artifact.type || '文件')} · ${fileSize(artifact.size)}</small></span>${icon('external')}</button>`).join('')}</div>` : `<p class="muted-text">${activeStatuses.has(task.status) ? '小助手生成成果后，会保存在这里。' : '这项工作还没有生成可打开的文件。'}</p>`}</section><section class="drawer-section"><h3>${icon('clock')}处理过程</h3>${events.length ? `<ol class="event-list">${events.map((event) => `<li class="event-item"><p>${escape(event.message || event.type || '状态更新')}</p><time>${formatTime(event.createdAt, true)}</time></li>`).join('')}</ol>` : '<p class="muted-text">暂无处理记录。</p>'}</section>` : ''}</div><footer class="drawer-footer"><button class="secondary-button" data-action="task-workspace">${icon('folder')}打开工作目录</button>${task && activeStatuses.has(task.status) ? '<button class="danger-button" data-action="cancel-task">停止这项工作</button>' : ''}</footer></section>`;
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
  patch.runtimeMode = 'hosted';
  const key = String(data.get('runtimeApiKey') || '').trim();
  if (key) patch.runtimeApiKey = key;
  const button = document.querySelector('#save-settings');
  button.disabled = true;
  button.textContent = '正在保存…';
  try { await invoke('saveSettings', patch); state.settingsDirty = false; await refresh({ preserveForm: false }); notify('设置已保存。下一次工作会使用新的设置。'); }
  catch (error) { notify(error.message || '设置没有保存成功。', true); }
  finally { if (button.isConnected) { button.disabled = false; button.innerHTML = icon('check') + '保存设置'; } }
}

document.addEventListener('toggle', (event) => {
  if (event.target.id === 'wechat-connection-details') state.wechatConnectionExpanded = event.target.open;
}, true);

document.addEventListener('input', (event) => {
  if (event.target.closest('#mail-account-form')) state.mailAccountDraft=readMailAccountForm(event.target.closest('form'));
  if (event.target.closest('#mail-compose-form')) {state.mailCompose=readMailComposeForm(event.target.closest('form'));state.mailSavedDraft=null;const send=document.querySelector('[data-action="mail-send"]');if(send)send.disabled=true;const save=event.target.closest('form').querySelector('[type="submit"]');if(save)save.disabled=Boolean(state.mailBusy)||!state.mail?.accounts?.length;const note=document.querySelector('.mail-compose-note');if(note)note.textContent='编辑后的内容需要重新保存草稿。';}
  if (event.target.id === 'task-prompt') state.prompt = event.target.value;
  if (event.target.id === 'wechat-contact-keyword') state.wechatContactKeyword = event.target.value;
  if (event.target.id === 'wechat-sticker-query') state.wechatStickerQuery = event.target.value;
  if (event.target.closest('#settings-form')) state.settingsDirty = true;
  if (event.target.closest('#wechat-settings-form')) state.wechatSettingsDraft = readWechatSettings(event.target.closest('form'));
  if (event.target.id === 'wechat-reply') {
    state.wechatReply = event.target.value;
    const conversation = selectedWechatConversation();
    if (conversation) {
      state.wechatReplyByConversation[conversation.key] = state.wechatReply;
      if (state.wechatSendAttempts[`text:${conversation.key}`]?.value !== state.wechatReply.trim()) delete state.wechatSendAttempts[`text:${conversation.key}`];
    }
    const button = document.querySelector('#wechat-reply-form button[type="submit"]');
    if (button) button.disabled = Boolean(state.wechatBusy) || !conversation?.allowed || wechatConnectionInfo().state !== 'ready' || !state.wechatReply.trim();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'wechat-auto-reply' || event.target.id === 'wechat-auto-connect') { void saveWechatAutomation(event.target.id === 'wechat-auto-reply' ? 'autoReply' : 'autoConnect', event.target.checked); return; }
  if(event.target.id==='mail-account-filter'){state.mailAccountId=event.target.value;state.mailMessageId=null;renderPage();}
  if(event.target.id==='mail-compose-account'){state.mailCompose=readMailComposeForm(event.target.closest('form'));state.mailSavedDraft=null;renderMailPreservingFocus();}
  if(event.target.closest('#mail-account-form')){state.mailAccountDraft=readMailAccountForm(event.target.closest('form'));if(event.target.id==='mail-provider'){const preset=mailProviders[event.target.value]||mailProviders.custom;Object.assign(state.mailAccountDraft,{imapHost:preset.imap,imapPort:993,imapSecure:true,smtpHost:preset.smtp,smtpPort:preset.smtpPort,smtpSecure:preset.smtpPort===465});}if(['mail-provider','mail-auth-type','mail-smtp-enabled','mail-separate-smtp','mail-smtp-auth-type'].includes(event.target.id))renderMailPreservingFocus();}
  if (event.target.matches('[data-dsh-kind]')) { state.dshGrantsDirty = true; const selection = dshGrantSelection(); const kind = event.target.dataset.dshKind === 'tools' ? 'tools' : 'skills'; const name = event.target.value; selection[kind] = event.target.checked ? [...new Set([...selection[kind],name])] : selection[kind].filter(item=>item!==name); renderPage(); }
  if (event.target.matches('[data-contact-id]')) {
    const selection = wechatAllowedSelection();
    const kind = event.target.dataset.kind === 'groups' ? 'groups' : 'private';
    const id = event.target.dataset.contactId;
    selection[kind] = event.target.checked ? [...new Set([...selection[kind], id])] : selection[kind].filter(value => value !== id);
    renderWechatPreservingFocus();
  }
  if (event.target.id === 'task-type') { state.kind = ['organize', 'literature'].includes(event.target.value) ? event.target.value : 'agent'; updateComposer(); }
  if (event.target.id === 'work-mode') { state.workflowId = Object.hasOwn(workflowInfo, event.target.value) ? event.target.value : 'single'; updateComposer(); }
  if (event.target.matches('#task-form input[name="skillIds"]')) {
    const id = event.target.value;
    if (event.target.checked && state.skillIds.length >= 3 && !state.skillIds.includes(id)) { event.target.checked = false; notify('每项 AI 工作最多选择 3 个技能。'); return; }
    state.skillIds = [...document.querySelectorAll('#task-form input[name="skillIds"]:checked')].map(input => input.value);
  }
  if (event.target.matches('#mcp-tools-form input[name="tools"]')) {
    const form = event.target.closest('form');
    state.mcpToolSelections[form.dataset.id] = [...form.querySelectorAll('input[name="tools"]:checked')].map(input => input.value);
    const count = form.querySelector('.tools-footer > span');
    if (count) count.textContent = `已勾选 ${state.mcpToolSelections[form.dataset.id].length} 项。保存清单不会调用工具。`;
  }
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'mail-account-form') saveMailAccount(event);
  if (event.target.id === 'mail-compose-form') saveMailDraft(event);
  if (event.target.id === 'task-form') createTask(event);
  if (event.target.id === 'settings-form') saveSettings(event);
  if (event.target.id === 'wechat-settings-form') saveWechatSettings(event);
  if (event.target.id === 'wechat-contact-search-form') { event.preventDefault(); searchWechatContacts(); }
  if (event.target.id === 'wechat-reply-form') sendWechatReply(event);
  if (event.target.id === 'wechat-sticker-form') { event.preventDefault(); searchWechatStickers(); }
  if (event.target.id === 'dsh-grants-search') { event.preventDefault(); state.dshGrantQuery = String(new FormData(event.target).get('query') || '').trim(); renderPage(); }
  if (event.target.id === 'dsh-grants-form') { event.preventDefault(); extensionOperation('dsh-grants', async () => { state.dshAccess = await invoke('saveDshOwnerGrants', { ...dshGrantSelection() }); state.dshGrantDraft = null; state.dshGrantsDirty = false; notify('主人桌面任务授权已保存，以当前有效授权为准。'); }); }
  if (event.target.id === 'dsh-catalog-search') { event.preventDefault(); state.nativeCatalogQuery = String(new FormData(event.target).get('query') || '').trim(); renderPage(); }
  if (event.target.id === 'mcp-tools-form') saveMcpTools(event);
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
    else if (action === 'start-literature') { state.kind='literature'; state.prompt=''; navigate('home'); document.querySelector('#task-prompt')?.focus(); }
    else if (action === 'choose-workflow') { if (Object.hasOwn(workflowInfo, button.dataset.id)) { state.workflowId = button.dataset.id; state.kind = 'agent'; navigate('home'); document.querySelector('#task-prompt')?.focus(); } }
    else if (action === 'capability-tab') { state.capabilityTab = ['mcp', 'skills', 'legacy'].includes(button.dataset.tab) ? button.dataset.tab : 'overview'; renderPage(); }
    else if (action === 'dsh-access-refresh') await extensionOperation('dsh-catalog', async () => { state.dshAccess = await invoke('refreshDshAccessCatalog'); state.dshAccessError = ''; notify(state.dshAccess?.connected ? '已读取 DSH 可授权能力。' : 'DSH 尚未连接，请检查宿主状态。', !state.dshAccess?.connected); });
    else if (action === 'dsh-grants-clear') { state.dshGrantDraft = { skills: [], tools: [] }; state.dshGrantsDirty = true; renderPage(); }
    else if (action === 'dsh-grant-remove') { state.dshGrantsDirty = true; const selection = dshGrantSelection(); const kind = button.dataset.kind === 'tools' ? 'tools' : 'skills'; selection[kind] = selection[kind].filter(name=>name!==button.dataset.name); renderPage(); }
    else if (action === 'legacy-import') await extensionOperation('legacy-import', async () => { const migration = await invoke('importLegacyExtensions'); if (state.extensions) state.extensions.migration = migration; notify('原有能力已完成清点，请查看逐项迁移结果。'); });
    else if (action === 'legacy-catalog-refresh') await extensionOperation('legacy-catalog', async () => { const migration = await invoke('refreshDshCatalog'); if (state.extensions) state.extensions.migration = migration; notify(migration?.report?.nativeCatalog?.connected ? '已读取现有 DSH 实际能力目录。' : 'DSH 目录尚未连接，请查看状态说明。', !migration?.report?.nativeCatalog?.connected); });
    else if (action === 'extensions-refresh') { await refresh(); if (!state.extensionsError) notify('插件与技能状态已刷新。'); }
    else if (action === 'manage-skills') { state.capabilityTab = 'skills'; navigate('capabilities'); }
    else if (action === 'mcp-select') { state.selectedMcpId = button.dataset.id; renderPage(); }
    else if (action === 'mcp-import') await extensionOperation('mcp-import', async () => { const result = await invoke('importMcpManifest'); if (result?.id) { state.selectedMcpId = result.id; notify('插件配置已导入，当前保持停用。'); } });
    else if (action === 'mcp-install-builtin') await extensionOperation(`builtin:${button.dataset.id}`, async () => { const result = await invoke('installBuiltinMcp', button.dataset.id); if (result?.id) state.selectedMcpId = result.id; notify('内置插件已安装，当前保持停用。'); });
    else if (action === 'mcp-enable') await extensionOperation(`enable:${button.dataset.id}`, async () => { await invoke('enableMcp', button.dataset.id); notify('插件已启用。点击检测后才会启动程序。'); });
    else if (action === 'mcp-disable') await extensionOperation(`disable:${button.dataset.id}`, async () => { await invoke('disableMcp', button.dataset.id); notify('插件已停用。'); });
    else if (action === 'mcp-test') await extensionOperation(`test:${button.dataset.id}`, async () => { const report = await invoke('testMcp', button.dataset.id); state.mcpDiagnostics[button.dataset.id] = report; delete state.mcpToolSelections[button.dataset.id]; notify(report?.ok ? '连接检测通过，已读取实际工具清单。' : '连接检测未通过，请查看诊断。', !report?.ok); });
    else if (action === 'skill-import') await extensionOperation('skill-import', async () => { const result = await invoke('importSkill'); if (result?.id) notify('技能已导入，请查看依赖与检查结果后启用。'); });
    else if (action === 'skill-import-bundled') await extensionOperation(`skill-import:${button.dataset.id}`, async () => { await invoke('importBundledSkill', button.dataset.id); notify('内置技能已导入，当前保持停用。'); });
    else if (action === 'skill-enable') await extensionOperation(`skill-enable:${button.dataset.id}`, async () => { await invoke('enableSkill', button.dataset.id); notify('技能已启用。文字任务技能可在工作台选择。'); });
    else if (action === 'skill-disable') await extensionOperation(`skill-disable:${button.dataset.id}`, async () => { await invoke('disableSkill', button.dataset.id); notify('技能已停用。'); });
    else if (action === 'mail-tab') {state.mailTab=['accounts','compose'].includes(button.dataset.tab)?button.dataset.tab:'inbox';renderPage();}
    else if (action === 'mail-refresh') await refresh();
    else if (action === 'mail-new') newMail();
    else if (action === 'mail-account-new') {state.mailAccountDraft=null;renderPage();}
    else if (action === 'mail-import') await mailOperation('import',async()=>{const result=await invoke('importMailAccountsFile');if(result){state.mailAccountDraft=null;notify(`已导入 ${result.imported||0} 个邮箱账号。`);}});
    else if (action === 'mail-account-edit') editMailAccount(button.dataset.id);
    else if (action === 'mail-sync' || action === 'mail-account-sync') await syncMailAccounts(action==='mail-account-sync'?button.dataset.id:state.mailAccountId);
    else if (action === 'mail-message') {state.mailMessageId=button.dataset.id;renderPage();}
    else if (action === 'mail-reply') replyMail();
    else if (action === 'mail-use-draft') replyMail(true);
    else if (action === 'mail-ai-draft') {const message=selectedMailMessage();if(message)await mailOperation('ai-draft',async()=>{const task=await invoke('draftMailReply',{messageId:message.id});state.mailDraftTasks[message.id]=task.id;await refresh();await openTask(task.id);notify('已创建邮件起草任务；完成后可填入草稿并编辑。');});}
    else if (action === 'mail-send') await sendMailDraft();
    else if (action === 'mail-open-draft') openMailDraft(button.dataset.id);
    else if (action === 'mail-attachment') await mailOperation('attachment',async()=>{const result=await invoke('saveMailAttachment',{messageId:button.dataset.messageId,attachmentId:button.dataset.id});if(result?.saved){state.mailAttachment={...result,messageId:button.dataset.messageId};notify('附件已另存到你选择的位置。');}});
    else if (action === 'wechat-tab') {
      state.wechatTab = ['settings', 'contacts'].includes(button.dataset.tab) ? button.dataset.tab : 'inbox';
      renderPage();
      if (state.wechatTab === 'contacts' && !state.wechatContactsSearched && wechatConnectionInfo().state === 'ready') await searchWechatContacts();
    }
    else if (action === 'wechat-contact-kind') { state.wechatContactKind = button.dataset.kind === 'groups' ? 'groups' : 'private'; renderPage(); if (!state.wechatContactResults[state.wechatContactKind].length && wechatConnectionInfo().state === 'ready') await searchWechatContacts(); }
    else if (action === 'wechat-contacts-refresh') await searchWechatContacts({ refresh: true });
    else if (action === 'wechat-save-contacts') await saveWechatContacts();
    else if (action === 'wechat-contact-remove') { const selection = wechatAllowedSelection(); const kind = button.dataset.kind === 'groups' ? 'groups' : 'private'; selection[kind] = selection[kind].filter(id => id !== button.dataset.id); renderPage(); }
    else if (action === 'wechat-select' || action === 'wechat-target') selectWechatMessage(button.dataset.id);
    else if (action === 'wechat-conversation') selectWechatConversation(button.dataset.key);
    else if (action === 'wechat-sessions') await loadWechatSessions();
    else if (action === 'wechat-history') await loadWechatHistory();
    else if (action === 'wechat-image') await previewWechatImage(button.dataset.imageId);
    else if (action === 'wechat-attachment-pick') await pickWechatAttachments(button.dataset.mediaType);
    else if (action === 'wechat-attachment-send') await sendWechatAttachment(button.dataset.id);
    else if (action === 'wechat-attachment-remove') removeWechatAttachment(button.dataset.id);
    else if (action === 'wechat-stickers') { state.wechatStickerPanel = !state.wechatStickerPanel; renderPage(); if (state.wechatStickerPanel) await searchWechatStickers(); }
    else if (action === 'wechat-sticker-send') await sendWechatSticker(button.dataset.id);
    else if (action === 'wechat-refresh') { await refresh(); if (!state.wechatError) notify('微信状态已刷新。'); }
    else if (action === 'wechat-profile-refresh') await wechatOperation('profile', async () => { await invoke('refreshWechatProfile'); notify('微信账号信息已重新读取。'); });
    else if (action === 'wechat-import') await wechatOperation('import', async () => { const result = await invoke('importWechatConnection'); if (result?.settings?.connectionImported) { state.wechatSettingsDraft = null; state.wechatAllowedDraft = null; notify(result?.connection?.state === 'ready' ? '已连接现有微信，并开启新消息自动回复。你可以按名字调整允许的好友与群聊。' : '已导入现有连接，可在微信页查看连接状态并按名字选择好友与群聊。'); } });
    else if (action === 'wechat-connect') await wechatOperation('connect', () => invoke('connectWechat'));
    else if (action === 'wechat-disconnect') await wechatOperation('disconnect', () => invoke('disconnectWechat'));
    else if (action === 'wechat-draft') {
      const message = selectedWechatMessage();
      if (message) await wechatOperation('draft', async () => { const task = await invoke('draftWechatReply', { messageId: message.id }); if (task?.id) { await refresh(); await openTask(task.id); notify('已创建起草任务。完成后可在回复区填入 AI 草稿。'); } });
    }
    else if (action === 'wechat-use-draft') {
      const message = selectedWechatMessage();
      if (message?.replyDraft) { state.wechatReply = message.replyDraft; renderPage(); document.querySelector('#wechat-reply')?.focus(); notify('AI 草稿已填入，请核对后再发送。'); }
    }
    else if (action === 'attach') await addAttachments();
    else if (action === 'remove-attachment') { state.attachments.splice(Number(button.dataset.index), 1); renderAttachments(); }
    else if (action === 'quick') {
      state.kind = ['organize', 'literature'].includes(button.dataset.kind) ? button.dataset.kind : 'agent';
      if (button.dataset.kind === 'organize') { state.prompt = '请整理我添加的资料，生成一份清晰的文件清单。'; updateComposer(); if (!state.attachments.length) await addAttachments(); }
      else if (button.dataset.kind === 'literature') { state.prompt = ''; updateComposer(); }
      else { state.prompt = button.dataset.kind === 'draft' ? '请帮我起草一份文字。我的用途是：\n\n需要表达的内容：\n\n' : '我想和你一起梳理这个问题：\n\n'; updateComposer(); }
      document.querySelector('#task-prompt')?.focus();
    }
    else if (action === 'open-task') await openTask(button.dataset.id);
    else if (action === 'close-task') closeTask();
    else if (action === 'retry-detail') await loadTask(state.selectedTask);
    else if (action === 'open-workspace') await invoke('openWorkspace');
    else if (action === 'task-workspace') await invoke('openWorkspace', state.selectedTask);
    else if (action === 'open-artifact') await invoke('openArtifact', button.dataset.id);
    else if (action === 'export-task') {
      const id = state.selectedTask;
      const format = button.dataset.format;
      if (id && ['docx', 'pdf'].includes(format) && !state.exportingFormat) {
        state.exportingFormat = format;
        renderDrawer();
        try {
          const detail = await invoke('exportTaskDocument', { taskId: id, formats: [format] });
          if (state.selectedTask === id && detail?.task) { state.detail = detail; state.detailError = ''; renderDrawer(); }
          await refresh();
          notify(`${format === 'docx' ? 'Word' : 'PDF'} 已生成，保存在成果列表中。`);
        } finally { state.exportingFormat = ''; if (state.selectedTask) renderDrawer(); }
      }
    }
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
