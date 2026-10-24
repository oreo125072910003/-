import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStore } from '../packages/storage/index.mjs';
import { createWechatController } from '../apps/service/wechat.mjs';
import { createAssistantService } from '../apps/service/index.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requestId = () => 'request_' + randomUUID();
const until = async check => { const deadline=Date.now()+3000;while(!await check()){if(Date.now()>deadline)throw Error('synthetic attachment fixture timed out');await new Promise(resolve=>setTimeout(resolve,8));} };

async function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-wechat-attachments-')),dataDir=path.join(root,'product'),sources=path.join(root,'sources');
  fs.mkdirSync(sources);
  const granted=new Set(),state={sends:[],textSends:[],cancels:[],tasks:[],clock:Date.now(),callbacks:null};
  let store=await createStore(path.join(dataDir,'db')),controller;
  store.saveSettings({wechatConnection:{connectionId:'synthetic-attachment-connection',boundAccountId:'777',allowedPrivate:['101','102'],allowedGroups:['202'],autoReply:options.auto===true}});
  const secrets={get:async key=>key==='wechat-connection'?JSON.stringify({connectionId:'synthetic-attachment-connection',readerToken:'synthetic-reader-token',nativeToken:'a'.repeat(64)}):undefined};
  function makeController() {
    controller=createWechatController({store,dataDir,secretStore:secrets,
      authorizeAttachment:options.noAuthorization?undefined:filename=>granted.delete(path.resolve(filename)),
      autoOptions:{now:()=>state.clock,pollMs:5},
      bridgeFactory:callbacks=>{state.callbacks=callbacks;return{
        async start(){callbacks.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true});},async stop(){},
        async sendAttachment(value){state.sends.push({...value,bytes:fs.readFileSync(value.path)});if(state.gate)await state.gate;if(state.error)throw state.error;return state.receipt??{receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-'+value.mediaType,message_id:'9001'};},
        async sendText(value){state.textSends.push(value);return{receipt:'wechat-server-id',delivered:'database-confirmed',message_id:'9002'};},
      };},
      async createTask(value){const id='task_'+randomUUID();store.createTask({id,title:'合成待发回复',prompt:value.prompt,kind:'agent',status:'running',createdAt:new Date().toISOString(),workspace:path.join(dataDir,'tasks',id),attachments:[]});state.tasks.push(id);return store.getTask(id);},
      getTask:id=>({task:store.getTask(id)}),readTaskReply:async()=> '不应与手动附件重复发送的合成回复。',
      async cancelTask(id){state.cancels.push(id);const task=store.getTask(id);if(task&&!['succeeded','cancelled','failed'].includes(task.status))store.updateTask(id,{status:'cancelled'});},
    });
  }
  makeController();await controller.connect();
  t.after(async()=>{await controller.close();store.close();const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));fs.rmSync(resolved,{recursive:true,force:true});});
  let serial=0;
  function source(name='合成材料.pdf',bytes=Buffer.from('%PDF-1.7\nsynthetic-only\n')){const filename=path.join(sources,(++serial)+'_'+name);fs.writeFileSync(filename,bytes);return filename;}
  async function stage(filename,mediaType='file'){granted.add(path.resolve(filename));return controller.stageAttachment({path:filename,mediaType});}
  return{root,dataDir,sources,state,granted,source,stage,get controller(){return controller;},get store(){return store;},
    async reopen(){await controller.close();store.close();store=await createStore(path.join(dataDir,'db'));store.recover();makeController();await controller.connect();},
    emit(){state.callbacks.onMessage({self_id:'777',kind:'private',conversation_id:'101',sender_id:'101',sender_name:'合成联系人',text:'合成消息',message_id:'incoming-'+randomUUID(),time:Math.ceil(state.clock/1000)+1});},
  };
}

test('picker grants are required, consumed once, and cannot be replaced by inbound text paths',async t=>{
  const f=await fixture(t),filename=f.source();
  await assert.rejects(f.controller.stageAttachment({path:filename,mediaType:'file'}),/选择附件按钮/);
  f.emit();
  await assert.rejects(f.controller.sendAttachment({kind:'private',target:'101',attachmentId:filename,requestId:requestId()}),/桌面授权/);
  const selected=await f.stage(filename);
  assert.match(selected.id,/^wxatt_[a-f0-9]{32}$/);assert.equal(selected.id,selected.attachmentId);
  await assert.rejects(f.controller.stageAttachment({path:filename,mediaType:'file'}),/选择附件按钮/);
  assert.equal(f.state.sends.length,0);
  const missing=await fixture(t,{noAuthorization:true});
  await assert.rejects(missing.controller.stageAttachment({path:missing.source(),mediaType:'file'}),/选择附件按钮/);
});

