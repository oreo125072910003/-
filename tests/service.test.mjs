import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../packages/storage/index.mjs';
import { createAssistantService } from '../apps/service/index.mjs';

function temporary(){return fs.mkdtempSync(path.join(os.tmpdir(),'assistant-service-test-'));}
function cleanup(directory){if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('assistant-service-test-'))throw Error('Unexpected test cleanup path');fs.rmSync(directory,{recursive:true,force:true});}
const fakeRuntime={inspectRuntime:async()=>({available:true,version:'test',command:'test-runtime',detail:'模拟执行器',capabilities:{}}),runTask:async()=>({ok:true,finalText:'这是根据实际输入返回的测试答复。',sessionId:'test-session'})};
function vault(){const values=new Map();return{get:async k=>values.get(k),set:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k)};}
async function waitTask(service,id,statuses=['succeeded','failed','waiting_dependency','cancelled']){const deadline=Date.now()+5000;for(;;){const detail=service.getTask(id);if(statuses.includes(detail.task.status))return detail;if(Date.now()>deadline)throw Error('test task timeout');await new Promise(r=>setTimeout(r,10));}}
async function setup(t,options={}){const dataDir=temporary();const service=await createAssistantService({dataDir,runtime:fakeRuntime,secretStore:vault(),...options});t.after(async()=>{await service.close();cleanup(dataDir);});return{service,dataDir};}

test('SQLite persists tasks and marks interrupted work after restart',async t=>{
  const directory=temporary();t.after(()=>cleanup(directory));let store=await createStore(directory);const id='task_'+randomUUID();
  store.createTask({id,title:'持久任务',prompt:'工作',kind:'agent',status:'queued',createdAt:new Date().toISOString(),workspace:directory,attachments:[]});
  store.updateTask(id,{status:'running'});store.addEvent(id,'status','已经开始');store.close();
  store=await createStore(directory);assert.equal(store.getTask(id).status,'running');assert.equal(store.recover(),1);
  assert.equal(store.getTask(id).status,'interrupted');assert.equal(store.getEvents(id).length,2);store.close();
  assert.equal(fs.readFileSync(path.join(directory,'assistant.sqlite')).subarray(0,15).toString(),'SQLite format 3');
});

test('storage rejects orphan events and remains usable after rollback',async t=>{
  const directory=temporary();const store=await createStore(directory);t.after(()=>{store.close();cleanup(directory);});
  assert.throws(()=>store.addEvent('task_missing','test','orphan'),/FOREIGN KEY/);
  store.saveSettings({assistantName:'她'});assert.equal(store.getSettings().assistantName,'她');
});

test('second writer is refused and a closed store can be reopened',async t=>{
  const directory=temporary();t.after(()=>cleanup(directory));const first=await createStore(directory);
  first.saveSettings({assistantName:'仍然保留'});
  await assert.rejects(createStore(directory),/另一个小助手实例/);
  first.close();const reopened=await createStore(directory);assert.equal(reopened.getSettings().assistantName,'仍然保留');reopened.close();
});

test('organize imports selected files without altering originals and verifies artifacts',async t=>{
  const{service,dataDir}=await setup(t);const source=path.join(dataDir,'输入.txt');fs.writeFileSync(source,'数量 3\n价格待核对\n');
  await assert.rejects(service.createTask({prompt:'整理资料',kind:'organize',attachmentPaths:[source]}),/添加资料按钮/);
  service.grantAttachments([source]);const task=await service.createTask({prompt:'整理资料',kind:'organize',attachmentPaths:[source]});
  const detail=await waitTask(service,task.id);assert.equal(detail.task.status,'succeeded');assert.equal(detail.artifacts.length,2);
  assert.equal(fs.readFileSync(source,'utf8'),'数量 3\n价格待核对\n');
  const artifact=detail.artifacts[0];const filename=service.resolveArtifact(artifact.id);assert.match(fs.readFileSync(filename,'utf8'),/数量 3/);
  fs.appendFileSync(filename,'\n外部修改');assert.throws(()=>service.resolveArtifact(artifact.id),/外部修改/);
});

test('missing account waits without running model',async t=>{
  let invoked=false;const runtime={...fakeRuntime,runTask:async()=>{invoked=true;throw Error('should not run');}};
  const{service}=await setup(t,{runtime});const task=await service.createTask({prompt:'你好',kind:'agent'});
  const detail=await waitTask(service,task.id);assert.equal(detail.task.status,'waiting_dependency');assert.equal(invoked,false);
});

