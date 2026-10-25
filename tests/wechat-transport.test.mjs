import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWechatBridge } from '../packages/wechat-bridge/index.mjs';
import { readConversationSettings, updateConversationSettings } from '../packages/wechat-bridge/conversation-settings.mjs';
import { createWechatController } from '../apps/service/wechat.mjs';
import { createStore } from '../packages/storage/index.mjs';

const readerToken = 'reader-test-token-never-real', nativeToken = 'a'.repeat(64);
const until = async predicate => {
  const end = Date.now() + 3_000;
  while (!await predicate()) { if (Date.now() > end) throw Error('CONDITION_TIMEOUT'); await delay(10); }
};

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-wechat-'));
  const clients = new Set();
  const backend = { account: 'wxid_self_0001', own: 'wxid_self_0001', version: '4.1.10.27',
    hookAccount: null, sends: 0, rows: [], streams: 0, confirm: true, reject: false, ...options };
  const json = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
  };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const native = ['/WeChatAgent/health','/SendTextMsg','/GetSelfProfile','/SendStickerMsg','/SendImgMsg','/SendFileMsg'].includes(url.pathname);
    if (request.headers.authorization !== 'Bearer ' + (native ? nativeToken : readerToken)) return json(response, {}, 401);
    await backend.onRequest?.(url,request);
    if (url.pathname === '/api/v1/reader/status' && backend.holdStatus) {
      backend.statusPending = true; request.on('close', () => { backend.statusClosed = true; }); return;
    }
    if (url.pathname === '/api/v1/reader/status') return json(response, {
      backend: 'weflow-cli-nt', ownWxid: backend.own, accountDirectory: backend.account,
      productSubscriptionVersion: backend.subscriptionSupported ? 1 : undefined, selfEvents:backend.legacySelfEvents?undefined:'account-conversation-v1',
    });
    if(url.pathname==='/api/v1/product/subscription'&&backend.subscriptionSupported){
      if(request.method==='POST'){
        let body='';for await(const chunk of request)body+=chunk;
        const candidate=JSON.parse(body);backend.subscriptionPosts=(backend.subscriptionPosts??0)+1;
        if(backend.rejectSubscription)return json(response,{success:false},409);
        backend.subscription={version:1,subscriptionId:candidate.subscriptionId,accountDirectory:backend.account.toLowerCase(),ownWxid:backend.own,
          revision:(backend.subscription?.revision??0)+1,private:candidate.private,groups:candidate.groups,expiresAt:Date.now()/1000+90};
      }
      return json(response,backend.subscription??{version:1,subscriptionId:url.searchParams.get('subscriptionId'),accountDirectory:backend.account.toLowerCase(),ownWxid:backend.own,revision:0,private:[],groups:[],expiresAt:0});
    }
    if (url.pathname === '/WeChatAgent/health') return json(response, {
      integration: 'WeChatAgent-1', backend: 'wechat-hook', version: backend.version, startupState: 'ready',
      databaseAccounts: [backend.hookAccount ?? backend.account],
      nativeStickerSend: true,
      nativeImageSend:backend.mediaCapability===true,nativeFileSend:backend.mediaCapability===true,mediaProtocol:'xiaozhushou-native-media-v1',
    });
    if (url.pathname === '/GetSelfProfile' && backend.noNativeProfile) return json(response, {}, 404);
    if (url.pathname === '/GetSelfProfile') return json(response, {
      wxid: backend.profileWxid ?? backend.own, nickname: '实际微信昵称', alias: '测试微信号',
      phone: 'private-phone', email: 'private-email', area: 'private-area',
    });
    if (url.pathname === '/api/v1/contacts') return json(response, { contacts: backend.contacts ?? [
      { username: 'wxid_test_friend', displayName: '测试朋友', conversationId: 101 },
      { username: 'wxid_other_friend', displayName: '另一个朋友', conversationId: 102 },
      { username: 'test@chatroom', displayName: '测试群', conversationId: 202 },
      { username: backend.own, displayName: '本人', conversationId: 303 },
    ] });
    if (url.pathname === '/api/v1/sessions') return json(response, { sessions: backend.sessions ?? [
      { username: 'wxid_test_friend', displayName: '测试朋友', conversationId: 101 },
      { username: 'test@chatroom', displayName: '测试群', conversationId: 202 },
    ] });
    if (url.pathname === '/api/v1/messages') return json(response, { messages: backend.rows });
    if (url.pathname === '/api/v1/stickers') return json(response, { stickers: [{ id: 'd'.repeat(64), receivedAt: 100, description: '测试表情', tags: ['测试'] }] });
    if (url.pathname === '/api/v1/stickers/' + 'd'.repeat(64)) return json(response, { id: 'd'.repeat(64),
      conversationKey: url.searchParams.get('conversationKey'), fields: { md5: 'e'.repeat(32), len: 10 }, path: 'Z:/synthetic-only.gif' });
    if (url.pathname.startsWith('/api/v1/images/')) return json(response, backend.image ?? {});
    if (url.pathname === '/api/v1/push/messages') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': connected\n\n'); clients.add(response); backend.streams++;
      request.on('close', () => clients.delete(response)); return;
    }
    if (url.pathname === '/SendTextMsg') {
      assert.equal(request.headers['x-wechatagent-account'], backend.account.toLowerCase());
      let body = ''; for await (const chunk of request) body += chunk;
      const sent = JSON.parse(body); backend.sends++;
      if (backend.reject) return json(response, { ret: -1 });
      backend.rows.push({ localId: backend.sends, serverId: backend.confirm ? '9001' : '0',
        localType: 1, isSend: true, createTime: Math.floor(Date.now() / 1000), fullText: sent.msg });
      backend.afterSubmit?.();
      return json(response, { ret: 0 });
    }
    if(['/SendImgMsg','/SendFileMsg'].includes(url.pathname)){
      assert.equal(request.headers['x-wechatagent-account'],backend.account.toLowerCase());
      let body='';for await(const chunk of request)body+=chunk;
      const sent=JSON.parse(body);backend.mediaRequests??=[];backend.mediaRequests.push({route:url.pathname,body:sent});
      if(backend.mediaReject)return json(response,{ret:1,error:'IMAGE_INTEGRITY_FAILED',attempted:false},400);
      const bytes=fsSync.readFileSync(sent.path),md5=crypto.createHash('md5').update(bytes).digest('hex');
      const fileReceipt=backend.fileMd5InAppmsg?
        `<msg><appmsg><title>${sent.name}</title><type>6</type><appattach><totallen>${sent.size}</totallen></appattach><md5>${md5}</md5></appmsg></msg>`:
        `<msg><appmsg><title>${sent.name}</title><type>6</type><appattach><totallen>${sent.size}</totallen><filemd5>${md5}</filemd5></appattach></appmsg></msg>`;
      const image=url.pathname==='/SendImgMsg';backend.rows.push({localId:backend.mediaRequests.length+500,serverId:backend.confirm?'987654321987654321':'0',localType:image?3:25769803825,isSend:true,createTime:Math.floor(Date.now()/1000),
        fullText:image?`<msg><img md5="${md5}"/></msg>`:fileReceipt});
      return json(response,{ret:0,attempted:true,delivered:false,reused:false,deliveryId:sent.deliveryId});
    }
    if (url.pathname === '/SendStickerMsg') {
      assert.equal(request.headers['x-wechatagent-account'], backend.account.toLowerCase());
      let body = ''; for await (const chunk of request) body += chunk;
      const sent = JSON.parse(body); backend.sends++;
      backend.rows.push({ localId: backend.sends, serverId: backend.confirm ? '9001' : '0',
        localType: 47, isSend: true, createTime: Math.floor(Date.now() / 1000), stickerMd5: sent.sticker.md5 });
      backend.afterSubmit?.();
      return json(response, { ret: 0 });
    }
    json(response, {}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const messages = [], states = [], errors = [];
  const bridge = createWechatBridge({
    // A fresh HTTP client per request prevents global fetch pooling from
    // reusing a just-closed fixture when Windows recycles an ephemeral port.
    fetchImpl:(url,options={})=>new Promise((resolve,reject)=>{
      const request=http.request(url,{method:options.method??'GET',headers:options.headers,signal:options.signal,agent:false},response=>{
        resolve(new Response(Readable.toWeb(response),{status:response.statusCode,headers:response.headers}));
      });
      request.on('error',reject);request.end(options.body);
    }),
    onMessage: message => { if (backend.callbackFails) throw Error('SIMULATED_DATABASE_FAILURE'); messages.push(message);return backend.eventHandler?.(message); }, onState: state => {states.push(state);backend.stateHandler?.(state);}, onError: error => errors.push(error),
    reconnectDelayMs: 20, healthIntervalMs: options.healthIntervalMs??25, requestTimeoutMs: 300, receiptTimeoutMs: 80, pollMs: 10,
    ...(options.mediaNativeRunner?{mediaNativeRunner:options.mediaNativeRunner}:{}),
    ...(options.fileReader?{fileReader:options.fileReader}:{}),
  });
  const config = { dataDir: directory, readerBaseUrl: base, hookBaseUrl: base, readerToken, nativeToken,
    allowedPrivate: ['101'], allowedGroups: ['202'] };
  const emit = payload => { for (const client of clients) client.write('data: ' + JSON.stringify(payload) + '\n\n'); };
  const message = (extra = {}) => ({ event: 'message.new', type: 1, content: '你好，小助手', sessionId: 'wxid_test_friend',
    talkerId: 'wxid_test_friend', conversationId: 101, rawid: '7001', sourceName: '测试朋友', timestamp: 1_793_000_000, ...extra });
  t.after(async () => {
    await backend.cleanup?.();
    await bridge.stop(); for (const client of clients) client.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, config, backend, messages, states, errors, emit, message, clients, directory };
}

async function productFixture(t,options={}) {
  const f=await fixture(t,{healthIntervalMs:60000,...options});
  const source=path.join(f.directory,'legacy'),data=path.join(f.directory,'product');
  fsSync.mkdirSync(path.join(source,'config'),{recursive:true});fsSync.mkdirSync(path.join(source,'state','hook'),{recursive:true});
  fsSync.writeFileSync(path.join(source,'config','wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},hook:{baseUrl:f.config.hookBaseUrl,expectedVersion:'4.1.10.27'},wechat:{whitelist:{private:['101'],groups:['202']}}}));
  fsSync.writeFileSync(path.join(source,'state','wechat-io-config.json'),JSON.stringify({reader_base_url:f.config.readerBaseUrl,reader_token:readerToken}));
  fsSync.writeFileSync(path.join(source,'state','hook','native-token.txt'),nativeToken);
  const store=await createStore(path.join(data,'db')),secrets=new Map();
  const controller=createWechatController({store,dataDir:data,secretStore:{get:key=>secrets.get(key),set:(key,value)=>secrets.set(key,value),delete:key=>secrets.delete(key)},
    bridgeFactory:callbacks=>{f.backend.eventHandler=callbacks.onMessage;f.backend.stateHandler=callbacks.onState;return f.bridge;},
    createTask:async()=>{const id='task_'+crypto.randomUUID();store.createTask({id,title:'synthetic',prompt:'synthetic',kind:'agent',status:'succeeded',createdAt:new Date().toISOString(),workspace:path.join(data,'tasks',id),attachments:[]});return store.getTask(id);},
    getTask:id=>({task:store.getTask(id)}),readTaskReply:async()=> '完整的自动回复',cancelTask:async()=>{},autoOptions:{pollMs:5},
  });
  f.backend.cleanup=async()=>{await controller.close();store.close();};
  await controller.importConnection(source);await controller.saveSettings({autoReply:true});await controller.connect();
  await until(()=>f.bridge.getStatus().state==='ready');await delay(30);
  return {...f,controller,store};
}

test('actual reader producer and poll policies retain self events and apply account scoped product grants', () => {
  const script=fileURLToPath(new URL('./reader_regression.py',import.meta.url));
  const result=execFileSync(process.env.XZS_TEST_PYTHON??'python',[script],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});
  assert.equal(result,'');
});

test('real producer self event traverses SSE and cancels automatic sending at every awaited pre-submit barrier', async t => {
  const payload=JSON.parse(execFileSync(process.env.XZS_TEST_PYTHON??'python',[fileURLToPath(new URL('./reader_regression.py',import.meta.url)),'--payload'],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}}));
  const barriers=[['/api/v1/reader/status',1],['/WeChatAgent/health',1],['/api/v1/sessions',1],['/api/v1/messages',1],
    ['/api/v1/reader/status',2],['/WeChatAgent/health',2],['/api/v1/sessions',2],['/api/v1/reader/status',3],['/WeChatAgent/health',3]];
  for(const [route,nth] of barriers)await t.test(route+' #'+nth,async child=>{
    const f=await productFixture(child);let release,count=0,held=false;
    const gate=new Promise(resolve=>{release=resolve;});
    f.backend.onRequest=async url=>{if(url.pathname===route&&++count===nth){held=true;await gate;}};
    try{
      f.emit(f.message({timestamp:Math.floor(Date.now()/1000)}));
      await until(()=>held);
      f.emit({...payload,timestamp:Math.floor(Date.now()/1000)});
      await until(()=>f.messages.some(message=>message.outgoing));
    }finally{release();}
    await until(()=>f.controller.getState().then(state=>state.autoReply.active===0));
    const result=await f.controller.getState();
    assert.equal(f.backend.sends,0,'human takeover before native submission must submit zero times');
    assert.equal(result.outbox.length,1);assert.equal(result.outbox[0].status,'rejected');
  });
});

