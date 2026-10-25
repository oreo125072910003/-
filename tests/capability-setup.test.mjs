import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createAssistantService } from '../apps/service/index.mjs';
import { createDshAccess, validateGrants } from '../apps/service/dsh-access.mjs';
import { normalizeOwnerGrants } from '../packages/harness-host-plugin/owner-access.mjs';
import { PRODUCT_TOOLS } from '../packages/contracts/product-tools.mjs';
import { describeTool } from '../packages/contracts/tool-policy.mjs';

const catalog=()=>({ok:true,metadataOnly:true,skills:[{name:'office',modelInvocable:true},{name:'internal',modelInvocable:false}],tools:PRODUCT_TOOLS.map(tool=>({...tool,...describeTool(tool.name)}))});
const plain=value=>JSON.parse(JSON.stringify(value));

test('full catalog selection exceeds the former 64-item limit in both product and host guards',()=>{
  const skills=Array.from({length:300},(_,i)=>'skill-'+i);
  assert.equal(validateGrants({skills}).skills.length,300);
  assert.equal(normalizeOwnerGrants({authority:'product-owner',ownerGrants:{skills}}).skills.length,300);
  assert.throws(()=>validateGrants({tools:Array.from({length:501},(_,i)=>'tool_'+i)}));
});

test('desktop computer scope accepts only product computer tools and never applies to incoming conversations',()=>{
  const body={authority:'product-owner',executionPolicy:'trusted-desktop-computer-task-v1',ownerGrants:{tools:['xiaozhushou_read_local_file','xiaozhushou_run_local_shell','xiaozhushou_export_file']}};
  assert.equal(normalizeOwnerGrants(body).tools.length,3);
  for(const change of [{authority:'external'},{conversation:{channel:'wechat'}},{conversation:{channel:'mail'}},{computerScope:{kind:'private'}},{ownerGrants:{tools:['mcp__pcbridge__run_local_shell']}}])assert.throws(()=>normalizeOwnerGrants({...body,...change}));
  assert.throws(()=>normalizeOwnerGrants({...body,executionPolicy:'owner-grants-v1'}));
});

test('desktop flag adds only live product tools, remains revocable, and never leaks to external sources',async()=>{
  let enabled=true;
  const access=createDshAccess({runtime:{readHostedCatalog:async()=>catalog()},settingsProvider:()=>({hostedConfigFile:'local.json'}),store:{getSettings:()=>({dshDesktopComputerAccess:enabled}),saveSettings:()=>{}}});
  assert.ok((await access.grantsForTask({source:'desktop'})).tools.includes('xiaozhushou_run_local_shell'));
  assert.deepEqual(await access.grantsForTask({source:'wechat'}),{skills:[],tools:[]});
  enabled=false;assert.deepEqual(await access.grantsForTask({source:'desktop'}),{skills:[],tools:[]});
});

