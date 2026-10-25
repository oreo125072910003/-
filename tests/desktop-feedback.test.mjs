import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {TextEncoder} from 'node:util';

// Exercise the real renderer functions with synthetic IPC. No windows or external sends.
const source=fs.readFileSync(new URL('../apps/desktop/renderer/app.js',import.meta.url),'utf8');
function fixture(api={}) {
  const listeners={},notices=[];
  const context=vm.createContext({window:{assistant:api},document:{querySelector:()=>null,addEventListener:(name,fn)=>listeners[name]=fn},TextEncoder,setTimeout,clearTimeout,notices});
  const end=source.lastIndexOf('\nrenderShell();');assert.ok(end>0);
  vm.runInContext(source.slice(0,end),context);
  vm.runInContext('renderPage=()=>{};renderShell=()=>{};renderMailPreservingFocus=()=>{};renderWechatPreservingFocus=()=>{};refresh=async()=>{};notify=(...args)=>notices.push(args);globalThis.subject={state,replyMail,useWechatDraft,navigate,selectWechatConversation,renderWechatInbox,renderMailInbox,saveWechatDshAccess,currentWechatGrants,renderWechatDshAccess,renderWechatComputerAccess,saveWechatComputerAccess,wechatAccessOperation,applyWechatState,renderWechatReaderConfiguration};',context);
  const f=context.subject;
  f.state.mail={accounts:[{id:'account'}],messages:[{id:'message',accountId:'account',from:[{address:'sender@example.test'}],replyTo:[{address:'reply@example.test'}],subject:'synthetic'}]};
  f.state.mailDraftTasks={message:'task'};f.state.tasks=[{id:'task',status:'succeeded',summary:'truncated summary'}];
  f.state.wechatAccountKey='111';f.state.wechat={settings:{boundAccountId:'111',connectionId:'connection',allowedPrivate:['222']},connection:{state:'ready'},messages:[{id:'wechat-message',kind:'private',conversationId:'222',taskId:'task',replyDraft:'truncated summary'}]};
  f.state.selectedConversationKey='private:222';f.state.selectedMessageId='wechat-message';
  return {...f,listeners,notices};
}
const plain=value=>JSON.parse(JSON.stringify(value));
function deferredReply() {
  let resolve,reject,calls=0;
  return {read:taskId=>{calls++;return new Promise((yes,no)=>{resolve=text=>yes({taskId,text});reject=no;});},resolve:text=>resolve(text),reject:error=>reject(error),get calls(){return calls;}};
}