test('human takeover after submission retains the one attempted delivery without retrying', async t => {
  const f=await productFixture(t);f.backend.confirm=false;
  f.backend.afterSubmit=()=>f.emit(f.message({isSend:true,accountWxid:f.backend.own,talkerId:f.backend.own,rawid:'90029',timestamp:Math.floor(Date.now()/1000),content:'本人接管'}));
  f.emit(f.message({timestamp:Math.floor(Date.now()/1000)}));
  await until(()=>f.backend.sends===1);
  await until(()=>f.controller.getState().then(state=>state.autoReply.active===0));
  const outbox=(await f.controller.getState()).outbox;
  assert.equal(outbox[0].status,'unconfirmed');assert.equal(f.backend.sends,1);
});

test('a reader without verified native takeover production pauses automatic replies visibly',async t=>{
  const f=await productFixture(t,{legacySelfEvents:true});f.emit(f.message({timestamp:Math.floor(Date.now()/1000)}));await delay(40);
  const result=await f.controller.getState();
  assert.equal(result.connection.selfEventsVerified,false);assert.equal(result.autoReply.state,'paused');
  assert.match(result.autoReply.detail,/人工接管事件，自动回复已暂停/);assert.equal(result.autoReply.active,0);assert.equal(f.backend.sends,0);
});