test('AI answer creates real artifact and never stores API key in SQLite or public settings',async t=>{
  const secrets=vault();let options;
  const runtime={...fakeRuntime,runTask:async value=>{options=value;return{ok:true,finalText:'真实执行器结果的替身。',sessionId:'owned-session'};}};
  const{service,dataDir}=await setup(t,{secretStore:secrets,runtime});
  const key='sk-test-private-value-only-for-this-test';
  await service.saveSettings({assistantName:'小雨',persona:'温暖但严谨',runtimeApiKey:key});
  const task=await service.createTask({prompt:'给我一段说明',kind:'agent'});const detail=await waitTask(service,task.id);
  assert.equal(detail.task.status,'succeeded');assert.equal(detail.artifacts.length,1);
  assert.equal(options.settings.env.DEEPSEEK_API_KEY,key);assert.match(options.settings.personaPrefix,/小雨/);
  const settings=await service.getSettings();assert.equal(settings.runtimeApiKey,undefined);assert.equal(settings.runtimeCredentialConfigured,true);
  assert.equal(fs.readFileSync(path.join(dataDir,'db','assistant.sqlite')).includes(Buffer.from(key)),false);
});

test('cancel stops only active task and preserves queued task execution',async t=>{
  let count=0;const runtime={...fakeRuntime,runTask:async({signal})=>{
    count++;if(count===1){await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}
    return{ok:true,finalText:'第二个任务正常完成。'};
  }};
  const{service}=await setup(t,{runtime,maxConcurrent:1});await service.saveSettings({runtimeApiKey:'test-key'});
  const first=await service.createTask({prompt:'长任务'});const second=await service.createTask({prompt:'第二个任务'});
  const deadline=Date.now()+3000;while(count!==1){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  await service.cancelTask(first.id);assert.equal((await waitTask(service,first.id)).task.status,'cancelled');
  assert.equal((await waitTask(service,second.id)).task.status,'succeeded');
});

test('a slow task leaves a second execution slot for a quick reply and never exceeds two active tasks',async t=>{
  let finishSlow,active=0,peak=0;
  const runtime={...fakeRuntime,runTask:async({prompt,signal})=>{
    active++;peak=Math.max(peak,active);
    try{
      if(prompt.startsWith('slow'))await new Promise((resolve,reject)=>{finishSlow=resolve;signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
      return{ok:true,finalText:'独立任务已完成。'};
    }finally{active--;}
  }};
  const{service}=await setup(t,{runtime});await service.saveSettings({runtimeApiKey:'test-key'});
  const slow=await service.createTask({prompt:'slow task'});
  const deadline=Date.now()+3000;while(!finishSlow){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  const quick=await service.createTask({prompt:'quick task'});
  assert.equal((await waitTask(service,quick.id)).task.status,'succeeded');
  assert.equal(service.getTask(slow.id).task.status,'running');assert.equal(peak,2);
  finishSlow();assert.equal((await waitTask(service,slow.id)).task.status,'succeeded');
});

test('unknown IDs and personal runtime home are rejected',async t=>{
  const{service}=await setup(t);assert.throws(()=>service.getTask('../../private'),/编号无效/);
  await assert.rejects(service.saveSettings({runtimeHome:path.join(os.homedir(),'.dsh')}),/数据目录内/);
  await assert.rejects(service.saveSettings({runtimeBaseUrl:'http://untrusted.example'}),/HTTPS/);
  await assert.rejects(service.saveSettings({runtimeCommand:'dsh && whoami'}),/完整 Harness 程序路径/);
});

test('DSH opened after the desktop is checked afresh before the first task',async t=>{
  let online=false,calls=0;
  const runtime={inspectHostedRuntime:async()=>({available:online,ready:online,detail:'synthetic host state',capabilities:{}}),
    readHostedCatalog:async()=>({ok:true,metadataOnly:true,skills:[],tools:[]}),
    runHostedTask:async()=>{calls++;return{ok:true,finalText:'启动后即可回答。'};}};
  const{service}=await setup(t,{runtime});assert.equal((await service.getBootstrap()).runtime.available,false);
  online=true;
  const task=await service.createTask({prompt:'DSH 刚刚打开，请回答'});
  assert.equal((await waitTask(service,task.id)).task.status,'succeeded');assert.equal(calls,1);
});

test('binary attachments never become imaginary AI text and no model request is made',async t=>{
  let invoked=false;const{service,dataDir}=await setup(t,{runtime:{...fakeRuntime,runTask:async()=>{invoked=true;return{ok:true,finalText:'bad'};}}});
  await service.saveSettings({runtimeApiKey:'test-key'});const source=path.join(dataDir,'说明.pdf');fs.writeFileSync(source,'%PDF fake fixture');service.grantAttachments([source]);
  const task=await service.createTask({prompt:'分析这个文件',attachmentPaths:[source]});const detail=await waitTask(service,task.id);
  assert.equal(detail.task.status,'failed');assert.match(detail.task.error,/PDF|文档/);assert.equal(invoked,false);
});
