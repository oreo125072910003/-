// Synthetic renderer/IPC checks only. No real mailbox or SMTP server is used.
const fs = require('node:fs');
const path = require('node:path');

exports.verifyMailUI = async function verifyMailUI({ window, service, waitFor, artifactsDir }) {
  const evaluate = source => window.webContents.executeJavaScript(`{${source}\n}`);
  const pause = () => new Promise(resolve => setTimeout(resolve, 220));
  const snapshot = async name => { await evaluate(`document.querySelector('#toast').className='toast'`); await pause(); fs.writeFileSync(path.join(artifactsDir, name), (await window.webContents.capturePage()).toPNG()); };
  const original = Object.fromEntries(['getMailState', 'importMailAccounts', 'syncMail', 'getMailMessage', 'createMailDraft', 'sendMailDraft'].map(name => [name, service[name]]));
  const mail = { accounts: [], messages: [], drafts: [], status: 'unconfigured', automaticSending: false };
  let imports = 0, syncs = 0, sends = 0, draftSequence = 0;
  const changed = () => window.webContents.send('assistant:change');
  service.getMailState = () => structuredClone(mail);
  service.importMailAccounts = async value => {
    const account = value?.accounts?.[0];
    if (value.accounts.length !== 1 || account.address !== 'owner@example.com' || account.auth?.type !== 'password' || account.auth?.password !== 'smoke-mail-not-a-real-secret' || account.imap.host !== 'imap.example.com' || account.smtp.host !== 'smtp.example.com') throw Error('邮箱账号导入结构错误。');
    imports++;
    mail.accounts = [{ id: 'mailaccount_ui_smoke', name: account.name, address: account.address, imap: account.imap, smtp: account.smtp, credentialsConfigured: true, busy: false, status: 'configured', error: '', lastSyncAt: null }];
    mail.status = 'configured'; changed(); return { imported: 1, accounts: structuredClone(mail.accounts) };
  };
  service.syncMail = async value => {
    if (value.accountId !== 'mailaccount_ui_smoke' || value.limit !== 50) throw Error('收取邮箱参数错误。');
    syncs++;
    mail.accounts[0].status = 'ready'; mail.accounts[0].lastSyncAt = new Date().toISOString();
    mail.messages = [{ id: 'mail_ui_smoke', accountId: 'mailaccount_ui_smoke', subject: '界面验收：请核对材料', from: [{ name: '合成发件人', address: 'sender@example.com' }], to: [{ address: 'owner@example.com' }], cc: [], date: new Date().toISOString(), messageId: '<ui-smoke@example.com>', unread: true, text: '这是合成邮件正文。\n<img src="https://example.invalid/remote.png">\n<script>window.syntheticMailUnsafe=true</script>', attachments: [{ id: 'mailattachment_ui_smoke', name: '验收材料.txt', size: 12, quarantine: true }], bodyStatus: 'available', remoteContentLoaded: false }];
    changed(); return { accountId: value.accountId, received: 1, pagination: 'latest-only', limit: 50, readOnly: true, messages: structuredClone(mail.messages) };
  };
  service.getMailMessage = value => structuredClone(mail.messages.find(message => message.id === value.messageId));
  service.createMailDraft = async value => {
    if (value.accountId !== 'mailaccount_ui_smoke' || value.to?.[0] !== 'sender@example.com' || !value.text?.trim()) throw Error('邮件草稿内容与收件人错误。');
    const draft = { ...value, id: `maildraft_ui_smoke_${++draftSequence}`, from: 'owner@example.com', status: 'draft', createdAt: new Date().toISOString() };
    mail.drafts.unshift(draft); changed(); return structuredClone(draft);
  };
  service.sendMailDraft = async ({ draftId }) => {
    const draft = mail.drafts.find(item => item.id === draftId);
    if (!draft) throw Error('没有找到合成草稿。');
    if (draft.status !== 'draft') return structuredClone(draft);
    sends++; draft.status = 'sending'; changed(); await pause();
    draft.status = draftSequence === 1 ? 'smtp-accepted' : 'unconfirmed';
    draft.receipt = { kind: draft.status === 'smtp-accepted' ? 'smtp-server-accepted' : 'smtp-unconfirmed', delivery: draft.status === 'smtp-accepted' ? 'server-accepted' : 'unknown' };
    if (draft.status === 'unconfirmed') draft.error = '合成回执：请在邮箱中核对，程序不会自动重发。';
    changed(); return structuredClone(draft);
  };
  try {
    changed();
    await evaluate(`document.querySelector('[data-action="close-task"]')?.click(); document.querySelector('[data-page="mail"]').click(); document.querySelector('[data-action="mail-tab"][data-tab="accounts"]').click()`);
    await waitFor(() => evaluate(`Boolean(document.querySelector('#mail-account-form'))`), '邮箱账号表单未显示');
    await evaluate(`const provider=document.querySelector('#mail-provider'); provider.value='custom'; provider.dispatchEvent(new Event('change',{bubbles:true}));`);
    await evaluate(`for(const [name,value] of Object.entries({address:'owner@example.com',name:'界面验收邮箱',secret:'smoke-mail-not-a-real-secret',imapHost:'imap.example.com',smtpHost:'smtp.example.com'})){const input=document.querySelector('#mail-account-form [name="'+name+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));} document.querySelector('#mail-account-form').requestSubmit();`);
    await waitFor(() => imports === 1, '没有提交邮箱账号导入');
    await waitFor(() => evaluate(`document.querySelector('.mail-account-card')?.textContent.includes('owner@example.com') && Boolean(document.querySelector('#mail-account-form button[type="submit"]:not(:disabled)'))`), '邮箱账号保存结果未显示');
    const secretEcho = await evaluate(`document.querySelector('#mail-account-secret')?.value || document.body.textContent.includes('smoke-mail-not-a-real-secret')`);
    if (secretEcho) throw Error('保存的邮箱凭据被回显。');
    await snapshot('desktop-mail-accounts.png');
    await evaluate(`document.querySelector('[data-action="mail-tab"][data-tab="inbox"]').click(); document.querySelector('[data-action="mail-sync"]').click()`);
    await waitFor(() => syncs === 1, '没有调用只读收取邮箱接口');
    await waitFor(() => evaluate(`document.querySelector('.mail-body')?.textContent.includes('合成邮件正文') && Boolean(document.querySelector('[data-action="mail-sync"]:not(:disabled)'))`), '邮件正文未显示');
    const unsafeContent = await evaluate(`({images:document.querySelectorAll('.mail-body img').length,scripts:document.querySelectorAll('.mail-body script').length,ran:window.syntheticMailUnsafe===true,plain:document.querySelector('.mail-body').textContent.includes('<img')})`);
    if (unsafeContent.images || unsafeContent.scripts || unsafeContent.ran || !unsafeContent.plain) throw Error('邮件 HTML 未按纯文本处理。');
    await snapshot('desktop-mail-inbox.png');
    await evaluate(`document.querySelector('[data-action="mail-reply"]').click(); const text=document.querySelector('#mail-compose-text'); text.value='界面验收：材料已核对。'; text.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#mail-compose-form').requestSubmit();`);
    await waitFor(() => mail.drafts.length === 1, '没有保存邮件草稿');
    if (sends) throw Error('保存草稿时自动发送了邮件。');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="mail-send"]:not(:disabled)'))`), '保存草稿后发送按钮不可用');
    await evaluate(`document.querySelector('[data-action="mail-send"]').click(); document.querySelector('[data-action="mail-send"]')?.click()`);
    await waitFor(() => mail.drafts[0].status === 'smtp-accepted', '邮件服务器接收回执未显示');
    await waitFor(() => evaluate(`document.querySelector('.mail-compose-note')?.textContent.includes('已提交邮件服务器') && document.querySelector('[data-action="mail-send"]')?.disabled`), '邮件回执状态或重复发送限制错误');
    if (sends !== 1) throw Error('重复点击造成了重复邮件提交。');
    await snapshot('desktop-mail-compose.png');
    await evaluate(`const text=document.querySelector('#mail-compose-text'); text.value='界面验收：第二份需核对的草稿。'; text.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#mail-compose-form').requestSubmit();`);
    await waitFor(() => mail.drafts.length === 2, '编辑后未另存新草稿');
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-action="mail-send"]:not(:disabled)'))`), '第二份草稿不可提交');
    await evaluate(`document.querySelector('[data-action="mail-send"]').click()`);
    await waitFor(() => mail.drafts[0].status === 'unconfirmed', '没有保留不确定发送回执');
    await waitFor(() => evaluate(`document.querySelector('.mail-compose-note')?.textContent.includes('结果待核对') && document.querySelector('[data-action="mail-send"]')?.disabled`), '不确定回执未阻止重复提交');
    if (sends !== 2) throw Error('不确定发送被自动重试。');
    return { mailRendererFlow: true, mailSyntheticResponses: true, mailAccountImportUI: true, mailPasswordNoEcho: true, mailHtmlEscaped: true, mailExplicitSendOnly: true, mailDuplicateSubmissionBlocked: true, mailUnconfirmedPreserved: true, mailSyntheticSubmissions: sends };
  } finally { Object.assign(service, original); changed(); }
};
