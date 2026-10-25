import test from 'node:test';
import assert from 'node:assert/strict';
import {describeTool,grantableTool} from '../packages/contracts/tool-policy.mjs';
import {bindOwnerAccess,normalizeOwnerGrants} from '../packages/harness-host-plugin/owner-access.mjs';
import {createHarnessWorkerAdapter} from '../packages/workers/index.mjs';

test('actual MCP namespaces, bare control aliases and unclassified proxy tools do not grant computer authority',async()=>{
  const controls=['shell','run_local_shell','mcp__pcbridge__run_local_shell','MCP__PCBRIDGE__RUN_LOCAL_SHELL','pcbridge.run_local_shell','pcbridge:run_local_agent','mcp__pcbridge__write_local_file','mcp__pcbridge__read_local_file','mcp__other__run_local_agent','mcp__other__dispatch','opaque_proxy'];
  for(const name of controls){
    assert.equal(grantableTool(name),false,name);
    assert.throws(()=>normalizeOwnerGrants({authority:'product-owner',ownerGrants:{tools:[name]}}),{code:'OWNER_GRANTS_INVALID'});
    await assert.rejects(bindOwnerAccess({}, {tools:{schemas:()=>[{name}]}},{},{grants:{skills:[],tools:[name]},active:()=>true,signal:new AbortController().signal}),{code:'OWNER_TOOL_UNAVAILABLE'});
  }
});
test('recognized contract and interface tools remain usable under the same catalog and final execution classification',async()=>{
  for(const name of ['mcp__pcbridge__fetch_scores','mcp__pcbridge__fetch_paper','mcp__pcbridge__screenshot_url','mcp__contract_helper__query_inventory','mcp__contract_helper__recommend_materials','mcp__contract_helper__library_search']){
    assert.equal(describeTool(name).category,'business-tool');
    const grants=normalizeOwnerGrants({authority:'product-owner',ownerGrants:{tools:[name]}});
    const access=await bindOwnerAccess({}, {tools:{schemas:()=>[{name}]}},{},{grants,active:()=>true,signal:new AbortController().signal});
    assert.equal(access.policy.check(name),true,name);access.dispose();
  }
});
test('text worker adapter removes both tools and skills even when the trusted parent settings contain them',async()=>{
  let request;
  const settings={hostedOwnerGrants:{skills:['office-docx'],tools:['mcp__pcbridge__fetch_paper']},hostedExecutionPolicy:'owner-grants-v1'};
  const adapter=createHarnessWorkerAdapter({runtime:{runTask:async value=>{request=value;return {ok:true,finalText:'done'};}},settingsProvider:async()=>settings});
  await adapter({role:'writer',task:{parentTaskId:'parent'},workspace:'G:\\synthetic',prompt:'write',signal:new AbortController().signal});
  assert.equal(request.settings.hostedExecutionPolicy,'worker-text-only-v1');
  assert.deepEqual(request.settings.hostedOwnerGrants,{skills:[],tools:[]});
  assert.equal(settings.hostedOwnerGrants.tools.length,1,'parent authority is retained for its direct task');
  assert.deepEqual(normalizeOwnerGrants({executionPolicy:'worker-text-only-v1',authority:'product-owner',ownerGrants:settings.hostedOwnerGrants}),{skills:[],tools:[]});
});

test('separate computer policy requires a verified private-conversation scope while ordinary grants still deny control aliases',async()=>{
  const name='mcp__pcbridge__run_local_agent';
  const body={executionPolicy:'trusted-computer-task-v1',authority:'product-owner',ownerGrants:{tools:[name]},conversation:{channel:'wechat'},computerScope:{accountId:'777',kind:'private',target:'101'}};
  const grants=normalizeOwnerGrants(body);
  const access=await bindOwnerAccess({}, {tools:{schemas:()=>[{name}]}},{},{grants,executionPolicy:body.executionPolicy,active:()=>true,signal:new AbortController().signal});
  assert.equal(access.policy.check(name),true);access.dispose();
  assert.throws(()=>normalizeOwnerGrants({...body,computerScope:{...body.computerScope,kind:'group'}}),{code:'COMPUTER_SCOPE_INVALID'});
  assert.throws(()=>normalizeOwnerGrants({...body,executionPolicy:'owner-grants-v1'}),{code:'OWNER_GRANTS_INVALID'});
  assert.deepEqual(normalizeOwnerGrants({...body,executionPolicy:'worker-text-only-v1'}),{skills:[],tools:[]});
});
