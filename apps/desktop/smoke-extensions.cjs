// UI-only synthetic extension responses. No legacy program or model is started.
const fs = require('node:fs');
const path = require('node:path');

exports.verifyExtensionsUI = async function verifyExtensionsUI({ window, service, waitFor, artifactsDir, catalog }) {
  const evaluate = source => window.webContents.executeJavaScript(`{${source}\n}`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 220));
  const snapshot = async name => { await evaluate(`document.querySelector('#toast').className='toast'`); await pause(); fs.writeFileSync(path.join(artifactsDir, name), (await window.webContents.capturePage()).toPNG()); };
  const settings = await service.getSettings();
  if (settings.runtimeMode !== 'hosted') throw Error('默认运行模式不是 DSH 宿主。');
  await evaluate(`document.querySelector('[data-action="close-task"]')?.click(); document.querySelector('[data-page="settings"]').click()`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('#settings-form'))`), '控制面板未显示');
  const accountUI = await evaluate(`({mode:document.querySelector('[name="runtimeMode"]')?.value,shared:document.querySelector('#settings-form').textContent.includes('沿用 Harness 现有登录'),keyRequired:document.querySelector('[name="runtimeApiKey"]')?.required,advancedOpen:document.querySelector('[name="runtimeApiKey"]')?.closest('details')?.open})`);
  if (accountUI.mode !== 'hosted' || !accountUI.shared || accountUI.keyRequired || accountUI.advancedOpen) throw Error('默认 DSH 登录复用界面不正确。');
  await snapshot('desktop-dsh-settings.png');

  const original = Object.fromEntries(['getExtensionsState', 'importLegacyExtensions', 'refreshDshCatalog', 'createTask', 'getDshAccessState', 'refreshDshAccessCatalog', 'saveDshOwnerGrants'].map(name => [name, service[name]]));
  const base = await original.getExtensionsState();
  const calls = { import: 0, catalog: 0, literature: 0, grants: 0 };
  const syntheticCatalog = catalog || { connected: true, source: 'synthetic-ui-only', skills: [{ name: 'smoke-reused-skill', description: '界面验收：原 Harness 已登记的工作方法。' }], tools: [{ name: 'smoke_contract_tool', description: '界面验收：目录元数据，不实际执行。' }], detail: '合成的本机界面验收目录，未启动模型或插件。', checkedAt: new Date().toISOString() };
  let migration = { sources: [{ id: 'smoke-legacy', name: '界面验收原有能力', skillCount: 2, pluginCount: 1 }], nativePlugins: [], report: null };
  const changed = () => window.webContents.send('assistant:change');
  let access = { source: 'dsh', connected: true, metadataOnly: true, catalog: { skills: [{ name: 'smoke-owner-skill', description: '主人明确选择的工作方法。' }], tools: [{ name: 'smoke_owner_tool', description: '主人可授权的合成工具。', grantable: true }, { name: 'smoke_unsupported_tool', description: '参数接口尚未适配。', grantable: false }] }, saved: { skills: [], tools: [] }, effective: { skills: [], tools: [] }, unavailable: { skills: [], tools: [] } };
  service.getDshAccessState = () => access;
  service.refreshDshAccessCatalog = async () => { changed(); return access; };
  service.saveDshOwnerGrants = async grants => { calls.grants++; if (grants.skills?.length !== 1 || grants.skills[0] !== 'smoke-owner-skill' || grants.tools?.length !== 1 || grants.tools[0] !== 'smoke_owner_tool') throw Error('主人授权选择错误。'); access = { ...access, saved: grants, effective: grants }; changed(); return access; };
  service.getExtensionsState = () => ({ ...base, migration });
  service.importLegacyExtensions = async () => {
    calls.import++;
    migration = { ...migration, report: { at: new Date().toISOString(), entries: [
      { sourceId: 'smoke-legacy', kind: 'skill', id: 'smoke-ready-skill', status: 'ready', detail: '合成结果：已迁入并启用。' },
      { sourceId: 'smoke-legacy', kind: 'skill', id: 'smoke-adapt-skill', status: 'needs-adaptation', detail: '合成结果：需要适配宿主接口。' },
      { sourceId: 'smoke-legacy', kind: 'dsh-extension', id: 'smoke-dsh-plugin', status: 'dsh-managed', detail: '合成结果：由 DSH 管理。' },
    ], nativeCatalog: { connected: false, skills: [], tools: [], detail: '尚未刷新合成目录。' }, summary: { ready: 1, preserved: 1, needsAdaptation: 1 }, originalDataModified: false } };
    changed(); return migration;
  };
  service.refreshDshCatalog = async () => { calls.catalog++; migration = { ...migration, report: { ...migration.report, nativeCatalog: syntheticCatalog } }; changed(); return migration; };
  service.createTask = async value => { if (value?.kind === 'literature') { calls.literature++; throw Error('界面验收不应提交网络检索。'); } return original.createTask(value); };
  try {
    changed();
    await evaluate(`document.querySelector('[data-page="capabilities"]').click(); document.querySelector('[data-action="capability-tab"][data-tab="legacy"]').click()`);
    await waitFor(() => evaluate(`document.querySelector('#capability-panel')?.textContent.includes('界面验收原有能力')`), '能力来源未显示');
    await evaluate(`document.querySelector('[data-action="legacy-import"]').click()`);
    await waitFor(() => calls.import === 1, '未调用原有能力导入接口');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="legacy-catalog-refresh"]:not(:disabled)')) && document.querySelector('.legacy-report-table')?.textContent.includes('smoke-adapt-skill')`), '逐项迁移结果未显示');
    await evaluate(`document.querySelector('[data-action="legacy-catalog-refresh"]').click()`);
    await waitFor(() => calls.catalog === 1, '未调用 DSH 能力目录接口');
    await waitFor(() => evaluate(`document.querySelector('.legacy-catalog-status')?.textContent.includes('DSH 目录已连通') && Boolean(document.querySelector('[data-action="legacy-catalog-refresh"]:not(:disabled)'))`), '真实返回的目录状态未显示');
    const catalogUI = await evaluate(`({counts:[...document.querySelectorAll('.legacy-catalog-overview strong')].map(node=>Number(node.textContent)),qualified:document.querySelector('.legacy-catalog-overview')?.textContent.includes('调用权限和执行结果另行核验'),statuses:document.querySelector('.legacy-report-table')?.textContent})`);
    if (catalogUI.counts[0] !== syntheticCatalog.skills.length || catalogUI.counts[1] !== syntheticCatalog.tools.length || !catalogUI.qualified || !catalogUI.statuses.includes('需要适配') || !catalogUI.statuses.includes('由 DSH 管理')) throw Error('原有能力状态与服务回执不一致。');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-dsh-kind="tools"][value="smoke_owner_tool"]'))`), 'DSH 主人授权未显示');
    const defaultGrants = await evaluate(`({selected:document.querySelectorAll('[data-dsh-kind]:checked').length,unsupported:document.querySelectorAll('[data-dsh-kind][value="smoke_unsupported_tool"]').length,scope:document.querySelector('.dsh-access-intro')?.textContent.includes('微信来信和邮件正文不会继承')})`);
    if (defaultGrants.selected || defaultGrants.unsupported || !defaultGrants.scope) throw Error('DSH 主人授权不是空默认或暴露了不支持的工具。');
    await evaluate(`document.querySelector('[data-dsh-kind="skills"][value="smoke-owner-skill"]').click(); document.querySelector('[data-dsh-kind="tools"][value="smoke_owner_tool"]').click(); document.querySelector('#dsh-grants-form').requestSubmit();`);
    await waitFor(() => calls.grants === 1 && access.effective.tools.length === 1, '明确选择的 DSH 主人授权未保存');
    await waitFor(() => evaluate(`document.querySelector('.dsh-access-summary')?.textContent.includes('当前有效：技能 1 项，工具 1 项')`), 'DSH 有效授权未显示');
    await snapshot('desktop-legacy-capabilities.png');

    await evaluate(`document.querySelector('[data-page="home"]').click(); const type=document.querySelector('#task-type'); type.value='literature'; type.dispatchEvent(new Event('change',{bubbles:true}));`);
    const literatureUI = await evaluate(`({limit:document.querySelector('#task-prompt').maxLength,attachmentsHidden:document.querySelector('[data-action="attach"]').hidden,skills:document.querySelectorAll('#skill-picker-slot input').length,workflows:document.querySelectorAll('#work-mode').length,mode:document.querySelector('#composer-mode').textContent})`);
    if (literatureUI.limit !== 500 || !literatureUI.attachmentsHidden || literatureUI.skills || literatureUI.workflows || !literatureUI.mode.includes('文献检索')) throw Error('文献检索表单分类或限制不正确。');
    await evaluate(`const prompt=document.querySelector('#task-prompt'); prompt.value='x'.repeat(501); prompt.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#task-form').requestSubmit();`);
    await pause();
    if (calls.literature) throw Error('超长检索词通过了前端校验。');
    await snapshot('desktop-literature-mode.png');
    await evaluate(`const prompt=document.querySelector('#task-prompt'); prompt.value=''; prompt.dispatchEvent(new Event('input',{bubbles:true})); const type=document.querySelector('#task-type'); type.value='agent'; type.dispatchEvent(new Event('change',{bubbles:true}));`);
    return { accountReuseUI: true, legacyRendererFlow: true, legacySyntheticResponses: true, catalogSkillsShown: syntheticCatalog.skills.length, catalogToolsShown: syntheticCatalog.tools.length, ownerDshGrantSelection: true, literatureFormLimits: true, literatureNetworkCalls: calls.literature };
  } finally {
    Object.assign(service, original);
    changed();
  }
};
