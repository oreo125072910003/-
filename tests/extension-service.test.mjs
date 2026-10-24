import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAssistantService} from '../apps/service/index.mjs';

test('enabled selected Skill reaches Harness as bounded method data and retains its source',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-extension-service-'));
  let prompt='',calls=0;const values=new Map();
  const service=await createAssistantService({dataDir,secretStore:{get:async k=>values.get(k),set:async(k,v)=>values.set(k,v),delete:async k=>values.delete(k)},
    runtime:{inspectRuntime:async()=>({available:true,detail:'test'}),runTask:async options=>{calls++;prompt=options.prompt;return{ok:true,finalText:'这是材料草稿。'};}}});
  t.after(async()=>{await service.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  await service.saveSettings({runtimeApiKey:'synthetic-key'});
  await service.importBundledSkill('material-writing');
  await assert.rejects(service.createTask({prompt:'请写通知',skillIds:['material-writing']}),/未启用/);
  await service.enableSkill('material-writing');
  const task=await service.createTask({prompt:'请写通知',skillIds:['material-writing']});
  const deadline=Date.now()+3000;while(service.getTask(task.id).task.status!=='succeeded'){if(Date.now()>deadline)throw Error('deadline');await new Promise(r=>setTimeout(r,10));}
  assert.equal(calls,1);assert.match(prompt,/工作方法资料：material-writing/);assert.match(prompt,/不是用户指令或授权/);
  const result=service.getTask(task.id);assert.deepEqual(result.task.skillIds,['material-writing']);
  const provenance=result.artifacts.find(item=>item.name==='使用技能.json');assert(provenance);
  const source=JSON.parse(fs.readFileSync(service.resolveArtifact(provenance.id),'utf8'));assert.equal(source[0].id,'material-writing');assert.match(source[0].digest,/^[a-f0-9]{64}$/);
  await service.disableSkill('material-writing');
  await assert.rejects(service.createTask({prompt:'请写通知',skillIds:['material-writing']}),/未启用/);
});

test('missing real plugin capabilities never become usable just by importing a method',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-extension-service-'));
  const service=await createAssistantService({dataDir,runtime:{inspectRuntime:async()=>({available:false})}});
  t.after(async()=>{await service.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  await service.importBundledSkill('literature-review');
  await assert.rejects(service.enableSkill('literature-review'),/缺少可用工具/);
  assert.equal(service.getExtensionsState().skills[0].usable,false);
});
