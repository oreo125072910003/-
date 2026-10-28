import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { TextEncoder } from 'node:util';

// Run the real renderer event handlers with synthetic IPC only.
function fixture() {
  const calls=[],notices=[];
  const outcome={status:'rejected',error:'确认未发送'};
  const api={sendWechatMessage:async value=>{calls.push(value);return{...outcome};},sendWechatSticker:async value=>{calls.push(value);return{...outcome};}};
  const source=fs.readFileSync(new URL('../apps/desktop/renderer/app.js',import.meta.url),'utf8');
  const context=vm.createContext({window:{assistant:api,addEventListener:()=>{}},document:{querySelector:()=>null,addEventListener:()=>{}},TextEncoder,crypto,setTimeout,clearTimeout,notices});
  const end=source.lastIndexOf('\nrenderShell();');assert(end>0);
  vm.runInContext(source.slice(0,end),context);
  vm.runInContext('renderPage=()=>{};renderWechatPreservingFocus=()=>{};refresh=async()=>{};notify=(...args)=>notices.push(args);globalThis.subject={state,sendWechatReply,sendWechatSticker,wechatSendRequest};',context);
  const subject=context.subject;
  subject.state.wechat={settings:{boundAccountId:'777',allowedPrivate:['101']},connection:{state:'ready'},sessions:[{id:'101',kind:'private',allowed:true}],messages:[],outbox:[]};
  subject.state.wechatAccountKey='777';subject.state.selectedConversationKey='private:101';subject.state.wechatReply='合成测试正文';
  return{...subject,calls,outcome,notices};
}

test('only explicit clicks after rejected text or sticker results create a new request',async()=>{
  for(const kind of ['text','sticker']){
    const f=fixture(),click=()=>kind==='text'?f.sendWechatReply({preventDefault(){}}):f.sendWechatSticker('d'.repeat(64));
    await click();const first=f.calls[0].requestId;
    assert.equal(f.calls.length,1,'rejection must not schedule a retry');
    await click();assert.equal(f.calls.length,2);assert.notEqual(f.calls[1].requestId,first);
    f.outcome.status='unconfirmed';await click();const uncertain=f.calls.at(-1).requestId;
    await click();assert.equal(f.calls.at(-1).requestId,uncertain,'unknown delivery reuses the old operation');
  }
});

test('persisted rejected rows allow explicit retry while unknown rows never get a fresh request',()=>{
  const f=fixture(),key='text:private:101',value='合成正文',first=f.wechatSendRequest(key,value);
  f.state.wechat.outbox=[{requestId:first,status:'unconfirmed'}];assert.equal(f.wechatSendRequest(key,value),first);
  f.state.wechat.outbox[0].status='rejected';const second=f.wechatSendRequest(key,value);assert.notEqual(second,first);
  f.state.wechat.outbox=[{requestId:second,status:'delivered'}];assert.equal(f.wechatSendRequest(key,value),second);
});