test('pre-submit text busy is rejected, only a new explicit request submits after the active operation',async t=>{
  const f=await productFixture(t);let release,held=false;
  const activeId='request_'+crypto.randomUUID(),busyId='request_'+crypto.randomUUID(),retryId='request_'+crypto.randomUUID();
  const gate=new Promise(resolve=>{release=resolve;});
  f.backend.onRequest=async url=>{if(url.pathname==='/api/v1/messages'&&!held){held=true;await gate;}};
  const active=f.controller.sendMessage({kind:'private',target:'101',text:'合成在途文字',requestId:activeId});
  let rejected;
  try{
    await until(()=>held);
    rejected=await f.controller.sendMessage({kind:'private',target:'101',text:'主人明确重试文字',requestId:busyId});
    assert.equal(rejected.status,'rejected');assert.match(rejected.error,/确认未发送/);assert.equal(f.backend.sends,0);
  }finally{release();}
  assert.equal((await active).status,'delivered');
  assert.equal((await f.controller.sendMessage({kind:'private',target:'101',text:'主人明确重试文字',requestId:busyId})).id,rejected.id);
  assert.equal(f.backend.sends,1);
  const retry=await f.controller.sendMessage({kind:'private',target:'101',text:'主人明确重试文字',requestId:retryId});
  assert.equal(retry.status,'delivered');assert.equal(f.backend.sends,2);
  assert.notEqual(retry.id,rejected.id);
});

