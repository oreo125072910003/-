import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createAssistantService } from '../apps/service/index.mjs';
import * as runtime from '../packages/runtime-harness/index.mjs';
import { createWindowsProtection } from '../packages/dsh-plugin/windows-protection.mjs';

// Explicit operator setup, with a real verified connection and the product's
// normal single-writer lock. Never run against an active desktop/database.
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url);
const ownerIndex = process.argv.indexOf('--owner-name'), ownerName = ownerIndex < 0 ? '' : process.argv[ownerIndex + 1];
if (!ownerName?.trim()) throw Error('请用 --owner-name 明确指定审批私聊名称。');
const { dataHome } = JSON.parse(fs.readFileSync(path.join(root, 'config/desktop-install.local.json'), 'utf8'));
const dataDir = fs.realpathSync(dataHome), backup = path.join(dataDir, 'backups', 'before-self-improvement-' + Date.now());
fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(path.join(dataDir, 'db/assistant.sqlite'), path.join(backup, 'assistant.sqlite'));
const secretStore = require('../apps/desktop/secret-store.cjs').createSecretStore({ dataDir, safeStorage: createWindowsProtection({ dataDir }) });
const locations = JSON.parse(fs.readFileSync(path.join(root, 'config/wechat-locations.json'), 'utf8'));
const service = await createAssistantService({ dataDir, runtime, secretStore, legacySources: [{ id: 'wechatagent', kind: 'wechatagent', path: locations.workspace }] });
try {
  await service.connectWechat();
  let wx = await service.getWechatState();
  const connectionDeadline = Date.now() + 20000;
  while (wx.connection.state === 'connecting' && Date.now() < connectionDeadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    wx = await service.getWechatState();
  }
  if (!wx.connection.accountVerified || wx.connection.state !== 'ready') throw Error('当前微信账号尚未完成核验，未绑定审批私聊。' + String(wx.connection.detail || '').slice(0, 500));
  const directory = await service.searchWechatContacts({ kind: 'private', keyword: ownerName });
  const matches = directory.contacts.filter(contact => contact.name === ownerName && contact.ambiguous !== true && wx.settings.allowedPrivate.includes(contact.id));
  if (matches.length !== 1) throw Error('未找到唯一且已授权的同名私聊，未绑定审批人。');
  const target = matches[0].id, current = service.getExtensionsState().selfImprovement;
  if (!current.config.enabled || current.config.accountId !== wx.settings.boundAccountId || current.config.target !== target) await service.configureSelfImprovement({ enabled: true, target, ownerName });
  let proposal;
  if (process.argv.includes('--first-proposal')) {
    proposal = service.getExtensionsState().selfImprovement.proposals.find(p => p.target === 'self-improvement-preference' && p.status === 'pending' && p.expiresAt > Date.now());
    if (!proposal) proposal = await service.proposeSelfImprovement({ operation: 'memory.set', target: 'self-improvement-preference', reason: '把你本次设定的自我完善偏好保存为长期记忆；先通过微信逐项征求批准。', payload: { text: '主人希望我从任务经验与纠正中主动完善长期记忆、技能和插件。任何实际变更都须先在绑定的微信私聊列明内容、原因与影响，得到主人对该提案的明确同意后才能应用。' } });
  }
  const report = { configured: true, ownerName, privateChatsBound: 1, backup, ...(proposal ? { proposalId: proposal.id, proposalStatus: proposal.status, notification: proposal.notification } : {}) };
  fs.mkdirSync(path.join(root, 'dist/self-improvement-verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist/self-improvement-verification/setup.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await service.close(); }