test('staging creates an independent persisted SHA256 snapshot and public state contains no filesystem path',async t=>{
  const f=await fixture(t),original=Buffer.from('%PDF-1.7\noriginal synthetic content'),filename=f.source('合成合同.pdf',original);
  const selected=await f.stage(filename),registered=f.store.getWechatAttachment(selected.id);
  assert.equal(selected.sha256,digest(original));assert.equal(selected.size,original.length);assert.equal(selected.mime,'application/pdf');
  assert.notEqual(registered.path,filename);assert.ok(registered.path.startsWith(path.join(fs.realpathSync(f.dataDir),'wechat','outgoing')+path.sep));
  fs.writeFileSync(filename,'changed source must never change the authorized snapshot');
  assert.deepEqual(fs.readFileSync(registered.path),original);
  const result=await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()});
  assert.equal(result.status,'delivered');assert.equal(result.mediaType,'file');assert.equal(result.attachmentId,selected.id);
  assert.equal(result.name,selected.name);assert.equal(result.sha256,selected.sha256);assert.equal(result.size,selected.size);
  assert.deepEqual(f.state.sends[0].bytes,original);assert.equal(f.state.sends[0].mime,'application/pdf');
  const state=await f.controller.getState(),publicText=JSON.stringify({selected,result,state});
  assert.equal(publicText.includes(filename),false);assert.equal(publicText.includes(registered.path),false);assert.equal(publicText.includes(f.dataDir),false);
  assert.equal(Object.hasOwn(state.attachments[0],'path'),false);assert.equal(Object.hasOwn(state.outbox[0],'path'),false);
  await assert.rejects(async()=>f.store.addWechatAttachment({...registered,sha256:'0'.repeat(64)}),/不能覆盖/);
  assert.equal(f.store.getWechatAttachment(selected.id).sha256,selected.sha256);
});

test('image and document limits are exact and image uploads require a recognized image signature',async t=>{
  const f=await fixture(t),bad=f.source('不是图片.png',Buffer.from('synthetic ordinary text'));
  await assert.rejects(f.stage(bad,'image'),/不是可发送/);
  await assert.rejects(f.stage(f.source('empty.pdf',Buffer.alloc(0))),/不能为空/);
  await assert.rejects(f.stage(f.sources),/普通文件/);
  for(const [mediaType,limit,name]of[['image',8*1024*1024,'合成图片.png'],['file',50*1024*1024,'合成文档.bin']]){
    const large=f.source(name,mediaType==='image'?png:Buffer.from('synthetic'));
    fs.truncateSync(large,limit+1);await assert.rejects(f.stage(large,mediaType),mediaType==='image'?/8 MiB/:/50 MiB/);
    fs.truncateSync(large,limit);const accepted=await f.stage(large,mediaType);assert.equal(accepted.size,limit);
  }
  assert.equal(f.state.sends.length,0);
});

test('image receipts must identify the image media type and a real nonzero server id',async t=>{
  const f=await fixture(t),image=await f.stage(f.source('合成图片.png',png),'image');
  for(const receipt of[
    {delivered:'database-confirmed',media_type:'wechat-image',message_id:'91'},
    {receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-file',message_id:'91'},
    {receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-image'},
    {receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-image',message_id:'0'},
  ]){
    f.state.receipt=receipt;
    assert.equal((await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:image.id,requestId:requestId()})).status,'unconfirmed');
  }
  f.state.receipt={receipt:'wechat-server-id',delivered:'database-confirmed',media_type:'wechat-image',message_id:'91001'};
  const delivered=await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:image.id,requestId:requestId()});
  assert.equal(delivered.status,'delivered');assert.equal(delivered.receipt.messageId,'91001');
  assert.equal(f.state.sends[0].mediaType,'image');assert.equal(f.state.sends[0].mime,'image/png');
});