test('non-success native bodies remain uncertain and the same delivery never resubmits',async t=>{
  const f=await fixture(t,{reject:true,healthIntervalMs:60000});await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
  const send={kind:'private',target:'101',text:'合成正文',deliveryId:'c'.repeat(64)};
  await assert.rejects(f.bridge.sendText(send),{code:'NATIVE_SEND_REJECTED',attempted:true});
  await assert.rejects(f.bridge.sendText(send),{code:'TEXT_DELIVERY_UNCONFIRMED',attempted:true});
  assert.equal(f.backend.sends,1);
});

test('text and sticker receipts reject account swaps before, during and after receipt matching', async t => {
  for(const media of ['text','sticker'])for(const phase of ['accepted','query','match'])await t.test(media+':'+phase,async child=>{
    const f=await fixture(child,{healthIntervalMs:60000});await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
    let queries=0,statusReads=0;
    const swap=()=>{f.backend.account='wxid_changed_0001';f.backend.own='wxid_changed_0001';};
    if(phase==='accepted')f.backend.afterSubmit=swap;
    f.backend.onRequest=url=>{
      if(url.pathname==='/api/v1/messages'&&++queries===2&&phase==='query')swap();
      if(f.backend.sends&&url.pathname==='/api/v1/reader/status'&&++statusReads===5&&phase==='match')swap();
    };
    const send={kind:'private',target:'101',deliveryId:'f'.repeat(64),text:'合成回执正文',id:'d'.repeat(64)};
    await assert.rejects(media==='text'?f.bridge.sendText(send):f.bridge.sendSticker(send));
    assert.equal(f.backend.sends,1);
    const ledger=path.join(f.directory,'state','text-deliveries');
    if(fsSync.existsSync(ledger))for(const file of fsSync.readdirSync(ledger))assert.notEqual(JSON.parse(fsSync.readFileSync(path.join(ledger,file))).state,'confirmed');
    if(media==='sticker')assert.equal(JSON.parse(fsSync.readFileSync(path.join(f.directory,'state','sticker-delivery-pending.json'))).attempts.length,1);
    await assert.rejects(media==='text'?f.bridge.sendText(send):f.bridge.sendSticker(send));assert.equal(f.backend.sends,1);
  });
});

test('multiple matching text or sticker rows never confirm a single submission',async t=>{
  for(const media of ['text','sticker'])await t.test(media,async child=>{
    const f=await fixture(child,{healthIntervalMs:60000});await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
    f.backend.afterSubmit=()=>f.backend.rows.push({...f.backend.rows[0],localId:2,serverId:'9002'});
    const send={kind:'private',target:'101',deliveryId:'f'.repeat(64),text:'合成相同正文',id:'d'.repeat(64)};
    await assert.rejects(media==='text'?f.bridge.sendText(send):f.bridge.sendSticker(send));assert.equal(f.backend.sends,1);
  });
});

test('attachment UI refuses identical private/group titles and aliases before runner invocation',async t=>{
  for(const mode of ['title','alias','spaced-title','spaced-alias'])await t.test(mode,async child=>{
    const alias=mode.includes('alias'),otherName=mode.startsWith('spaced-')?'sa me':'same';
    let runnerCalls=0;
    const f=await fixture(child,{healthIntervalMs:60000,mediaNativeRunner:async()=>{runnerCalls++;throw Error('must not run');}});
    f.backend.contacts=[{username:'wxid_test_friend',displayName:'same',conversationId:101},
      {username:'test@chatroom',displayName:alias?'different':otherName,aliases:alias?[otherName]:[],conversationId:202}];
    f.backend.sessions=[{username:'wxid_test_friend',displayName:'same',conversationId:101},{username:'test@chatroom',displayName:alias?'different':otherName,conversationId:202}];
    const filename=path.join(f.directory,'synthetic.txt'),bytes=Buffer.from('attachment');fsSync.writeFileSync(filename,bytes);
    await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
    await assert.rejects(f.bridge.sendAttachment({kind:'private',target:'101',path:filename,name:'synthetic.txt',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mime:'text/plain',mediaType:'file',deliveryId:'b'.repeat(64)}),{code:'WECHAT_ATTACHMENT_TARGET_AMBIGUOUS',attempted:false});
    assert.equal(runnerCalls,0);
  });
});

