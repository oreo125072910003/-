import test from 'node:test';
import assert from 'node:assert/strict';
import { bindConversationContext, selectConversationPrefix } from '../packages/harness-host-plugin/context-policy.mjs';

function history() {
  const events = [{ type: 'system/message', seq: 0 }];
  for (let i=0;i<100;i++) events.push({type:i%2?'assistant/message':'user/message',seq:i+1});
  const session={surface:{nodes:events.map(e=>e.seq)},eventAt:seq=>events[seq]};
  const measurement={totalTokens:200000,nodes:events.map(e=>({seq:e.seq,tokens:2000}))};
  return {session,measurement,events};
}

test('native prefix selection keeps system, recent 12 user messages, and at least 24k tokens',()=>{
  const {session,measurement}=history();
  const range=selectConversationPrefix(session,measurement,()=>true);
  assert.equal(range.start,1);assert.equal(range.end,76);
  assert.equal(selectConversationPrefix(session,{...measurement,totalTokens:10000},()=>true),null);
  assert.equal(selectConversationPrefix(session,{...measurement,nodes:measurement.nodes.slice(1)},()=>true),null);
  assert.equal(selectConversationPrefix(session,measurement,()=>false),null);
  assert.equal(selectConversationPrefix(session,measurement,(_s,seq)=>seq<=70).end,69);
});

test('context policy calls native compaction and durable checkpoint before the ordinary request',async()=>{
  const {session,measurement}=history(), calls=[], states=[];
  let listener,disposed=false;
  const agentCtx={on(name,fn){assert.equal(name,'agent/pre-step');listener=fn;return()=>{disposed=true;};}};
  const host={tokenMeter:{measure:()=>measurement},compaction:{async compactRegion(start,end,agent){assert.equal(agent.session,session);calls.push([start,end]);measurement.totalTokens=36000;}},sessions:{async flush(){calls.push('flush');}}};
  const dispose=bindConversationContext(agentCtx,host,{balancedBefore:()=>true,onMaintenance:v=>states.push(v)});
  const original={provider:'existing-account',model:'deepseek-flash',reasoningEffort:'high'};
  assert.strictEqual(await listener({agent:{session},signal:new AbortController().signal},async()=>{calls.push('request');return original;}),original);
  assert.deepEqual(calls,[[1,76],'flush','request']);assert.deepEqual(states.map(s=>s.state),['running','completed']);
  assert.equal(original.reasoningEffort,'high');assert.equal(states[1].afterTokens,36000);
  dispose();assert.equal(disposed,true);
});

test('failed summary, cancelled task and failed persistence cannot issue the next request',async()=>{
  for(const failure of ['summary','save','cancel']){
    const {session,measurement}=history();let listener,requested=false;const controller=new AbortController();
    const host={tokenMeter:{measure:()=>measurement},compaction:{async compactRegion(){if(failure==='summary')throw Error('synthetic summary failure');if(failure==='cancel')controller.abort();}},sessions:{async flush(){return failure==='save'?false:undefined;}}};
    bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host,{balancedBefore:()=>true});
    await assert.rejects(()=>listener({agent:{session},signal:controller.signal},async()=>{requested=true;}));
    assert.equal(requested,false,failure);
  }
});

test('older DSH installations with no native compaction remain compatible',()=>{
  assert.equal(bindConversationContext({on(){throw Error('must not register');}},{},{}),null);
});

test('DSH Web resolves the engine from the product preset rather than the disabled host engine',async()=>{
  const {session,measurement}=history();let listener,compacted=false;
  const host={tokenMeter:{measure:()=>measurement},agentPresets:{serviceFor(agent,name){assert.equal(agent.session,session);assert.equal(name,'compaction');return{async compactRegion(){compacted=true;}};}},sessions:{async flush(){}}};
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host);
  await listener({agent:{session},signal:new AbortController().signal},async()=>{});
  assert.equal(compacted,true);
});

test('an absent optional host service never falls through to an undeclared Cordis property',async()=>{
  const {session,measurement}=history();let listener,compacted=false,requested=false;
  const host={
    get(name){return name==='tokenMeter'?{measure:()=>measurement}:undefined;},
    get compaction(){throw Error('cannot get property "compaction" without inject');},
    get tokenMeter(){throw Error('cannot get property "tokenMeter" without inject');},
    agentPresets:{serviceFor(){return{async compactRegion(){compacted=true;}};}},
    sessions:{async flush(){}},
  };
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host);
  await listener({agent:{session},signal:new AbortController().signal},async()=>{requested=true;});
  assert.equal(compacted,true);assert.equal(requested,true);
});

test('an unavailable native engine is reported instead of being mistaken for successful maintenance',async()=>{
  let listener,requested=false;const states=[];
  const host={tokenMeter:{measure(){throw Error('engine missing; must not measure');}},agentPresets:{serviceFor(){}},sessions:{}};
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host,{onMaintenance:v=>states.push(v)});
  await listener({agent:{},signal:new AbortController().signal},async()=>{requested=true;});
  assert.deepEqual(states,[{state:'unavailable',reason:'native-engine-unavailable'}]);
  assert.equal(requested,true);
});

test('production tool cut keeps a call and its result together',async()=>{
  const {session,measurement,events}=history();let listener,selected;
  for(const node of measurement.nodes)node.tokens=1000;
  events[76].data={message:{content:[{type:'tool-call'}]}};
  events[77].type='tool/result';events[100].type='user/message';
  const host={tokenMeter:{measure:()=>measurement},compaction:{async compactRegion(start,end){selected={start,end};}},sessions:{async flush(){}}};
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host);
  await listener({agent:{session},signal:new AbortController().signal},async()=>{});
  assert.deepEqual(selected,{start:1,end:75});
});

test('an already cancelled turn never starts compaction or the ordinary request',async()=>{
  const {session,measurement}=history();let listener,requested=false,compacted=false;const controller=new AbortController();controller.abort();
  const host={tokenMeter:{measure:()=>measurement},compaction:{async compactRegion(){compacted=true;}},sessions:{async flush(){}}};
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host);
  await assert.rejects(()=>listener({agent:{session},signal:controller.signal},async()=>{requested=true;}));
  assert.equal(compacted,false);assert.equal(requested,false);
});

test('an installed compression owner delegates maintenance before native summary dispatch',async()=>{
  const {session,measurement}=history();let listener,requested=false,compacted=false;const states=[];
  const host={get(name){return ({biliBasicCompactionPolicy:{owner:'billion-context'},tokenMeter:{measure:()=>measurement}})[name];},
    agentPresets:{serviceFor(){throw Error('must not enter a competing native engine');}},
    sessions:{flush(){throw Error('must not write a competing checkpoint');}}};
  bindConversationContext({on(_name,fn){listener=fn;return()=>{};}},host,{onMaintenance:value=>states.push(value)});
  await listener({agent:{session},signal:new AbortController().signal},async()=>{requested=true;});
  assert.equal(requested,true);assert.equal(compacted,false);
  assert.deepEqual(states,[{state:'delegated',owner:'billion-context',beforeTokens:200000}]);
});