test('concurrent duplicate clicks submit once and a reused request id cannot change attachment or media type',async t=>{
  const f=await fixture(t),one=await f.stage(f.source()),two=await f.stage(f.source('另一个材料.txt',Buffer.from('different synthetic contents')));
  let release;f.state.gate=new Promise(resolve=>{release=resolve;});
  const request={kind:'private',target:'101',attachmentId:one.id,requestId:requestId()},pending=f.controller.sendAttachment(request);
  const duplicate=await f.controller.sendAttachment(request);
  assert.equal(duplicate.status,'sending');assert.equal(f.state.sends.length,1);
  await assert.rejects(f.controller.sendAttachment({...request,attachmentId:two.id}),/编号已用于其他内容/);
  await assert.rejects(f.controller.sendMessage({kind:'private',target:'101',text:'不得替换附件',requestId:request.requestId}),/编号已用于其他内容/);
  release();const completed=await pending;
  assert.equal(completed.id,duplicate.id);assert.equal(completed.status,'delivered');assert.equal(f.state.sends.length,1);
});

test('unknown attachment sends stay unconfirmed across repeat clicks and restart without exposing transport paths',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source());
  f.state.error=Error('native failure mentioning '+f.store.getWechatAttachment(selected.id).path);
  const request={kind:'group',target:'202',attachmentId:selected.id,requestId:requestId()};
  const first=await f.controller.sendAttachment(request);assert.equal(first.status,'unconfirmed');assert.match(first.error,/未自动重发/);assert.equal(first.error.includes(f.dataDir),false);
  assert.equal((await f.controller.sendAttachment(request)).id,first.id);assert.equal(f.state.sends.length,1);
  await f.reopen();
  assert.equal((await f.controller.sendAttachment(request)).id,first.id);assert.equal(f.state.sends.length,1);
  assert.equal((await f.controller.getState()).outbox[0].sha256,selected.sha256);
});

test('proven pre-submit attachment rejection persists and only an explicit new request can send after correction',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source());
  f.state.error=Object.assign(Error('native path must stay private: '+f.store.getWechatAttachment(selected.id).path),{code:'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT',attempted:false});
  const request={kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()};
  const first=await f.controller.sendAttachment(request);
  assert.equal(first.status,'rejected');assert.match(first.error,/已有草稿/);assert.match(first.error,/确认未发送/);assert.equal(first.error.includes(f.dataDir),false);
  assert.equal((await f.controller.sendAttachment(request)).id,first.id);assert.equal(f.state.sends.length,1);
  await f.reopen();f.state.error=null;
  const previous=await f.controller.sendAttachment(request);
  assert.equal(previous.id,first.id);assert.equal(previous.status,'rejected');assert.equal(f.state.sends.length,1);
  const delivered=await f.controller.sendAttachment({...request,requestId:requestId()});
  assert.equal(delivered.status,'delivered');assert.notEqual(delivered.id,first.id);assert.equal(f.state.sends.length,2);
  assert.equal(f.store.getWechatDelivery(first.id).status,'rejected');
});

test('unreadable input preflight displays the input warning instead of claiming a draft exists',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source());
  f.state.error=Object.assign(Error('synthetic unreadable input'),{code:'WECHAT_ATTACHMENT_UI_INPUT_UNREADABLE',attempted:false});
  const record=await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()});
  assert.equal(record.status,'rejected');assert.match(record.error,/无法核对聊天输入区/);assert.match(record.error,/确认未发送/);
  assert.equal(record.error.includes('已有草稿'),false);
});

test('attachment rejection requires a trusted explicit code and strict false attempt evidence',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source());
  for(const error of[
    Error('WECHAT_ATTACHMENT_UI_DRAFT_PRESENT'),
    Object.assign(Error('WECHAT_ATTACHMENT_UI_DRAFT_PRESENT'),{attempted:false}),
    Object.assign(Error('ordinary native failure'),{attempted:false}),
    Object.assign(Error('unknown transport rejection'),{code:'WECHAT_ATTACHMENT_UNKNOWN',attempted:false}),
    Object.assign(Error('missing attempt evidence'),{code:'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT'}),
    Object.assign(Error('submission already began'),{code:'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT',attempted:true}),
    Object.assign(Error('not a strict false'),{code:'WECHAT_ATTACHMENT_UI_DRAFT_PRESENT',attempted:0}),
    Object.assign(Error('interrupted while running'),{name:'AbortError',attempted:false}),
    ...['WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED','WECHAT_ATTACHMENT_UI_TIMEOUT','WECHAT_ATTACHMENT_UI_PROTOCOL_INVALID','WECHAT_ATTACHMENT_STATE_INVALID','WECHAT_ATTACHMENT_DELIVERY_CONFLICT'].map(code=>Object.assign(Error(code),{code,attempted:false}))
  ]){
    f.state.error=error;
    const record=await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()});
    assert.equal(record.status,'unconfirmed',error.message);assert.match(record.error,/送达状态不明/);
  }
  const sent=f.state.sends.length;await f.reopen();
  assert.equal((await f.controller.getState()).outbox.every(record=>record.status==='unconfirmed'),true);
  assert.equal(f.state.sends.length,sent);
});