test('default bridge submits image and file through authenticated Hook and confirms exact DB receipts',async t=>{
  const f=await fixture(t,{healthIntervalMs:60000,mediaCapability:true,fileMd5InAppmsg:true});await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
  for(const [i,mediaType] of ['image','file'].entries()){
    const name=mediaType==='image'?'合成图片.png':'合成文件.txt',filename=path.join(f.directory,name),bytes=Buffer.from('synthetic-'+mediaType);fsSync.writeFileSync(filename,bytes);
    const input={kind:'private',target:'101',path:filename,name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mime:mediaType==='image'?'image/png':'text/plain',mediaType,deliveryId:String(i+1).repeat(64)};
    const delivered=await f.bridge.sendAttachment(input);assert.equal(delivered.receipt,'wechat-server-id');assert.equal(delivered.message_id,'987654321987654321');
    assert.equal(f.backend.mediaRequests[i].route,mediaType==='image'?'/SendImgMsg':'/SendFileMsg');assert.equal(f.backend.mediaRequests[i].body.wxidorgid,'wxid_test_friend');
    await f.bridge.sendAttachment(input);assert.equal(f.backend.mediaRequests.length,i+1,'same delivery must never submit twice');
  }
});

test('file cards and history retain bound references, verify returned bytes and reject wrong media identities',async t=>{
  const bytes=Buffer.from('synthetic-document'),reads=[];let bad=false;
  const f=await fixture(t,{healthIntervalMs:60000,fileReader:async input=>{reads.push(input);return{ok:true,id:bad?'0'.repeat(64):input.id,name:input.name,size:bytes.length,b64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};}});
  await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
  f.emit(f.message({rawid:'f'.repeat(64),type:49,content:'[文件] 合成.docx',card:{apptype:6,title:'合成.docx',label:'文件',url:''}}));
  await until(()=>f.messages.length===1);const file=f.messages[0].files[0];assert.equal(file.name,'合成.docx');
  const result=await f.bridge.resolveFile({kind:'private',target:'101',file});assert.equal(result.b64,bytes.toString('base64'));assert.equal(reads[0].talker,'wxid_test_friend');
  bad=true;await assert.rejects(f.bridge.resolveFile({kind:'private',target:'101',file}),{code:'FILE_INTEGRITY_FAILED'});
  f.backend.rows=[{localId:42,serverId:'9001',localType:25769803825,createTime:1793000000,isSend:0,senderUsername:'wxid_test_friend',fullText:`<msg><appmsg><type>6</type><title>合成.docx</title><appattach><totallen>${bytes.length}</totallen></appattach></appmsg></msg>`,parsedContent:'[文件]'}];
  const history=await f.bridge.getHistory({kind:'private',target:'101'});assert.equal(history.messages[0].files.length,1);assert.equal(history.messages[0].message_type,'file');
  assert.equal(history.messages[0].files[0].size,bytes.length);
  f.backend.rows[0].localType=1;
  assert.equal((await f.bridge.getHistory({kind:'private',target:'101'})).messages[0].files.length,0,'XML pasted as text is not a file attachment');
});

test('native capability failure and explicit pre-submit rejection never fall back to desktop sending',async t=>{
  for(const mode of ['unsupported','rejected','unconfirmed'])await t.test(mode,async child=>{
    const f=await fixture(child,{healthIntervalMs:60000,mediaCapability:mode!=='unsupported',mediaReject:mode==='rejected',confirm:mode!=='unconfirmed'});await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
    const filename=path.join(f.directory,'synthetic.txt'),bytes=Buffer.from('synthetic');fsSync.writeFileSync(filename,bytes);
    const input={kind:'private',target:'101',path:filename,name:'synthetic.txt',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mime:'text/plain',mediaType:'file',deliveryId:'b'.repeat(64)};
    await assert.rejects(f.bridge.sendAttachment(input),{code:mode==='unsupported'?'WECHAT_ATTACHMENT_HOOK_UNAVAILABLE':mode==='rejected'?'WECHAT_ATTACHMENT_HOOK_REJECTED':'WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED',attempted:mode==='unconfirmed'});
    assert.equal(f.backend.mediaRequests?.length??0,mode==='unsupported'?0:1);
  });
});

test('reader configuration reports applied version and exact lists or explicit pending on old/failed/unknown reader',async t=>{
  for(const mode of ['applied','unsupported','rejected','unknown-version'])await t.test(mode,async child=>{
    const f=await fixture(child,{healthIntervalMs:60000,subscriptionSupported:mode!=='unsupported',rejectSubscription:mode==='rejected'});
    if(mode==='unknown-version')f.backend.subscription={version:2};
    await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
    const status=f.bridge.getStatus().readerConfiguration;
    assert.equal(status.state,mode==='applied'?'applied':'pending');
    if(mode==='applied'){
      assert.equal(status.version,1);assert(status.revision>0);assert.match(status.digest,/^[a-f0-9]{64}$/);
      assert.deepEqual(f.backend.subscription.private,f.config.allowedPrivate);assert.deepEqual(f.backend.subscription.groups,f.config.allowedGroups);
      await f.bridge.stop();assert.deepEqual(f.backend.subscription.private,[]);assert.deepEqual(f.backend.subscription.groups,[]);
    }else assert.match(status.detail,/名单待配置，新增会话尚未接收/);
    if(mode==='unknown-version')assert.equal(f.backend.subscriptionPosts??0,0,'unknown schema must never be overwritten');
  });
});