test('mail reply prefers Reply-To and falls back to From without automatic sending',async()=>{
  const f=fixture();await f.replyMail();assert.equal(f.state.mailCompose.to,'reply@example.test');
  f.state.mail.messages[0].replyTo=[];await f.replyMail();assert.equal(f.state.mailCompose.to,'sender@example.test');assert.equal(f.state.mailCompose.text,'');
});
test('mail and WeChat fill complete artifacts including the tail beyond the summary',async()=>{
  const full='正文'.repeat(7000)+'\nUNTRUNCATED_END',calls=[];
  const f=fixture({getTaskReplyText:async taskId=>{calls.push(taskId);return {taskId,text:full};}});
  await f.replyMail(true);assert.equal(f.state.mailCompose.text,full);
  await f.useWechatDraft();assert.equal(f.state.wechatReply,full);assert.equal(f.state.wechatReplyByConversation['private:222'],full);
  assert.deepEqual(calls,['task','task']);assert.ok(f.notices.some(item=>item[0].includes('16000')));
});
test('failed full reply reads preserve existing edits and never use summaries',async()=>{
  const f=fixture({getTaskReplyText:async()=>{throw Error('artifact tampered');}});
  f.state.mailCompose.text='existing email';f.state.wechatReply='existing WeChat';
  await assert.rejects(f.replyMail(true),/artifact tampered/);await f.useWechatDraft();
  assert.equal(f.state.mailCompose.text,'existing email');assert.equal(f.state.wechatReply,'existing WeChat');
  assert.ok(f.notices.some(item=>item[0].includes('artifact tampered')));
});
test('oversized emails reject explicitly at 64000 characters with no partial draft',async()=>{
  let text='x'.repeat(64000);const f=fixture({getTaskReplyText:async taskId=>({taskId,text})});
  await f.replyMail(true);assert.equal(f.state.mailCompose.text.length,64000);
  text+='tail';await assert.rejects(f.replyMail(true),/64000.*未截断/);assert.equal(f.state.mailCompose.text.length,64000);
});
test('async full draft cannot be inserted after changing the selected account or message',async()=>{
  let resolve;const f=fixture({getTaskReplyText:taskId=>new Promise(r=>{resolve=()=>r({taskId,text:'full'});})});
  const mail=f.replyMail(true);f.state.mail.messages=[];resolve();await assert.rejects(mail,/邮件已改变/);
  const wechat=f.useWechatDraft();f.state.wechatAccountKey='333';resolve();await wechat;assert.equal(f.state.wechatReply,'');
});
test('pending mail and WeChat reads disable their buttons and repeated calls share one operation',async()=>{
  const read=deferredReply(),f=fixture({getTaskReplyText:read.read});
  const mail=f.replyMail(true);await f.replyMail(true);assert.equal(read.calls,1);assert.equal(f.state.mailBusy,'draft-read');
  assert.match(f.renderMailInbox(),/data-action="mail-use-draft" disabled>正在读取…/);
  read.resolve('complete mail');await mail;assert.equal(f.state.mailBusy,'');
  const wechat=f.useWechatDraft();await f.useWechatDraft();assert.equal(read.calls,2);assert.equal(f.state.wechatBusy,'draft-read');
  assert.match(f.renderWechatInbox(),/data-action="wechat-use-draft" disabled>正在读取…/);
  read.resolve('complete WeChat');await wechat;assert.equal(f.state.wechatBusy,'');assert.equal(f.state.wechatReply,'complete WeChat');
});
test('leaving and returning to the mail page invalidates a pending read and preserves another draft',async()=>{
  const read=deferredReply(),f=fixture({getTaskReplyText:read.read});f.state.page='mail';
  let pending=f.replyMail(true);f.navigate('wechat');f.navigate('mail');
  read.resolve('late reply');await assert.rejects(pending,/页面或邮件草稿已改变/);assert.equal(f.state.mailCompose.text,'');
  pending=f.replyMail(true);f.state.mailCompose={...f.state.mailCompose,text:'another edited draft'};
  read.resolve('late reply');await assert.rejects(pending,/页面或邮件草稿已改变/);assert.equal(f.state.mailCompose.text,'another edited draft');assert.equal(f.state.mailBusy,'');
});
test('switching away and back cancels an old WeChat fill while both conversation drafts survive',async()=>{
  const read=deferredReply(),f=fixture({getTaskReplyText:read.read});f.state.wechat.settings.allowedPrivate.push('333');
  f.state.wechat.messages.push({id:'other-message',kind:'private',conversationId:'333',text:'other'});
  f.state.wechatReply='draft A';f.state.wechatReplyByConversation['private:333']='draft B';
  const pending=f.useWechatDraft();f.selectWechatConversation('private:333');f.state.wechatReply='edited draft B';f.selectWechatConversation('private:222');
  read.resolve('late reply');await pending;assert.equal(f.state.wechatReply,'draft A');assert.equal(f.state.wechatReplyByConversation['private:333'],'edited draft B');
});
test('closing the WeChat page and editing during a pending read never overwrites text, and failure permits retry',async()=>{
  const read=deferredReply(),f=fixture({getTaskReplyText:read.read});f.state.page='wechat';f.state.wechatReply='before';
  let pending=f.useWechatDraft();f.navigate('home');f.navigate('wechat');read.resolve('late');await pending;assert.equal(f.state.wechatReply,'before');
  pending=f.useWechatDraft();f.state.wechatReply='new edit';read.resolve('late');await pending;assert.equal(f.state.wechatReply,'new edit');
  pending=f.useWechatDraft();read.reject(Error('synthetic read failure'));await pending;assert.equal(f.state.wechatBusy,'');assert.equal(f.state.wechatReply,'new edit');
  pending=f.useWechatDraft();read.resolve('retry complete');await pending;assert.equal(f.state.wechatReply,'retry complete');
});
test('conversation grants submit current grantable names, leaving unavailable selections read-only',async()=>{
  const calls=[],f=fixture({saveWechatDshGrants:async value=>{calls.push(plain(value));return {...f.state.wechatDshAccess,saved:value.grants};}});
  f.state.wechatDshAccess={connected:true,saved:{skills:['old-skill'],tools:['old-tool']},effective:{skills:[],tools:[]},unavailable:{skills:['old-skill'],tools:['old-tool']},catalog:{skills:[{name:'office',modelInvocable:true},{name:'internal',modelInvocable:false}],tools:[{name:'contract_search',grantable:true},{name:'shell',grantable:false,grantReason:'独立控制授权'}]}};
  f.state.wechatDshDraft={skills:['old-skill','office','internal'],tools:['old-tool','contract_search','shell']};f.state.wechatDshOpen=true;
  const html=f.renderWechatDshAccess({name:'合成好友'});assert.match(html,/本轮有效/);assert.match(html,/old-tool/);assert.doesNotMatch(html,/data-wechat-dsh-kind="tools" value="shell"/);
  await f.saveWechatDshAccess();assert.deepEqual(calls[0],{kind:'private',target:'222',grants:{skills:['office'],tools:['contract_search']}});
  await f.saveWechatDshAccess(true);assert.equal(calls[1].clearUnavailable,true);assert.deepEqual(calls[1].grants,{skills:[],tools:[]});
});
test('late grants from another conversation are discarded and account switches clear authorization UI',async()=>{
  let resolve;const f=fixture();const reading=f.wechatAccessOperation('read',()=>new Promise(r=>resolve=r));
  f.state.wechatAccountKey='333';resolve({saved:{tools:['wrong-account']}});await reading;assert.equal(f.state.wechatDshAccess,null);
  f.state.wechatDshOpen=true;f.applyWechatState({settings:{boundAccountId:'444',connectionId:'other'},messages:[]});assert.equal(f.state.wechatDshOpen,false);
});
test('new grants and revocation immediately render authoritative saved and effective counts',async()=>{
  const old={skills:[],tools:['old-unavailable']};
  const f=fixture({saveWechatDshGrants:async({grants,clearUnavailable})=>({...f.state.wechatDshAccess,saved:clearUnavailable?grants:{skills:grants.skills,tools:[...old.tools,...grants.tools]},effective:grants,unavailable:clearUnavailable?{skills:[],tools:[]}:old})});
  f.state.wechatDshAccess={connected:true,saved:old,effective:{skills:[],tools:[]},unavailable:old,catalog:{skills:[],tools:[{name:'business',grantable:true}]}};
  f.state.wechatDshDraft={skills:[],tools:['business']};await f.saveWechatDshAccess();
  let html=f.renderWechatDshAccess({kind:'private',name:'synthetic'});assert.match(html,/已保存：技能 0 项 · 工具 2 项/);assert.match(html,/本轮有效：技能 0 项 · 工具 1 项/);
  await f.saveWechatDshAccess(true);html=f.renderWechatDshAccess({kind:'private',name:'synthetic'});assert.match(html,/已保存：技能 0 项 · 工具 0 项/);assert.match(html,/本轮有效：技能 0 项 · 工具 0 项/);assert.doesNotMatch(html,/old-unavailable/);
});
test('pending reader configuration clearly says new chats are not receiving yet',()=>{
  const f=fixture();f.state.wechat.connection.readerConfiguration={state:'pending',detail:'合成配置需要同步'};
  assert.match(f.renderWechatReaderConfiguration(),/名单待配置，新增会话尚未接收/);
});
test('computer control stays off by default and only explicit private-chat saving invokes confirmation',async()=>{
  const calls=[],access={saved:{skills:[],tools:[]},catalog:{},computerAccess:{enabled:false,eligibleTools:['mcp_pcbridge_read_file']}};
  const f=fixture({saveWechatComputerAccess:async value=>calls.push(plain(value)),getWechatDshAccess:async()=>access});
  f.state.wechatDshAccess=access;
  const html=f.renderWechatComputerAccess({kind:'private'});assert.match(html,/读写本机文件/);assert.doesNotMatch(html,/type="checkbox" checked/);assert.equal(calls.length,0);
  assert.equal(f.renderWechatComputerAccess({kind:'group'}),'');
  await f.saveWechatComputerAccess(true);assert.deepEqual(calls[0],{kind:'private',target:'222',enabled:true,confirmation:'allow-computer-control'});
  await f.saveWechatComputerAccess(false);assert.deepEqual(calls[1],{kind:'private',target:'222',enabled:false});
});
test('full replies and grants have fixed preload IPC channels and reject untrusted desktop callers',async()=>{
  const preload=fs.readFileSync(new URL('../apps/desktop/preload.cjs',import.meta.url),'utf8'),main=fs.readFileSync(new URL('../apps/desktop/main.cjs',import.meta.url),'utf8');
  const methods=['getTaskReplyText','getWechatDshAccess','saveWechatDshGrants','importWechatDshGrants','saveWechatComputerAccess'];
  let api;const invocations=[],handlers=new Map(),service=Object.fromEntries(methods.map(name=>[name,(...args)=>({name,args})]));
  vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld:(_name,value)=>api=value},ipcRenderer:{invoke:(...args)=>invocations.push(args)}})});
  for(const method of methods){api[method]('fixture');assert.deepEqual(invocations.at(-1),['assistant:'+method,'fixture']);}
  const registration=main.slice(main.indexOf('async function registerIPC(){'),main.indexOf('async function smokeTest(){'));
  const context=vm.createContext({ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},trusted:event=>event.desktop===true,service});
  vm.runInContext(registration,context);await vm.runInContext('registerIPC()',context);
  for(const method of methods){const handler=handlers.get('assistant:'+method);assert.equal(typeof handler,'function');await assert.rejects(handler({},'fixture'),/无权/);assert.deepEqual(plain(await handler({desktop:true},'fixture')),{name:method,args:['fixture']});}
});