test('snapshot tampering and path substitution are refused before creating an outbox or invoking transport',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source()),registered=f.store.getWechatAttachment(selected.id);
  fs.chmodSync(registered.path,0o600);fs.writeFileSync(registered.path,'tampered snapshot');
  await assert.rejects(f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()}),/快照缺失或已变化/);
  const other=await f.stage(f.source('路径替换.txt',Buffer.from('synthetic content'))),row=f.store.getWechatAttachment(other.id),directory=path.dirname(row.path);
  fs.renameSync(directory,directory+'-original');
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,row.name),'synthetic content');
  fs.symlinkSync(outside,directory,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.controller.sendAttachment({kind:'private',target:'101',attachmentId:other.id,requestId:requestId()}),/快照缺失或已变化/);
  assert.equal(f.state.sends.length,0);assert.equal((await f.controller.getState()).outbox.length,0);
});

test('outgoing snapshot storage rejects a junction leaving the product data root',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside');fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.dataDir,'wechat'));fs.symlinkSync(outside,path.join(f.dataDir,'wechat','outgoing'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.stage(f.source()),/产品数据范围/);
  assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(f.store.listWechatAttachments().length,0);
});

test('attachments respect the live account and allowlist and a manual send cancels pending automatic reply',async t=>{
  const f=await fixture(t,{auto:true}),selected=await f.stage(f.source());
  await assert.rejects(f.controller.sendAttachment({kind:'private',target:'999',attachmentId:selected.id,requestId:requestId()}),/没有授权/);
  f.emit();await until(()=>f.state.tasks.length===1);
  await f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()});
  await until(()=>f.state.cancels.includes(f.state.tasks[0]));
  assert.equal(f.state.textSends.length,0);assert.equal(f.state.sends.length,1);
  f.state.callbacks.onState({state:'ready',selfId:'888',accountVerified:true,readerConnected:true});
  await assert.rejects(f.controller.sendAttachment({kind:'private',target:'101',attachmentId:selected.id,requestId:requestId()}),/未发送/);
  assert.equal(f.state.sends.length,1);
});

test('recovery retains an interrupted media record as unconfirmed and never replays it',async t=>{
  const f=await fixture(t),selected=await f.stage(f.source()),row={id:'delivery_'+randomUUID(),accountId:'777',kind:'private',target:'101',text:'[文件]',
    dedupeKey:'synthetic-interrupted-media',deliveryId:'a'.repeat(64),mediaType:'file',attachmentId:selected.id,name:selected.name,size:selected.size,sha256:selected.sha256,mime:selected.mime,requestId:requestId(),createdAt:new Date().toISOString()};
  f.store.createWechatDelivery(row);await f.reopen();
  const record=f.store.getWechatDelivery(row.id);assert.equal(record.status,'unconfirmed');assert.equal(record.sha256,selected.sha256);assert.equal(record.mediaType,'file');assert.equal(f.state.sends.length,0);
});

test('root service uses a separate one-time WeChat picker grant and exposes only staged opaque metadata',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-attachment-root-service-')),filename=path.join(root,'合成说明.txt');fs.writeFileSync(filename,'synthetic root service attachment');
  const service=await createAssistantService({dataDir:path.join(root,'product'),runtime:{inspectRuntime:async()=>({available:false}),runTask:async()=>{throw Error('no model call permitted');}}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  service.grantAttachments([filename]);
  await assert.rejects(service.stageWechatAttachment({path:filename,mediaType:'file'}),/选择附件按钮/);
  service.grantWechatAttachments([filename]);const selected=await service.stageWechatAttachment({path:filename,mediaType:'file'});
  assert.match(selected.id,/^wxatt_[a-f0-9]{32}$/);assert.equal(Object.hasOwn(selected,'path'),false);
  await assert.rejects(service.stageWechatAttachment({path:filename,mediaType:'file'}),/选择附件按钮/);
  assert.equal((await service.getWechatState()).attachments[0].id,selected.id);
});