test('WeChat bridge normalizes allowlisted SSE messages and deduplicates reconnections', async t => {
  const f = await fixture(t);
  const started = await f.bridge.start(f.config);
  assert.equal(started.accountVerified, true);
  await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); f.emit(f.message());
  f.emit(f.message({ conversationId: 999, rawid: '7002' }));
  f.emit(f.message({ isSend: true, rawid: '7003' }));
  f.emit(f.message({ sessionId: 'test@chatroom', talkerId: 'wxid_group_friend', conversationId: 202, groupName: '测试群', rawid: '7004' }));
  await until(() => f.messages.length === 2);
  assert.deepEqual(Object.keys(f.messages[0]).sort(), ['conversation_id', 'conversation_name', 'kind', 'message_id', 'segments', 'self_id', 'sender_id', 'sender_name', 'text', 'time']);
  assert.deepEqual(f.messages[0].segments, [{type:'text',data:{text:'你好，小助手'}}]);
  assert.equal(f.messages[0].conversation_id, '101');
  assert.equal(f.messages[0].text, '你好，小助手');
  assert.equal(f.messages[0].conversation_name, '测试朋友');
  assert.equal(f.messages[1].kind, 'group');
  assert.equal(f.messages[1].conversation_name, '测试群');
  assert.equal(JSON.stringify(f.messages).includes('wxid_'), false);
  for (const client of f.clients) client.end();
  await until(() => f.backend.streams >= 2 && f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); await delay(40);
  assert.equal(f.messages.length, 2);
  assert(f.states.some(s => s.state === 'error' && !s.readerConnected));
});

test('WeChat retains trusted group wake metadata and distinguishes verified human self-sends', async t => {
  const f=await fixture(t);await f.bridge.start(f.config);await until(()=>f.bridge.getStatus().state==='ready');
  const group={sessionId:'test@chatroom',talkerId:'wxid_group_friend',conversationId:202,groupName:'测试群'};
  f.emit(f.message({...group,rawid:'7101',content:'@小助手\u2005请接着聊'}));
  f.emit(f.message({...group,rawid:'7102',type:49,content:'引用回复',quoteReply:{version:1,reply:'继续',reference:{senderId:'wxid_self_0001',senderName:'本人',conversationId:'test@chatroom',messageId:'9001',time:'',kind:'1',text:'之前的答复'}}}));
  f.emit(f.message({rawid:'7103',talkerId:'wxid_self_0001',accountWxid:'wxid_self_0001',isSend:true}));
  f.emit(f.message({rawid:'7104',talkerId:'wxid_imposter',isSend:true}));
  f.emit(f.message({rawid:'7105',talkerId:'wxid_self_0001',isSend:true,conversationId:999}));
  await until(()=>f.messages.length===3);
  assert(f.messages[0].segments.some(item=>item.type==='at'&&item.data.qq===f.messages[0].self_id));
  assert.equal(f.messages[1].quoteReply.reference.senderRelation,'self');
  assert.equal(f.messages[1].quoteReply.reply,'继续');
  assert.equal(f.messages[2].outgoing,true);assert.equal(f.messages[2].sender_id,f.messages[2].self_id);
  assert.equal(f.messages[2].text,'你好，小助手','retain bounded text to distinguish our automatic echo from a human reply');
  await delay(40);assert.equal(f.messages.length,3);
});

test('WeChat sends require server receipts and a delivery ID is not resubmitted', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const send = { kind: 'private', target: '101', text: '离线替身测试', deliveryId: 'b'.repeat(64) };
  const result = await f.bridge.sendText(send);
  assert.equal(result.delivered, 'database-confirmed');
  assert.equal(result.receipt, 'wechat-server-id');
  assert.equal(f.backend.sends, 1);
  assert.equal((await f.bridge.sendText(send)).reused, true);
  assert.equal(f.backend.sends, 1);
  const entries = await fs.readdir(path.join(f.directory, 'state', 'text-deliveries'));
  const saved = await fs.readFile(path.join(f.directory, 'state', 'text-deliveries', entries[0]), 'utf8');
  assert.equal(saved.includes(readerToken), false); assert.equal(saved.includes(nativeToken), false);
});

test('WeChat accepted but unconfirmed deliveries are never automatically resubmitted', async t => {
  const f = await fixture(t, { confirm: false });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const send = { kind: 'private', target: '101', text: '尚无服务器回执', deliveryId: 'c'.repeat(64) };
  await assert.rejects(f.bridge.sendText(send), { code: 'TEXT_DELIVERY_UNCONFIRMED', attempted: true });
  await assert.rejects(f.bridge.sendText(send), { code: 'TEXT_DELIVERY_UNCONFIRMED', attempted: true });
  assert.equal(f.backend.sends, 1);
});

test('WeChat attachment contention proves it was not attempted before the active send finishes', async t => {
  const f = await fixture(t, { confirm: false });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const active = assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '合成的在途文字', deliveryId: '7'.repeat(64) }), { code: 'TEXT_DELIVERY_UNCONFIRMED', attempted: true });
  await assert.rejects(f.bridge.sendAttachment({ kind: 'private', target: '101' }), { code: 'SENDER_BUSY', attempted: false });
  await active;
  assert.equal(f.backend.sends, 1, 'the rejected attachment cannot submit anything');
});

test('WeChat stop cancels streams and prevents subsequent receive or send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  await f.bridge.stop();
  assert.equal(f.bridge.getStatus().state, 'offline');
  f.emit(f.message()); await delay(30); assert.equal(f.messages.length, 0);
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'd'.repeat(64) }), { code: 'WECHAT_NOT_READY' });
});

