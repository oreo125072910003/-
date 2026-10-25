import {describeTool,grantableTool,computerGrantableTool} from '../../packages/contracts/tool-policy.mjs';
const EMPTY = () => ({ skills: [], tools: [] });
const fail = (code, message) => Object.assign(new Error(message), { code });
const SKILL_NAME = /^[^\u0000-\u001f\u007f\/\\]{1,160}$/;
const TOOL_NAME = /^[\w.:-]{1,160}$/;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

export function validateGrants(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['skills', 'tools'].includes(key))) throw fail('DSH_GRANTS_INVALID', '请选择有效的 Harness 技能与工具。');
  const list = (value, expression, limit) => {
    if (!Array.isArray(value) || value.length > limit || value.some(name => typeof name !== 'string' || !expression.test(name)) || new Set(value).size !== value.length) throw fail('DSH_GRANTS_INVALID', `最多选择 300 项技能、500 项工具，名称必须与 Harness 当前清单完全一致，不能重复。`);
    return [...value];
  };
  return { skills: list(input.skills ?? [], SKILL_NAME, 300), tools: list(input.tools ?? [], TOOL_NAME, 500) };
}
function metadata(raw) {
  if (!raw || raw.ok !== true || raw.metadataOnly !== true || !Array.isArray(raw.skills) || !Array.isArray(raw.tools) || raw.skills.length > 300 || raw.tools.length > 500) throw fail('DSH_CATALOG_INVALID', 'Harness 返回的能力清单格式无效。');
  const unique = (rows, expression, mapper) => {
    const names = new Set();
    return rows.map(row => {
      if (!row || typeof row.name !== 'string' || !expression.test(row.name) || names.has(row.name)) throw fail('DSH_CATALOG_INVALID', 'Harness 能力清单包含无效或重复名称。');
      names.add(row.name); return mapper(row);
    });
  };
  return { ok: true, source: 'harness-host', metadataOnly: true,
    skills: unique(raw.skills, SKILL_NAME, row => ({ name: row.name, description: text(row.description, 1000), provider: text(row.provider, 160) || 'dsh', modelInvocable: row.modelInvocable !== false, executableInProduct: false })),
    tools: unique(raw.tools, TOOL_NAME, row => ({ name: row.name, description: text(row.description, 1000),...describeTool(row.name),grantable:row.grantable===true&&grantableTool(row.name),computerGrantable:row.computerGrantable===true&&computerGrantableTool(row.name), executableInProduct: false })),
    executionPolicy: 'explicit-product-owner-task-allowlist', externalContentInheritsOwner: false };
}
function split(saved, catalog, connected) {
  const skills = new Set(connected ? catalog.skills.filter(row => row.modelInvocable).map(row => row.name) : []);
  const tools = new Set(connected ? catalog.tools.filter(row => row.grantable).map(row => row.name) : []);
  return { effective: { skills: saved.skills.filter(name => skills.has(name)), tools: saved.tools.filter(name => tools.has(name)) },
    unavailable: { skills: saved.skills.filter(name => !skills.has(name)), tools: saved.tools.filter(name => !tools.has(name)) } };
}

/** Only trusted desktop IPC should expose saveGrants. Message content is never an authority input. */
export function createDshAccess({ runtime, settingsProvider, store, onChange } = {}) {
  if (typeof settingsProvider !== 'function' || typeof store?.getSettings !== 'function' || typeof store?.saveSettings !== 'function') throw fail('DSH_ACCESS_CONFIG_INVALID', 'Harness 能力设置服务未正确连接。');
  let lastCatalog = { ok: false, source: 'harness-host', metadataOnly: true, skills: [], tools: [], executionPolicy: 'explicit-product-owner-task-allowlist', externalContentInheritsOwner: false };
  let connected = false, lastError, fetchedAt = null;
  function savedGrants() {
    try { return validateGrants(store.getSettings()?.dshOwnerGrants ?? EMPTY()); }
    catch { return EMPTY(); }
  }
  async function getCatalog() {
    try {
      if (typeof runtime?.readHostedCatalog !== 'function') throw fail('DSH_CATALOG_UNAVAILABLE', '当前运行环境还没有连接原 Harness 能力清单。');
      const settings = await settingsProvider();
      if (typeof settings?.hostedConfigFile !== 'string' || !settings.hostedConfigFile) throw fail('DSH_HOST_NOT_PREPARED', '请先准备小助手 Harness 宿主连接。');
      const response = await runtime.readHostedCatalog({ hostedConfigFile: settings.hostedConfigFile });
      if (response?.ok !== true) throw fail(response?.error?.code || 'DSH_CATALOG_UNAVAILABLE', text(response?.error?.message, 500) || '原 Harness 当前不可访问，已暂停授予能力。');
      lastCatalog = metadata(response); connected = true; lastError = undefined; fetchedAt = new Date().toISOString();
      return structuredClone(lastCatalog);
    } catch (error) {
      connected = false; lastError = { code: text(error.code, 100) || 'DSH_CATALOG_UNAVAILABLE', message: text(error.message, 500) || '原 Harness 能力清单不可访问。' };
      return { ok: false, source: 'harness-host', metadataOnly: true, skills: [], tools: [], error: { ...lastError }, externalContentInheritsOwner: false };
    }
  }
  async function getState() {
    const live = await getCatalog(), saved = savedGrants();
    const catalog = live.ok ? live : { ...structuredClone(lastCatalog), ok: false, stale: true, ...(lastError ? { error: { ...lastError } } : {}) };
    return { source: 'dsh', core: 'dsh', connected, metadataOnly: true, fetchedAt, catalog, saved, ...split(saved, catalog, connected), computerEnabled: store.getSettings().dshDesktopComputerAccess === true, externalContentInheritsOwner: false };
  }
  async function saveGrants(input) {
    const selected = validateGrants(input), catalog = await getCatalog();
    // Revocation remains available while offline. New or retained grants require a live source.
    if (!catalog.ok && (selected.skills.length || selected.tools.length)) throw fail('DSH_CATALOG_UNAVAILABLE', '无法核验原 Harness 当前能力，未保存授权。请恢复连接后重试，或清空授权。');
    if (catalog.ok) {
      const available = split(selected, catalog, true).unavailable;
      if (available.skills.length || available.tools.length) throw fail('DSH_GRANT_NOT_AVAILABLE', '选择中包含当前不可用、未允许调用或名称不完全匹配的 Harness 能力，未保存授权。');
    }
    await store.saveSettings({ dshOwnerGrants: selected });
    try { await onChange?.(); } catch { /* A UI observer cannot undo a successfully persisted choice. */ }
    return { saved: structuredClone(selected), effective: catalog.ok ? structuredClone(selected) : EMPTY(), connected: catalog.ok, source: 'dsh', externalContentInheritsOwner: false };
  }
  async function grantsForTask({ source } = {}) {
    if (source !== 'desktop') return EMPTY();
    const saved = savedGrants();
    const computer = store.getSettings().dshDesktopComputerAccess === true;
    if (!saved.skills.length && !saved.tools.length && !computer) return EMPTY();
    const catalog = await getCatalog();
    if (!catalog.ok) return EMPTY();
    const effective = split(saved, catalog, true).effective;
    if (computer) effective.tools = [...new Set([...effective.tools, ...catalog.tools.filter(row => row.computerGrantable && row.name.startsWith('xiaozhushou_')).map(row => row.name)])];
    return effective;
  }
  return { getCatalog, getState, saveGrants, grantsForTask };
}
