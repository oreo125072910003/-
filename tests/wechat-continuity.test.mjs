import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAssistantService} from '../apps/service/index.mjs';

const waitFor=async predicate=>{const until=Date.now()+6000;while(!await predicate()){if(Date.now()>until)throw Error('自动回复没有完成');await new Promise(resolve=>setTimeout(resolve,20));}};
test('new WeChat messages use DSH directly, retain native conversation across restart and send the full reply once',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-continuity-')),source=path.join(root,'legacy'),dataDir=path.join(root,'product');
  fs.mkdirSync(path.join(source,'config'),{recursive:true});fs.mkdirSync(path.join(source,'state','hook'),{recursive:true});
  fs.writeFileSync(path.join(source,'config','wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},hook:{expectedVersion:'4.1.10.27',baseUrl:'http://127.0.0.1:30001'},wechat:{whitelist:{private:['101','102'],groups:[]},wake_mode:'mention',wake_words:['小助手']}}));
  fs.writeFileSync(path.join(source,'state','wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'synthetic-reader-token-continuity'}));
  fs.writeFileSync(path.join(source,'state','hook','native-token.txt'),'a'.repeat(64));
  const secrets=new Map(),requests=[],sends=[],sessions=new Map();let callbacks,service;
  const secretStore={get:async key=>secrets.get(key),set:async(key,value)=>secrets.set(key,value),delete:async key=>secrets.delete(key)};
  const longReply='完整回复：'+'a'.repeat(12500)+'末尾保留';
  const runtime={inspectHostedRuntime:async()=>({available:true,ready:true,modelVerified:true}),readHostedCatalog:async()=>({ok:true,skills:[],tools:[]}),runHostedTask:async options=>{
    requests.push(options);if(!sessions.has(options.workspace))sessions.set(options.workspace,'xzs-'+(sessions.size?'b':'a').repeat(32));
    return{ok:true,sessionId:options.sessionId??sessions.get(options.workspace),finalText:requests.length===1?longReply:'小助手记得这段会话。'};
  }};
  const create=()=>createAssistantService({dataDir,runtime,secretStore,legacySources:[{id:'legacy',kind:'wechatagent',path:source}],wechatBridgeFactory:options=>{
    callbacks=options;return{start:async()=>options.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true,account:{id:'777',name:'合成登录用户'}}),stop:async()=>{},sendText:async value=>{sends.push(value);return{receipt:'wechat-server-id',delivered:'database-confirmed',message_id:String(sends.length)};}};
  }});
  const emit=(id,target='101')=>callbacks.onMessage({self_id:'777',kind:'private',conversation_id:target,sender_id:target,sender_name:'合成联系人',conversation_name:'合成聊天 '+target,text:'你好，请接着聊。',message_id:id,time:Math.ceil(Date.now()/1000)});
  t.after(async()=>{await service?.close();fs.rmSync(root,{recursive:true,force:true});});
  service=await create();await service.importWechatConnection(source,{automatic:true});
  assert.equal((await service.getWechatState()).settings.autoReply,true);assert.equal((await service.getWechatState()).connection.state,'ready');
  emit('1');await waitFor(()=>sends.length===1);
  assert.equal(sends[0].text,longReply);assert.equal(service.listTasks()[0].summary.length,12000);
  emit('1');await new Promise(resolve=>setTimeout(resolve,50));assert.equal(sends.length,1);
  emit('2');await waitFor(()=>sends.length===2);
  assert.equal(requests[1].sessionId,'xzs-'+'a'.repeat(32));assert.equal(requests[0].workspace,requests[1].workspace);
  assert.equal(requests[0].conversation.channel,'wechat');assert.match(requests[0].workspace,/conversations/);
  assert.notEqual(service.listTasks()[0].workspace,service.listTasks()[1].workspace);
  await service.close();service=await create();await service.resumeWechatOnStartup();
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(sends.length,2,'restart does not replay inbox');
  emit('3');await waitFor(()=>sends.length===3);assert.equal(requests[2].sessionId,'xzs-'+'a'.repeat(32));assert.equal(requests[2].workspace,requests[0].workspace);
  emit('4','102');await waitFor(()=>sends.length===4);assert.equal(requests[3].sessionId,undefined);assert.notEqual(requests[3].workspace,requests[0].workspace);
  for(const request of requests)assert.deepEqual(request.settings.hostedOwnerGrants,{skills:[],tools:[]});
  assert(fs.existsSync(path.join(dataDir,'db','assistant.sqlite')));
});

test('production startup fills automatic defaults while retaining a deliberate pause',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-startup-'));let started=0;
  const {createStore}=await import('../packages/storage/index.mjs');const store=await createStore(path.join(root,'db'));
  store.saveSettings({wechatConnection:{connectionId:'test-connection',boundAccountId:'777',allowedPrivate:['101'],allowedGroups:[]}});store.close();
  const value=JSON.stringify({connectionId:'test-connection',readerToken:'synthetic-reader-token-startup',nativeToken:'b'.repeat(64)});
  const service=await createAssistantService({dataDir:root,runtime:{},secretStore:{get:async name=>name==='wechat-connection'?value:null},wechatBridgeFactory:options=>({start:async()=>{started++;options.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true});},stop:async()=>{}})});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const resumed=await service.resumeWechatOnStartup();assert.equal(started,1);assert.equal(resumed.settings.autoReply,true);assert.equal(resumed.settings.autoConnect,true);
  await service.saveWechatSettings({autoReply:false,autoConnect:false});await service.disconnectWechat();
  await service.resumeWechatOnStartup();assert.equal((await service.getWechatState()).settings.autoReply,false);assert.equal(started,2,'settings reconnects once, startup respects explicit pause');
});

test('malformed legacy wake rules cannot prevent a valid saved connection from resuming',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-invalid-wake-')),source=path.join(root,'legacy');let starts=0;
  fs.mkdirSync(path.join(source,'config'),{recursive:true});fs.writeFileSync(path.join(source,'config','wechatagent.json'),JSON.stringify({wechat:{wake_words:'not-an-array',chatModes:[]}}));
  const {createStore}=await import('../packages/storage/index.mjs');const store=await createStore(path.join(root,'db'));
  store.saveSettings({wechatConnection:{connectionId:'saved',boundAccountId:'777',allowedPrivate:['101'],allowedGroups:[]}});store.close();
  const secret=JSON.stringify({connectionId:'saved',readerToken:'synthetic-reader-token',nativeToken:'c'.repeat(64)});
  const service=await createAssistantService({dataDir:root,runtime:{},legacySources:[{id:'legacy',kind:'wechatagent',path:source}],secretStore:{get:async name=>name==='wechat-connection'?secret:null},wechatBridgeFactory:options=>({start:async()=>{starts++;options.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true});},stop:async()=>{}})});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  const state=await service.resumeWechatOnStartup();assert.equal(starts,1);assert.equal(state.connection.state,'ready');assert.equal(state.settings.autoReply,true);assert.equal(state.settings.autoConnect,true);
  assert.equal(state.settings.wakeMode,'mention');assert.deepEqual(state.settings.wakeWords,[]);assert.deepEqual(state.settings.chatModes,{});
});
