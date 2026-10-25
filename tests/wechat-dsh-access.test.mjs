import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWechatDshAccess} from '../apps/service/wechat-dsh-access.mjs';
import {createDshAccess} from '../apps/service/dsh-access.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-chat-grants-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let settings={wechatConnection:{boundAccountId:'777',connectionId:'connection-a',hookBaseUrl:'http://127.0.0.1:30001',readerBaseUrl:'http://127.0.0.1:5031',allowedPrivate:['101','102'],allowedGroups:['201']},dshOwnerGrants:{tools:['mcp__contract_helper__query_inventory'],skills:[]}};
  let connected=true,online=true;
  const store={getSettings:()=>structuredClone(settings),saveSettings:patch=>{settings={...settings,...structuredClone(patch)};}};
  const tools=[{name:'mcp__pcbridge__fetch_scores',grantable:true},{name:'mcp__pcbridge__run_local_shell',grantable:false,computerGrantable:true},{name:'mcp__contract_helper__query_inventory',grantable:true}];
  const dshAccess=createDshAccess({store,settingsProvider:async()=>({hostedConfigFile:'G:/synthetic/client.json'}),runtime:{readHostedCatalog:async()=>online?{ok:true,metadataOnly:true,tools,skills:[{name:'literature-search',modelInvocable:true}]}:{ok:false}}});
  const legacy=path.join(root,'legacy');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'state'));
  fs.writeFileSync(path.join(legacy,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook'},hook:{baseUrl:'http://127.0.0.1:30001'},wechat:{dshAccess:{chats:{'wechat:private:101':{tools:['mcp__pcbridge__fetch_scores','mcp__pcbridge__run_local_shell'],skills:['literature-search']},'wechat:private:999':{tools:['mcp__pcbridge__fetch_scores']}}}}}));
  fs.writeFileSync(path.join(legacy,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031'}));
  const access=createWechatDshAccess({store,dshAccess,legacySources:[{kind:'wechatagent',path:legacy}],getWechatState:async()=>({connection:{state:connected?'ready':'offline',accountVerified:connected,selfId:settings.wechatConnection.boundAccountId}})});
  return {access,store,dshAccess,get settings(){return settings;},set connected(v){connected=v;},set online(v){online=v;}};
}
const inbound=(overrides={})=>({accountId:'777',kind:'private',conversationId:'101',outgoing:false,...overrides});

test('legacy selections bind only the verified account and existing allowed chats; control choices remain visible but ineffective',async t=>{
  const f=fixture(t);const result=await f.access.importLegacy();
  assert.equal(result.chatsImported,1);
  const state=await f.access.getState({kind:'private',target:'101'});
  assert.deepEqual(state.saved.tools,['mcp__pcbridge__fetch_scores','mcp__pcbridge__run_local_shell']);
  assert.deepEqual(state.effective,{skills:['literature-search'],tools:['mcp__pcbridge__fetch_scores']});
  assert.deepEqual(state.unavailable.tools,['mcp__pcbridge__run_local_shell']);
  assert.deepEqual(await f.access.grantsForMessage(inbound()),state.effective);
  assert.deepEqual(await f.access.grantsForMessage(inbound({conversationId:'102'})),{skills:[],tools:[]},'no owner inheritance for an unassigned chat');
  assert.deepEqual(await f.access.grantsForMessage(inbound({conversationId:'999'})),{skills:[],tools:[]});
  assert.deepEqual(f.settings.dshOwnerGrants,{tools:['mcp__contract_helper__query_inventory'],skills:[]});
});
test('explicit chat revocation survives reimport and disconnection prevents stale grants',async t=>{
  const f=fixture(t);await f.access.importLegacy();
  await f.access.saveGrants({kind:'private',target:'101',grants:{skills:[],tools:[]},clearUnavailable:true});
  await f.access.importLegacy();assert.deepEqual(await f.access.grantsForMessage(inbound()),{skills:[],tools:[]});
  await f.access.saveGrants({kind:'private',target:'102',grants:{tools:['mcp__pcbridge__fetch_scores']}});
  f.online=false;assert.deepEqual(await f.access.grantsForMessage(inbound({conversationId:'102'})),{skills:[],tools:[]});
  await f.access.saveGrants({kind:'private',target:'102',grants:{}});
  f.connected=false;assert.deepEqual(await f.access.grantsForMessage(inbound()),{skills:[],tools:[]});
});
test('account switch, outgoing messages and removed conversation authorization cannot inherit old grants',async t=>{
  const f=fixture(t);await f.access.importLegacy();
  assert.deepEqual(await f.access.grantsForMessage(inbound({outgoing:true})),{skills:[],tools:[]});
  const current=f.settings.wechatConnection;f.store.saveSettings({wechatConnection:{...current,boundAccountId:'888'}});
  assert.deepEqual(await f.access.grantsForMessage(inbound({accountId:'888'})),{skills:[],tools:[]});
  await assert.rejects(f.access.importLegacy(),/另一微信账号/);
  f.store.saveSettings({wechatConnection:{...current,allowedPrivate:[]}});
  assert.deepEqual(await f.access.grantsForMessage(inbound()),{skills:[],tools:[]});
});
test('a legacy catalog that calls all controls grantable cannot authorize them through desktop or chat selection',async t=>{
  const f=fixture(t);
  await assert.rejects(f.dshAccess.saveGrants({tools:['mcp__pcbridge__run_local_shell']}),{code:'DSH_GRANT_NOT_AVAILABLE'});
  await assert.rejects(f.access.saveGrants({kind:'private',target:'101',grants:{tools:['mcp__pcbridge__run_local_shell']}}),{code:'WECHAT_DSH_ACCESS_DENIED'});
  assert.deepEqual(f.settings.dshOwnerGrants,{tools:['mcp__contract_helper__query_inventory'],skills:[]});
});

test('editing ordinary tools preserves previously unavailable choices without activating them or accepting new controls',async t=>{
  const f=fixture(t);await f.access.importLegacy();
  const result=await f.access.saveGrants({kind:'private',target:'101',grants:{tools:['mcp__contract_helper__query_inventory']}});
  assert.deepEqual(result.effective.tools,['mcp__contract_helper__query_inventory']);
  assert.deepEqual(result.unavailable.tools,['mcp__pcbridge__run_local_shell']);
  const cleared=await f.access.saveGrants({kind:'private',target:'101',grants:{},clearUnavailable:true});
  assert.deepEqual(cleared.saved,{skills:[],tools:[]});
});

test('computer authority requires a separate explicit private-chat approval and never carries to another account, chat or group',async t=>{
  const f=fixture(t);await f.access.importLegacy();
  await assert.rejects(f.access.saveComputerAccess({kind:'group',target:'201',enabled:true,confirmation:'allow-computer-control'}),{code:'WECHAT_DSH_ACCESS_DENIED'});
  await assert.rejects(f.access.saveComputerAccess({kind:'private',target:'101',enabled:true}),{code:'WECHAT_DSH_ACCESS_DENIED'});
  await f.access.saveComputerAccess({kind:'private',target:'101',enabled:true,confirmation:'allow-computer-control'});
  const access=await f.access.accessForMessage(inbound());
  assert.equal(access.executionPolicy,'trusted-computer-task-v1');
  assert.deepEqual(access.computerScope,{accountId:'777',kind:'private',target:'101'});
  assert.ok(access.grants.tools.includes('mcp__pcbridge__run_local_shell'));
  assert.equal((await f.access.accessForMessage(inbound({conversationId:'102'}))).executionPolicy,undefined);
  assert.equal((await f.access.accessForMessage(inbound({kind:'group',conversationId:'201'}))).executionPolicy,undefined);
  await f.access.saveComputerAccess({kind:'private',target:'101',enabled:false});
  assert.equal((await f.access.accessForMessage(inbound())).executionPolicy,undefined);
  assert.ok(!(await f.access.grantsForMessage(inbound())).tools.includes('mcp__pcbridge__run_local_shell'));
});