test('WeChat account change latches a blocked state and cannot receive or send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.backend.account = 'wxid_another_0002'; f.backend.own = 'wxid_another_0002';
  await until(() => f.bridge.getStatus().detail === 'WECHAT_ACCOUNT_CHANGED');
  f.emit(f.message()); await delay(60); assert.equal(f.messages.length, 0);
  assert.equal(f.bridge.getStatus().accountVerified, false);
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'e'.repeat(64) }), { code: 'WECHAT_ACCOUNT_CHANGED' });
  assert.equal(f.backend.sends, 0);
  assert.equal(JSON.stringify(f.errors).includes('wxid_'), false);
});

test('WeChat rechecks matching account before every send', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.backend.hookAccount = 'wxid_wrong_database';
  await assert.rejects(f.bridge.sendText({ kind: 'private', target: '101', text: '禁止发送', deliveryId: 'f'.repeat(64) }), { code: 'HOOK_ACCOUNT_MISMATCH' });
  assert.equal(f.backend.sends, 0);
});

test('WeChat rejects unreviewed versions, remote endpoints and wrong credentials', async t => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.start({ ...f.config, readerBaseUrl: 'https://example.com' }), { code: 'WECHAT_LOOPBACK_REQUIRED' });
  await assert.rejects(f.bridge.start({ ...f.config, hookBaseUrl: 'http://127.0.0.1:30001/redirect' }), { code: 'WECHAT_LOOPBACK_REQUIRED' });
  await assert.rejects(f.bridge.start({ ...f.config, allowedPrivate: ['wxid_raw'] }), { code: 'WECHAT_ALLOWLIST_INVALID' });
  f.backend.version = '4.1.99.0';
  await assert.rejects(f.bridge.start(f.config), { code: 'HOOK_VERSION_MISMATCH' });
  assert.equal(f.bridge.getStatus().accountVerified, false);
  f.backend.version = '4.1.10.27';
  await assert.rejects(f.bridge.start({ ...f.config, readerToken: 'wrong-but-long-enough-token' }), { code: 'API_HTTP_401' });
});

test('WeChat oversized SSE events are bounded and are not delivered', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  for (const client of f.clients) client.write('data: ' + 'x'.repeat(260_000));
  await until(() => f.errors.some(error => error.code === 'READER_EVENT_TOO_LARGE'));
  assert.equal(f.messages.length, 0);
});

test('WeChat stop cancels pending startup health and never connects afterwards', async t => {
  const f = await fixture(t, { holdStatus: true });
  const starting = f.bridge.start(f.config);
  const rejected = assert.rejects(starting, { code: 'WECHAT_START_CANCELLED' });
  await until(() => f.backend.statusPending);
  await f.bridge.stop(); await rejected;
  await until(() => f.backend.statusClosed);
  await delay(80);
  assert.equal(f.bridge.getStatus().state, 'offline');
  assert.equal(f.backend.streams, 0);
  assert.equal(f.states.some(state => state.state === 'ready'), false);
});

test('WeChat failed persistence visibly stops receiving without permanently deduplicating the message', async t => {
  const f = await fixture(t, { callbackFails: true });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message());
  await until(() => f.bridge.getStatus().detail === 'WECHAT_MESSAGE_HANDLER_FAILED');
  const count = f.backend.streams;
  await delay(80);
  assert.equal(f.backend.streams, count);
  assert.equal(f.bridge.getStatus().readerConnected, false);
  assert.equal(f.messages.length, 0);
  f.backend.callbackFails = false;
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message()); await until(() => f.messages.length === 1);
});

test('WeChat exposes verified actual account identity and safe named directory metadata', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const profile = await f.bridge.getProfile();
  assert.equal(profile.name, '实际微信昵称'); assert.equal(profile.wxid, f.backend.own);
  assert.deepEqual(Object.keys(profile).sort(), ['alias', 'id', 'name', 'source', 'wxid']);
  assert.equal(f.bridge.getStatus().account.name, '实际微信昵称');
  const friends = await f.bridge.getDirectory({ kind: 'private' });
  assert.deepEqual(friends.contacts.map(item => [item.id, item.name, item.allowed]), [['101', '测试朋友', true], ['102', '另一个朋友', false]]);
  assert.equal(JSON.stringify(friends).includes('wxid_'), false);
  const groups = await f.bridge.getDirectory({ kind: 'group' });
  assert.equal(groups.contacts[0].name, '测试群');
  f.backend.contacts = [
    { username: 'one@chatroom', displayName: '重名一', conversationId: 202 },
    { username: 'two@chatroom', displayName: '重名二', conversationId: 202 },
  ];
  assert((await f.bridge.getDirectory({ kind: 'group' })).contacts.every(item => item.ambiguous));
  await assert.rejects(f.bridge.getDirectory({ kind: 'group', limit: 1000 }), { code: 'WECHAT_DIRECTORY_ARGUMENT_INVALID' });
});

test('WeChat native profile cannot identify a different account from the verified reader', async t => {
  const f = await fixture(t, { profileWxid: 'wxid_another_account' });
  await assert.rejects(f.bridge.start(f.config), { code: 'WECHAT_PROFILE_ACCOUNT_MISMATCH' });
  assert.equal(f.bridge.getStatus().accountVerified, false);
  assert.equal(f.backend.streams, 0);
});

