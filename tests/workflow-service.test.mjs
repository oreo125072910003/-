import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantService } from '../apps/service/index.mjs';
import { extractDocument, writeOfficeDocument } from '../packages/documents/index.mjs';

const vault=()=>{const data=new Map();return{get:async key=>data.get(key),set:async(key,value)=>data.set(key,value),delete:async key=>data.delete(key)};};
const inspectRuntime=async()=>({available:true,credentialsConfigured:false,detail:'Test runtime'});
async function setup(t,runTask){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-workflow-test-'));const service=await createAssistantService({dataDir,runtime:{inspectRuntime,runTask},secretStore:vault()});t.after(async()=>{await service.close();assert.equal(path.dirname(dataDir),os.tmpdir());fs.rmSync(dataDir,{recursive:true,force:true});});return{dataDir,service};}
async function done(service,id){for(let deadline=Date.now()+10000;Date.now()<deadline;){const value=service.getTask(id);if(['succeeded','partial','failed','cancelled','waiting_dependency'].includes(value.task.status))return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('workflow timeout');}

test('two actual Harness invocations persist roles, artifacts and source hashes',async t=>{
  const calls=[];const{service,dataDir}=await setup(t,async value=>{calls.push(value);return{ok:true,finalText:calls.length===1?'起草的实际正文。':'审查的实际意见。'};});
  await service.saveSettings({runtimeApiKey:'workflow-test-key'});
  const task=await service.createTask({prompt:'写一份安排并审查',workflowId:'writing-review'});const result=await done(service,task.id);
  assert.equal(result.task.status,'succeeded');assert.equal(calls.length,2);assert.equal(result.workerResult.budget.callsUsed,2);assert.equal(result.workerResult.review.assurance,'model-opinion-only');
  assert.notEqual(calls[0].workspace,calls[1].workspace);assert.notEqual(calls[0].settings.home,calls[1].settings.home);assert.match(calls[1].prompt,/起草的实际正文/);assert.ok(result.workerResult.steps.every(step=>step.status==='succeeded'));
  assert.equal(result.artifacts.length,4);for(const artifact of result.artifacts)assert.ok(fs.existsSync(service.resolveArtifact(artifact.id)));
  await service.close();const reopened=await createAssistantService({dataDir,runtime:{inspectRuntime,runTask:async()=>{throw Error('no replay');}},secretStore:vault()});assert.equal(reopened.getTask(task.id).workerResult.budget.callsUsed,2);await reopened.close();
});

test('unconfigured collaboration makes zero model calls; invalid workflow is rejected',async t=>{
  let calls=0;const{service}=await setup(t,async()=>{calls++;return{ok:true,finalText:'unexpected'};});
  await assert.rejects(service.createTask({prompt:'bad',workflowId:'invented'}),/流程/);
  const task=await service.createTask({prompt:'安排',workflowId:'research-compare'});assert.equal((await done(service,task.id)).task.status,'waiting_dependency');assert.equal(calls,0);
});

test('failed review remains partial and preserves the original draft',async t=>{
  let calls=0;const{service}=await setup(t,async()=>++calls===1?{ok:true,finalText:'已经完成的原稿。'}:{ok:false,error:'test failure'});
  await service.saveSettings({runtimeApiKey:'workflow-test-key'});const task=await service.createTask({prompt:'起草并检查',workflowId:'writing-review'});const result=await done(service,task.id);
  assert.equal(result.task.status,'partial');assert.match(result.task.summary,/已经完成的原稿/);assert.equal(result.workerResult.steps[1].status,'failed');assert.equal(result.artifacts.length,3);
});

test('real DOCX text reaches Harness and exported Word/PDF contain the whole result',async t=>{
  let request;const ending='这里是超过任务摘要上限以后的结尾。';const output='完整正文。'.repeat(2500)+ending;
  const{service,dataDir}=await setup(t,async value=>{request=value;return{ok:true,finalText:output};});
  const inputs=path.join(dataDir,'synthetic');fs.mkdirSync(inputs);const created=await writeOfficeDocument({workspace:inputs,title:'合成资料',blocks:[{type:'paragraph',text:'唯一确认的事实是本周完成三项工作。'}],formats:['docx']});
  service.grantAttachments([created.artifacts[0].path]);await service.saveSettings({runtimeApiKey:'workflow-test-key'});const task=await service.createTask({prompt:'按资料整理',attachmentPaths:[created.artifacts[0].path]});const result=await done(service,task.id);
  assert.equal(result.task.status,'succeeded');assert.match(request.prompt,/唯一确认的事实/);assert.ok(result.task.summary.length<output.length);
  const [exported]=await Promise.all([service.exportTaskDocument({taskId:task.id,formats:['docx','pdf']}),service.exportTaskDocument({taskId:task.id,formats:['docx']})]);
  assert.equal(exported.artifacts.filter(item=>/小助手成果\./.test(item.name)).length,2);
  const docx=exported.artifacts.find(item=>item.name==='小助手成果.docx');const parsed=await extractDocument({path:service.resolveArtifact(docx.id),allowedRoot:task.workspace,maxChars:30000});assert.match(parsed.text,new RegExp(ending));
  assert.equal(service.getTask(task.id).artifacts.filter(item=>item.name==='小助手成果.docx').length,1);
});
