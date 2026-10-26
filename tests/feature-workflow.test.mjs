import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssistantService } from '../apps/service/index.mjs';
import { PRODUCT_TOOLS } from '../packages/contracts/product-tools.mjs';
import { describeTool } from '../packages/contracts/tool-policy.mjs';

async function until(check) { const end = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < end, 'workflow did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function fixture(t, { rejected = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xzs-feature-flow-')), source = path.join(root, 'legacy'), data = path.join(root, 'product');
  fs.mkdirSync(path.join(source,'config'),{recursive:true});fs.mkdirSync(path.join(source,'state/hook'),{recursive:true});
  const grants = { skills: [], tools: ['mcp__pcbridge__run_local_shell','mcp__pcbridge__send_image'] };
  fs.writeFileSync(path.join(source,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},hook:{baseUrl:'http://127.0.0.1:30001',expectedVersion:'4.1.10.27'},wechat:{whitelist:{private:['101','102'],groups:['201']},dshAccess:{chats:{'wechat:private:101':grants,'wechat:group:201':grants}}}}));
  fs.writeFileSync(path.join(source,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'synthetic-only-reader-token'}));fs.writeFileSync(path.join(source,'state/hook/native-token.txt'),'b'.repeat(64));
  const secrets=new Map(),sends=[],requests=[],toolResults=[];let callbacks;
  const call=async(connection,name,args)=>{const response=await fetch(connection.endpoint,{method:'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},body:JSON.stringify({id:randomUUID(),name,args})});const result=await response.json();toolResults.push(result);assert.equal(result.isError,false,result.content);return JSON.parse(result.content);};
  const runtime={inspectHostedRuntime:async()=>({available:true,ready:true,capabilities:{images:false}}),readHostedCatalog:async()=>({ok:true,metadataOnly:true,skills:[],tools:[...PRODUCT_TOOLS.map(tool=>({...tool,...describeTool(tool.name)})),{name:'mcp__pcbridge__run_local_shell',...describeTool('mcp__pcbridge__run_local_shell')}]}),
    runHostedTask:async input=>{requests.push(input);const created=await call(input.settings.hostedProductConnection,'xiaozhushou_document',{title:'合成合同资料',blocks:[{type:'paragraph',text:'这是用于验证的合成资料，数量 12，金额 240。'}],formats:['docx']});await call(input.settings.hostedProductConnection,'xiaozhushou_attachment',{artifactId:created.artifacts[0].id,mediaType:'file'});return{ok:true,finalText:'资料文档已经准备好。',sessionId:input.sessionId??'xzs-'+'a'.repeat(32),artifacts:[]};}};
  const service=await createAssistantService({dataDir:data,runtime,secretStore:{get:key=>secrets.get(key),set:(key,value)=>secrets.set(key,value),delete:key=>secrets.delete(key)},legacySources:[{kind:'wechatagent',path:source}],wechatBridgeFactory:value=>{callbacks=value;return{start:async()=>value.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true}),stop:async()=>{},sendText:async value=>{value.beforeSubmit();sends.push({type:'text',...value});return{receipt:'wechat-server-id',delivered:'database-confirmed',message_id:'9002'};},sendAttachment:async value=>{value.beforeSubmit();sends.push({type:'file',...value});if(rejected)throw Object.assign(Error('WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE'),{code:'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE',attempted:false});return{receipt:'wechat-server-id',delivered:'database-confirmed',message_id:'9001',media_type:'wechat-file'};}};}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.importWechatConnection(source,{automatic:true});const recovery=await service.restoreProductFeatures();
  const incoming=()=>callbacks.onMessage({self_id:'777',kind:'private',conversation_id:'101',conversation_name:'合成测试聊天',sender_id:'101',sender_name:'合成测试用户',text:'生成文档并发给我',message_id:randomUUID(),time:Math.ceil(Date.now()/1000)});
  return{service,data,recovery,requests,toolResults,sends,incoming};
}

test('feature recovery restores only original private computer selections; groups and unselected private chats stay without computer access',async t=>{
  const f=await fixture(t);assert.equal(f.recovery.wechat.restored,true);assert.equal(f.recovery.wechat.computerChats,1);
  const selected=await f.service.getWechatDshAccess({kind:'private',target:'101'}),other=await f.service.getWechatDshAccess({kind:'private',target:'102'}),group=await f.service.getWechatDshAccess({kind:'group',target:'201'});
  assert.equal(selected.computerAccess.enabled,true);assert.ok(selected.effective.tools.includes('xiaozhushou_screenshot'));assert.ok(selected.effective.tools.includes('xiaozhushou_run_local_shell'));
  assert.equal(other.computerAccess.enabled,false);assert.equal(group.computerAccess.enabled,false);assert.ok(!group.effective.tools.includes('xiaozhushou_run_local_shell'));
  assert.ok(group.saved.tools.includes('mcp__pcbridge__run_local_shell'),'original choices retained');assert.ok(group.effective.tools.includes('xiaozhushou_document'));
  assert.ok(!group.effective.tools.includes('xiaozhushou_mail'),'mail content not exposed to group defaults');
});

test('original-chat task generates a real document, persists a delivery plan, sends its explanation before the immutable snapshot, and resumes its original session',async t=>{
  const f=await fixture(t);f.incoming();await until(async()=>f.sends.length===2&&(await f.service.getWechatState()).autoReply.active===0);
  assert.deepEqual(f.sends.map(item=>item.type),['text','file']);assert.equal(f.sends[0].target,'101');assert.equal(f.sends[0].signal.aborted,false);
  const first=f.service.listTasks()[0];assert.equal(first.status,'succeeded');assert.equal(first.wechatDeliveries.length,1);assert.ok(f.service.getTask(first.id).artifacts.some(item=>item.name.endsWith('.docx')));
  assert.equal(first.title,'微信 · 生成文档并发给我');assert.equal(first.requestText,'生成文档并发给我');
  assert.equal(f.requests[0].settings.hostedExecutionPolicy,'trusted-computer-task-v1');assert.equal(f.requests[0].settings.hostedProductConnection!==undefined,true);
  f.incoming();await until(async()=>f.sends.length===4&&(await f.service.getWechatState()).autoReply.active===0);
  assert.equal(f.requests[1].sessionId,'xzs-'+'a'.repeat(32));assert.equal(f.requests[0].workspace,f.requests[1].workspace);
  assert.ok((await f.service.getWechatState()).outbox.every(item=>item.status==='delivered'));
  const connection=f.requests[0].settings.hostedProductConnection;await assert.rejects(fetch(connection.endpoint,{headers:{authorization:'Bearer '+connection.token}}),'completed task capability is closed');
});

test('rejected media remains a rejected delivery, preserves the artifact, and sends an accurate notice instead of a completed-send claim',async t=>{
  const f=await fixture(t,{rejected:true});f.incoming();await until(async()=>f.sends.length===3&&(await f.service.getWechatState()).autoReply.active===0);
  const state=await f.service.getWechatState();assert.equal(state.outbox.filter(item=>item.mediaType==='file')[0].status,'rejected');assert.match(f.sends[2].text,/还没确认送达/);assert.equal(f.sends[0].text,'资料文档已经准备好。');
  const task=f.service.listTasks()[0];assert.ok(fs.existsSync(f.service.resolveArtifact(task.wechatDeliveries[0].artifactId)));assert.equal(f.sends.filter(item=>item.type==='file').length,1);
});