test('WeChat native-hook without GetSelfProfile falls back to the exact verified self contact', async t => {
  const f = await fixture(t, { noNativeProfile: true });
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const profile = await f.bridge.getProfile();
  assert.equal(profile.name, '本人'); assert.equal(profile.source, 'reader-contact');
  assert.equal(profile.wxid, f.backend.own);
  f.backend.contacts = [{ username: 'wxid_not_self', displayName: '不能冒充本人' }];
  await assert.rejects(f.bridge.getProfile(), { code: 'WECHAT_PROFILE_UNAVAILABLE' });
});

test('WeChat receives the original reader SHA256 rawid and retains normalized media references', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  f.emit(f.message({ rawid: 'b'.repeat(64) }));
  f.emit(f.message({ rawid: 'c'.repeat(64), type: 3, content: '[图片]', image: { id: 'a'.repeat(64) } }));
  await until(() => f.messages.length === 2);
  assert.equal(f.messages[0].message_id, 'b'.repeat(64));
  assert.deepEqual(f.messages[1].images, [{ id: 'a'.repeat(64) }]);
});

test('WeChat sessions and latest history reuse native mappings and enforce the current allowlist', async t => {
  const f = await fixture(t);
  f.backend.rows = [
    { localId: 3, serverId: '10003', localType: 1, createTime: 103, isSend: 1, fullText: '最新发送', senderDisplay: '本人' },
    { localId: 2, serverId: '10002', localType: 1, createTime: 102, isSend: 0, senderUsername: 'wxid_test_friend', senderDisplay: '测试朋友', fullText: '中间消息' },
    { localId: 1, serverId: '10001', localType: 49, createTime: 101, isSend: 0, senderUsername: 'wxid_test_friend', parsedContent: '[文件]', fullText: '<private-xml/>' },
  ];
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  assert.deepEqual((await f.bridge.getSessions()).sessions.map(item => [item.id, item.name]), [['101', '测试朋友'], ['202', '测试群']]);
  const history = await f.bridge.getHistory({ kind: 'private', target: '101', limit: 2 });
  assert.equal(history.pagination, 'latest-only'); assert.equal(history.name, '测试朋友');
  assert.deepEqual(history.messages.map(item => item.text), ['中间消息', '最新发送']);
  assert.equal(history.messages[1].outgoing, true);
  assert.equal(JSON.stringify(history).includes('wxid_'), false);
  await assert.rejects(f.bridge.getHistory({ kind: 'private', target: '999' }), { code: 'CONVERSATION_NOT_ALLOWED' });
  await assert.rejects(f.bridge.getHistory({ kind: 'private', target: '101', limit: 101 }), { code: 'WECHAT_HISTORY_ARGUMENT_INVALID' });
});

test('WeChat image previews require matching conversation binding and verified content digest', async t => {
  const f = await fixture(t), imageId = 'a'.repeat(64), bytes = Buffer.from('synthetic-image-data');
  f.backend.image = { imageId, conversationKey: 'wechat:private:101', mime: 'image/png', b64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  assert.equal((await f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId })).bytes, bytes.length);
  f.backend.image.conversationKey = 'wechat:group:202';
  await assert.rejects(f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId }), { code: 'IMAGE_CONVERSATION_MISMATCH' });
  f.backend.image.conversationKey = 'wechat:private:101'; f.backend.image.sha256 = '0'.repeat(64);
  await assert.rejects(f.bridge.resolveImage({ kind: 'private', target: '101', id: imageId }), { code: 'IMAGE_INTEGRITY_FAILED' });
});

test('WeChat sticker listing and sending retain the existing native server receipt and replay rules', async t => {
  const f = await fixture(t);
  await f.bridge.start(f.config); await until(() => f.bridge.getStatus().state === 'ready');
  const choices = await f.bridge.getStickers({ kind: 'private', target: '101', query: '测试' });
  assert.equal(choices.enabled, true); assert.equal(choices.stickers[0].description, '测试表情');
  const send = { kind: 'private', target: '101', id: 'd'.repeat(64), deliveryId: 'e'.repeat(64) };
  const result = await f.bridge.sendSticker(send);
  assert.equal(result.receipt, 'wechat-server-id'); assert.equal(result.media_type, 'wechat-sticker');
  assert.equal((await f.bridge.sendSticker(send)).reused, true);
  assert.equal(f.backend.sends, 1);
});

test('WeChat conversation settings directly reuse original console schema and retain other chats', () => {
  const config = { persona: { default: '默认', chats: { 'wechat:group:202': '旧人格' } },
    wechat: { whitelist: { private: ['101'], groups: ['202'] }, stickers: { enabled: true },
      dshAccess: { chats: { 'wechat:group:202': { skills: ['旧技能'], tools: [] } } } } };
  const before = JSON.stringify(config);
  const settings = { persona: '新人格', mode: 'mention', stickers: false, search: true, proactive: false, context: 16000 };
  const access = { skills: ['已授权技能'], tools: ['read_document'] };
  const next = updateConversationSettings(config, { kind: 'group', target: '202', settings, access });
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(readConversationSettings(next, { kind: 'group', target: '202' }), { key: 'wechat:group:202', settings, access });
  assert.equal(next.wechat.whitelist.private[0], '101');
  assert.throws(() => updateConversationSettings(config, { kind: 'private', target: '999', settings, access }), { code: 'CONVERSATION_NOT_ALLOWED' });
  assert.throws(() => updateConversationSettings(config, { kind: 'private', target: '101', settings, access }), /群聊回复方式/);
});
