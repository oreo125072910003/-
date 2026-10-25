// Hidden Electron renderer + real preload, backed only by synthetic IPC handlers.
// Does not load the product service, connect to DSH/WeChat/mail, or show a window.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),outputIndex=process.argv.indexOf('--output');
const output=outputIndex>=0?path.resolve(process.argv[outputIndex+1]):path.join(root,'dist','feedback-ui-qa');
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-feedback-ui-'));
app.setPath('userData',isolated);
const full='Synthetic complete reply.\n'.repeat(650)+'END_BEYOND_12000',calls={reads:0,mailDrafts:0,sends:0,grants:0,computer:0},errors=[];
let readGate=null,expectedMailText=full;
function holdRead(){
  assert.equal(readGate,null);let release,fail;
  const gate={promise:new Promise((resolve,reject)=>{release=resolve;fail=reject;}),release(){readGate=null;release();},reject(error){readGate=null;fail(error);}};
  readGate=gate;return gate;
}
const task={id:'synthetic-task',title:'合成完整草稿验收',status:'succeeded',summary:full.slice(0,12000),createdAt:new Date().toISOString(),kind:'agent'};
const mail={accounts:[{id:'synthetic-account',name:'合成邮箱',address:'owner@example.test',smtp:{host:'smtp.example.test'},imap:{host:'imap.example.test'},credentialsConfigured:true}],messages:[{id:'synthetic-mail',accountId:'synthetic-account',from:[{name:'合成发件人',address:'sender@example.test'}],replyTo:[{name:'回复窗口',address:'reply@example.test'}],to:[{address:'owner@example.test'}],subject:'合成邮件：完整草稿验收',text:'请核对完整答复。',date:new Date().toISOString(),bodyStatus:'available',attachments:[]}],drafts:[]};
let access={source:'wechat',accountId:'111',accountVerified:true,connected:true,saved:{skills:[],tools:['old-unavailable','mcp_pcbridge_read_file']},effective:{skills:[],tools:[]},unavailable:{skills:[],tools:['old-unavailable','mcp_pcbridge_read_file']},computerAccess:{enabled:false,eligibleTools:['mcp_pcbridge_read_file']},catalog:{skills:[{name:'office-docx',description:'按明确选择处理合同文档。',modelInvocable:true}],tools:[{name:'mcp_contract_search',description:'查询合同资料、型号及金额。',grantable:true},{name:'mcp_pcbridge_read_file',description:'读取本机文件。',grantable:false,computerGrantable:true,grantReason:'需单独保存此私聊的电脑控制范围。'}]}};
access.catalog.skills.push(...Array.from({length:35},(_,index)=>({name:`synthetic-skill-${index}`,description:'用于验证长能力目录滚动保持的合成条目。',modelInvocable:true})));
access.catalog.tools.push(...Array.from({length:60},(_,index)=>({name:`synthetic_tool_${index}`,description:'用于验证多项勾选和后台刷新定位的合成工具。',grantable:true})));
const wechat={settings:{boundAccountId:'111',connectionId:'synthetic-connection',allowedPrivate:['222'],allowedGroups:[],autoReply:false,connectionImported:true},profile:{nickname:'合成验收账号',wxid:'111',verified:true,loginState:'ready'},connection:{state:'ready',accountVerified:true,detail:'合成离线连接',readerConfiguration:{state:'pending',detail:'合成配置尚未同步。'}},sessions:[{id:'222',kind:'private',name:'合成好友',allowed:true}],allowedContacts:[{id:'222',kind:'private',name:'合成好友'}],messages:[{id:'synthetic-message',kind:'private',conversationId:'222',senderName:'合成好友',text:'起草参考消息',taskId:task.id,replyDraft:task.summary,receivedAt:new Date().toISOString()}],outbox:[]};
wechat.settings.allowedPrivate.push('333');wechat.sessions.push({id:'333',kind:'private',name:'另一个合成好友',allowed:true});
function updateEffectiveAccess(){
  access.computerAccess.eligibleTools=access.saved.tools.filter(name=>name==='mcp_pcbridge_read_file');
  access.effective={skills:access.saved.skills,tools:access.saved.tools.filter(name=>name==='mcp_contract_search'||access.computerAccess.enabled&&name==='mcp_pcbridge_read_file')};
  access.unavailable={skills:[],tools:access.saved.tools.filter(name=>!access.effective.tools.includes(name))};
  return access;
}
async function run(){
  fs.mkdirSync(output,{recursive:true});
  const methods=vm.runInNewContext(fs.readFileSync(path.join(root,'apps/desktop/preload.cjs'),'utf8').match(/const methods = (\[[\s\S]+?\]);/)[1]);
  const mock={getBootstrap:()=>({identity:{name:'小助手 DSH'},runtime:{available:false},capabilities:[],appVersion:'synthetic-feedback'}),listTasks:()=>[task],getTask:()=>({task,events:[],artifacts:[]}),getSettings:()=>({}),getExtensionsState:()=>({skills:[],mcp:[]}),getWorkflowsState:()=>({workers:[],workflows:[]}),getDshAccessState:()=>({connected:false,saved:{skills:[],tools:[]},effective:{skills:[],tools:[]}}),getMailState:()=>mail,getWechatState:()=>wechat,
    getTaskReplyText:async id=>{assert.equal(id,task.id);calls.reads++;if(readGate)await readGate.promise;return{taskId:id,text:full,artifactId:'synthetic-artifact',sha256:'synthetic-only'};},draftMailReply:()=>task,
    createMailDraft:value=>{assert.equal(value.to[0],'reply@example.test');assert.equal(value.text,expectedMailText);calls.mailDrafts++;const draft={...value,id:'synthetic-draft',status:'draft'};mail.drafts=[draft];return draft;},
    getWechatDshAccess:target=>{assert.deepEqual(target,{kind:'private',target:'222'});return access;},
    saveWechatDshGrants:value=>{assert.deepEqual(value.grants,{skills:[],tools:value.clearUnavailable?[]:['mcp_contract_search']});calls.grants++;const retained=value.clearUnavailable?[]:access.saved.tools.filter(name=>name!=='mcp_contract_search');access.saved={skills:value.grants.skills,tools:[...new Set([...retained,...value.grants.tools])]};return updateEffectiveAccess();},
    saveWechatComputerAccess:value=>{assert.equal(typeof value.enabled,'boolean');if(value.enabled)assert.equal(value.confirmation,'allow-computer-control');calls.computer++;access.computerAccess.enabled=value.enabled;return updateEffectiveAccess();},
  };
  for(const method of methods)ipcMain.handle('assistant:'+method,(_event,...args)=>{if(/^send/.test(method)){calls.sends++;throw Error('Synthetic test must never send.');}if(!mock[method])throw Error('Unexpected synthetic API '+method);return mock[method](...args);});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:path.join(root,'apps/desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message',(_event,...args)=>{const details=args[0];if(details?.level==='error')errors.push(details.message);});
  const evaluate=source=>window.webContents.executeJavaScript(source);
  async function waitFor(source){const deadline=Date.now()+7000;while(Date.now()<deadline){if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('UI condition timed out: '+source);}
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot=async name=>{
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise(resolve=>setTimeout(resolve,180));
    fs.writeFileSync(path.join(output,name),(await window.webContents.capturePage()).toPNG());
  };
  async function editText(selector,text){await evaluate(`{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(text)};field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();field.setSelectionRange(field.value.length-8,field.value.length);}`);}
  async function checkRefreshKeepsEditing(selector,text){
    await evaluate(`window.__qaFocusedField=document.querySelector(${JSON.stringify(selector)})`);
    window.webContents.send('assistant:change');
    await waitFor(`document.querySelector(${JSON.stringify(selector)})!==window.__qaFocusedField`);
    const field=await evaluate(`{const field=document.querySelector(${JSON.stringify(selector)});({text:field.value,focused:document.activeElement===field,start:field.selectionStart,end:field.selectionEnd})}`);
    assert.deepEqual(field,{text,focused:true,start:text.length-8,end:text.length});
  }
  async function checkGrantCounts(saved,effective){
    await waitFor(`document.querySelector('.dsh-access-summary')?.textContent.includes('已保存：技能 0 项 · 工具 ${saved} 项')&&document.querySelector('.dsh-access-summary')?.textContent.includes('本轮有效：技能 0 项 · 工具 ${effective} 项')`);
  }
  async function checkAccessScrollAndFocus(){
    const selector='[data-wechat-dsh-kind="tools"][value="synthetic_tool_20"]';
    await evaluate(`{const panel=document.querySelector('.wechat-dsh-access'),lists=panel.querySelectorAll('.dsh-grant-list'),input=document.querySelector(${JSON.stringify(selector)});lists[0].scrollTop=125;lists[1].scrollTop+=input.getBoundingClientRect().top-lists[1].getBoundingClientRect().top-80;panel.scrollTop+=lists[1].getBoundingClientRect().top-panel.getBoundingClientRect().top-90;input.focus({preventScroll:true});}`);
    const position=()=>evaluate(`{const panel=document.querySelector('.wechat-dsh-access'),input=document.querySelector(${JSON.stringify(selector)});({outer:panel.scrollTop,inner:[...panel.querySelectorAll('.dsh-grant-list')].map(list=>list.scrollTop),focused:document.activeElement===input,checked:input.checked})}`);
    const before=await position();assert.ok(before.outer>0&&before.inner.every(value=>value>0));assert.equal(before.focused,true);
    await click(selector);assert.deepEqual(await position(),{...before,checked:true});
    await evaluate(`window.__qaGrantField=document.querySelector(${JSON.stringify(selector)})`);window.webContents.send('assistant:change');
    await waitFor(`document.querySelector(${JSON.stringify(selector)})!==window.__qaGrantField`);
    assert.deepEqual(await position(),{...before,checked:true});
    await click(selector);assert.deepEqual(await position(),before);
  }
  try {
    await window.loadFile(path.join(root,'apps/desktop/renderer/index.html'));
    await waitFor('Boolean(document.querySelector("[data-page=mail]"))');
    await click('[data-page="mail"]');await waitFor('Boolean(document.querySelector("[data-action=mail-ai-draft]"))');
    await click('[data-action="mail-ai-draft"]');await waitFor('Boolean(document.querySelector("[data-action=close-task]"))');
    await click('[data-action="close-task"]');await waitFor('Boolean(document.querySelector("[data-action=mail-use-draft]:not(:disabled)"))');
    let gate=holdRead(),before=calls.reads;
    await click('[data-action="mail-use-draft"]');await waitFor('document.querySelector("[data-action=mail-use-draft]")?.disabled');
    assert.equal(await evaluate('document.querySelector("[data-action=mail-use-draft]").textContent'),'正在读取…');
    await click('[data-action="mail-use-draft"]');await click('[data-action="mail-use-draft"]');assert.equal(calls.reads,before+1);
    gate.release();await waitFor('Boolean(document.querySelector("#mail-compose-text"))');
    assert.equal(await evaluate('document.querySelector("#mail-compose-text").value'),full);
    assert.equal(await evaluate('document.querySelector("#mail-compose-to").value'),'reply@example.test');
    expectedMailText=full+'\nMAIL_EDITOR_PRESERVED';await editText('#mail-compose-text',expectedMailText);await checkRefreshKeepsEditing('#mail-compose-text',expectedMailText);
    await evaluate('document.querySelector("#mail-compose-form").requestSubmit()');await waitFor('Boolean(document.querySelector("[data-action=mail-send]:not(:disabled)"))');
    assert.equal(calls.mailDrafts,1);assert.equal(calls.sends,0);await screenshot('mail-full-draft.png');
    await click('[data-page="wechat"]');await waitFor('Boolean(document.querySelector("[data-action=wechat-use-draft]"))');
    assert.equal(await evaluate('Array.from(document.querySelectorAll("[role=status]")).some(node=>node.getClientRects().length&&node.textContent.includes("名单待配置，新增会话尚未接收"))'),true);
    await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("#wechat-reply")?.value.endsWith("END_BEYOND_12000")');
    assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),full);
    const draftA=full+'\nWECHAT_EDITOR_PRESERVED',draftB='另一个会话的编辑草稿';
    await editText('#wechat-reply',draftA);await checkRefreshKeepsEditing('#wechat-reply',draftA);
    gate=holdRead();before=calls.reads;
    await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    assert.equal(await evaluate('document.querySelector("[data-action=wechat-use-draft]").textContent'),'正在读取…');
    await click('[data-action="wechat-use-draft"]');await click('[data-action="wechat-use-draft"]');assert.equal(calls.reads,before+1);
    await click('[data-action="wechat-conversation"][data-key="private:333"]');await editText('#wechat-reply',draftB);
    await click('[data-action="wechat-conversation"][data-key="private:222"]');gate.release();await waitFor('!document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),draftA);
    await click('[data-action="wechat-conversation"][data-key="private:333"]');assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),draftB);
    await click('[data-action="wechat-conversation"][data-key="private:222"]');
    gate=holdRead();await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    await click('[data-page="home"]');await click('[data-page="wechat"]');gate.release();await waitFor('!document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),draftA);
    gate=holdRead();await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    await editText('#wechat-reply',draftA+'\nPENDING_SUCCESS_EDIT');gate.release();
    await waitFor('!document.querySelector("[data-action=wechat-use-draft]")?.disabled');assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),draftA+'\nPENDING_SUCCESS_EDIT');
    gate=holdRead();await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("[data-action=wechat-use-draft]")?.disabled');
    await editText('#wechat-reply',draftA+'\nPENDING_EDIT');gate.reject(Error('synthetic-full-read-failure'));
    await waitFor('!document.querySelector("[data-action=wechat-use-draft]")?.disabled');assert.equal(await evaluate('document.querySelector("#wechat-reply").value'),draftA+'\nPENDING_EDIT');
    await click('[data-action="wechat-use-draft"]');await waitFor('document.querySelector("#wechat-reply")?.value.endsWith("END_BEYOND_12000")');
    await click('[data-action="wechat-access"]');await waitFor('Boolean(document.querySelector("#wechat-dsh-grants-form"))');
    assert.equal(await evaluate('document.querySelector("#wechat-computer-access").checked'),false);
    assert.equal(calls.computer,0);
    await checkAccessScrollAndFocus();
    await click('[data-wechat-dsh-kind="tools"][value="mcp_contract_search"]');
    await evaluate('document.querySelector("#wechat-dsh-grants-form").requestSubmit()');await waitFor('!document.querySelector("#wechat-dsh-grants-form button[type=submit]").disabled');
    assert.equal(calls.grants,1);await checkGrantCounts(3,1);await screenshot('wechat-conversation-access.png');
    await evaluate('document.querySelector(".wechat-dsh-access").scrollTop=document.querySelector(".wechat-dsh-access").scrollHeight');
    await screenshot('wechat-computer-access.png');
    await click('#wechat-computer-access');await evaluate('document.querySelector("#wechat-computer-access-form").requestSubmit()');await waitFor('!document.querySelector("#wechat-computer-access-form button[type=submit]").disabled');
    assert.equal(calls.computer,1);await checkGrantCounts(3,2);
    await click('#wechat-computer-access');await evaluate('document.querySelector("#wechat-computer-access-form").requestSubmit()');await waitFor('!document.querySelector("#wechat-computer-access-form button[type=submit]").disabled');
    assert.equal(calls.computer,2);await checkGrantCounts(3,1);assert.equal(await evaluate('document.querySelector("#wechat-computer-access").checked'),false);
    await click('[data-action="wechat-access-clear"]');await waitFor('!document.querySelector("#wechat-dsh-grants-form button[type=submit]").disabled');await checkGrantCounts(0,0);
    assert.equal(await evaluate('document.querySelector(".wechat-dsh-access").textContent.includes("old-unavailable")'),false);
    await click('[data-wechat-dsh-kind="tools"][value="mcp_contract_search"]');await evaluate('document.querySelector("#wechat-dsh-grants-form").requestSubmit()');await waitFor('!document.querySelector("#wechat-dsh-grants-form button[type=submit]").disabled');await checkGrantCounts(1,1);
    assert.equal(calls.grants,3);assert.equal(calls.sends,0);assert.deepEqual(errors,[]);
    const report={passed:true,hiddenWindow:true,syntheticOnly:true,realPreload:true,fullMailAndWechatTextPreserved:true,replyToSelected:true,unavailableGrantsDoNotBlockNewBusinessGrants:true,computerControlRequiresExplicitSave:true,pendingReadButtonsDisabled:true,repeatedReadsBlocked:true,backgroundRefreshPreservesTextAndSelection:true,conversationSwitchAndPageCloseKeepDrafts:true,failedReadKeepsEditsAndCanRetry:true,savedAndEffectiveGrantCountsAfterRevocation:true,grantPanelAndNestedScrollPreserved:true,grantCheckboxFocusPreserved:true,...calls};
    fs.writeFileSync(path.join(output,'feedback-ui-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } finally {window.destroy();}
}
app.whenReady().then(run).then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