test('desktop computer, local file reading and delivery run end-to-end with persisted settings',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-desktop-computer-'));
  const original=path.join(root,'synthetic-input.txt');fs.writeFileSync(original,'SYNTHETIC_FILE_CONTENT');
  const dataDir=path.join(root,'product');let seen;
  const runtime={inspectHostedRuntime:async()=>({available:true,detail:'synthetic',capabilities:{desktopComputerTasks:true}}),readHostedCatalog:async()=>catalog(),runHostedTask:async request=>{
    seen=request.settings;assert.equal(seen.hostedExecutionPolicy,'trusted-desktop-computer-task-v1');
    const call=async(name,args)=>{
      const response=await fetch(seen.hostedProductConnection.endpoint,{method:'POST',headers:{authorization:'Bearer '+seen.hostedProductConnection.token,'content-type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),name,args})});
      const result=await response.json();assert.equal(result.isError,false,JSON.stringify(result));return JSON.parse(result.content);
    };
    assert.match(JSON.stringify(await call('xiaozhushou_read_local_file',{path:original})),/SYNTHETIC_FILE_CONTENT/);
    const exported=await call('xiaozhushou_export_file',{path:original});await call('xiaozhushou_attachment',{artifactId:exported.artifact.id,mediaType:'file'});
    return {ok:true,finalText:'已读取并保存合成文件。',artifacts:[]};
  }};
  let service=await createAssistantService({dataDir,runtime});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.setDesktopComputerAccess({enabled:true});
  await service.saveDshOwnerGrants({tools:['xiaozhushou_attachment']});
  await service.saveSettings({defaultSkillIds:[]});
  const task=await service.createTask({prompt:'读取并交付合成文件'});
  const deadline=Date.now()+7000;while(Date.now()<deadline&&!['succeeded','failed'].includes(service.getTask(task.id).task.status))await new Promise(resolve=>setTimeout(resolve,20));
  const result=service.getTask(task.id);assert.equal(result.task.status,'succeeded',result.task.error);assert.ok(result.artifacts.some(item=>item.name.endsWith('synthetic-input.txt')));
  await service.close();service=await createAssistantService({dataDir,runtime});
  assert.equal((await service.getDshAccessState()).computerEnabled,true);
  assert.deepEqual((await service.getSettings()).defaultSkillIds,[]);
  assert.ok(service.getExtensionsState().availableCapabilities.includes('documents.write'));
  await service.setDesktopComputerAccess({enabled:false});assert.equal((await service.getDshAccessState()).computerEnabled,false);
});

test('bulk selectors honor filters, ignore unavailable abilities, and full-save selects the whole catalog',()=>{
  const source=fs.readFileSync(new URL('../apps/desktop/renderer/app.js',import.meta.url),'utf8');
  const context=vm.createContext({window:{assistant:{}},document:{querySelector:()=>null,addEventListener:()=>{}},TextEncoder,setTimeout,clearTimeout});
  vm.runInContext(source.slice(0,source.lastIndexOf('\nrenderShell();'))+'\nglobalThis.subject={state,selectCatalog};',context);
  const {state,selectCatalog}=context.subject;
  state.dshAccess={catalog:{skills:[{name:'office',modelInvocable:true},{name:'internal',modelInvocable:false}],tools:[{name:'read',description:'files',grantable:true},{name:'draw',grantable:true},{name:'shell',grantable:false}]}};
  state.dshGrantQuery='files';selectCatalog('dsh',true);assert.deepEqual(plain(state.dshGrantDraft),{skills:[],tools:['read']});
  selectCatalog('dsh',true,false);assert.deepEqual(plain(state.dshGrantDraft),{skills:['office'],tools:['read','draw']});
  selectCatalog('dsh',false);assert.deepEqual(plain(state.dshGrantDraft),{skills:['office'],tools:['draw']});
});

test('computer status reports saved settings separately from a ready live host',()=>{
  const source=fs.readFileSync(new URL('../apps/desktop/renderer/app.js',import.meta.url),'utf8');
  const context=vm.createContext({window:{assistant:{}},document:{querySelector:()=>null,addEventListener:()=>{}},TextEncoder,setTimeout,clearTimeout});
  vm.runInContext(source.slice(0,source.lastIndexOf('\nrenderShell();'))+'\nglobalThis.subject={state,desktopComputerState,renderDesktopComputerAccess};',context);
  const {state,desktopComputerState,renderDesktopComputerAccess}=context.subject;
  state.dshAccess={computerEnabled:true,connected:true};state.bootstrap={runtime:{available:true,capabilities:{}}};
  assert.equal(desktopComputerState().ready,false);assert.match(desktopComputerState().label,/等待重载/);
  assert.match(renderDesktopComputerAccess(),/系统托盘完整退出/);assert.doesNotMatch(renderDesktopComputerAccess(),/已启用，自动记住/);
  state.bootstrap.runtime.capabilities.desktopComputerTasks=true;
  assert.equal(desktopComputerState().ready,true);assert.match(renderDesktopComputerAccess(),/已启用，自动记住/);
  state.dshAccess.connected=false;assert.equal(desktopComputerState().ready,false);assert.match(desktopComputerState().label,/等待连接/);
  state.dshAccess.computerEnabled=false;assert.equal(desktopComputerState().enabled,false);assert.equal(desktopComputerState().detail,'');
});
