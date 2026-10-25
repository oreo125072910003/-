import fs from 'node:fs';
import path from 'node:path';
import { validateGrants } from './dsh-access.mjs';
import { grantableTool, computerGrantableTool } from '../../packages/contracts/tool-policy.mjs';

const EMPTY=()=>({skills:[],tools:[]});
const fail=message=>Object.assign(Error(message),{code:'WECHAT_DSH_ACCESS_DENIED'});
const ID=/^[1-9]\d{0,15}$/;
const key=(kind,target)=>`${kind}:${target}`;
const allowed=(config,kind,target)=>['private','group'].includes(kind)&&ID.test(target??'')&&(kind==='group'?config.allowedGroups:config.allowedPrivate)?.includes(target);
const canonicalEndpoint=value=>{try{return new URL(value).origin;}catch{return '';}};

/** All public mutations are exposed only through trusted desktop IPC. Message
 * content is never used as an authority, and no global owner grants are copied. */
export function createWechatDshAccess({store,dshAccess,legacySources=[],getWechatState,onChange=()=>{}}){
  const config=()=>store.getSettings().wechatConnection??{};
  const registry=()=>{
    const value=store.getSettings().dshWechatGrants;
    return value?.schema===1&&value.chats&&typeof value.chats==='object'&&!Array.isArray(value.chats)?structuredClone(value):{schema:1,chats:{}};
  };
  function savedFor(accountId,kind,target){
    try{return validateGrants(registry().chats[`${accountId}:${key(kind,target)}`]?.grants??EMPTY());}catch{return EMPTY();}
  }
  async function verified(kind,target){
    const state=await getWechatState(),current=config();
    if(!state.connection?.accountVerified||state.connection.state!=='ready'||state.connection.selfId!==current.boundAccountId||!ID.test(current.boundAccountId??''))throw fail('请先连接并核对当前微信账号。');
    if(kind!==undefined&&!allowed(current,kind,target))throw fail('当前微信会话没有授权。');
    return {state,accountId:current.boundAccountId,connectionId:current.connectionId};
  }
  async function getState({kind,target}={}){
    const identity=await verified(kind,target),catalog=await dshAccess.getCatalog();
    const summarize=(k,t)=>{
      const saved=savedFor(identity.accountId,k,t);
      const computer=registry().chats[`${identity.accountId}:${key(k,t)}`]?.computerAccess;
      const computerEnabled=k==='private'&&computer?.enabled===true;
      const effective={skills:saved.skills.filter(n=>catalog.ok&&catalog.skills.some(s=>s.name===n&&s.modelInvocable)),tools:saved.tools.filter(n=>catalog.ok&&catalog.tools.some(s=>s.name===n&&(grantableTool(n)&&s.grantable||computerEnabled&&computer.tools?.includes(n)&&computerGrantableTool(n)&&s.computerGrantable)))};
      return {kind:k,target:t,saved,effective,computerAccess:{enabled:computerEnabled,eligibleTools:saved.tools.filter(computerGrantableTool)},unavailable:{skills:saved.skills.filter(n=>!effective.skills.includes(n)),tools:saved.tools.filter(n=>!effective.tools.includes(n))}};
    };
    const current=config();
    if(current.boundAccountId!==identity.accountId||current.connectionId!==identity.connectionId)throw fail('微信连接已变化，请重新核对授权。');
    return {source:'wechat',accountVerified:true,accountId:identity.accountId,connected:catalog.ok,catalog,
      ...(kind?summarize(kind,target):{chats:[...(current.allowedPrivate??[]).map(t=>summarize('private',t)),...(current.allowedGroups??[]).map(t=>summarize('group',t))]}),externalContentInheritsOwner:false};
  }
  async function saveGrants({kind,target,grants,clearUnavailable=false}={}){
    if(typeof clearUnavailable!=='boolean')throw fail('清除不可用选择必须是明确开关。');
    const identity=await verified(kind,target),selected=validateGrants(grants),catalog=await dshAccess.getCatalog();
    if((selected.skills.length||selected.tools.length)&&!catalog.ok)throw fail('Harness 目录不可用，未保存新增授权；可清空撤权。');
    if(selected.tools.some(n=>!grantableTool(n)||!catalog.tools.some(t=>t.name===n&&t.grantable))||selected.skills.some(n=>!catalog.skills.some(s=>s.name===n&&s.modelInvocable)))throw fail('选择中含不可用或需单独控制权限的工具，未保存。');
    const again=await verified(kind,target);if(again.accountId!==identity.accountId||again.connectionId!==identity.connectionId)throw fail('微信连接已变化，未保存。');
    const previous=savedFor(identity.accountId,kind,target);
    const retained=clearUnavailable?EMPTY():{skills:previous.skills.filter(n=>!catalog.ok||!catalog.skills.some(s=>s.name===n&&s.modelInvocable)),tools:previous.tools.filter(n=>!catalog.ok||!grantableTool(n)||!catalog.tools.some(t=>t.name===n&&t.grantable))};
    const saved=validateGrants({skills:[...new Set([...selected.skills,...retained.skills])],tools:[...new Set([...selected.tools,...retained.tools])]});
    const value=registry(),entry=`${identity.accountId}:${key(kind,target)}`;value.chats[entry]={...value.chats[entry],grants:saved,source:'desktop-explicit',updatedAt:new Date().toISOString()};
    store.saveSettings({dshWechatGrants:value});onChange();return getState({kind,target});
  }
  async function importLegacy(){
    const identity=await verified(),current=config(),value=registry();
    // Legacy grants have no account field. Bind a migration to the first verified
    // imported account once; a later account switch cannot claim the same grants.
    if(value.legacyAccountId&&value.legacyAccountId!==identity.accountId)throw fail('原授权已绑定另一微信账号；请在当前账号逐会话明确设置。');
    let project;
    for(const source of legacySources.filter(s=>s.kind==='wechatagent')){
      try{
        const root=fs.realpathSync(source.path),filename=path.join(root,'config/wechatagent.json'),info=fs.lstatSync(filename);
        if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024||fs.realpathSync(filename)!==filename)continue;
        const data=fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,'');const parsed=JSON.parse(data);
        const ioPath=path.join(root,'state/wechat-io-config.json'),ioInfo=fs.lstatSync(ioPath);
        if(!ioInfo.isFile()||ioInfo.isSymbolicLink()||ioInfo.size>131072)continue;
        const io=JSON.parse(fs.readFileSync(ioPath,'utf8').replace(/^\uFEFF/,''));
        if(parsed.runtime?.sender!=='wechat-hook'||canonicalEndpoint(parsed.hook?.baseUrl)!==canonicalEndpoint(current.hookBaseUrl)||canonicalEndpoint(io.reader_base_url)!==canonicalEndpoint(current.readerBaseUrl))continue;
        project=parsed;break;
      }catch{}
    }
    if(!project) return {imported:false,reason:'没有找到与当前连接吻合的原授权来源。'};
    const chats=project.wechat?.dshAccess?.chats??{};let imported=0;
    for(const [chat,raw]of Object.entries(chats)){
      const match=chat.match(/^wechat:(private|group):([1-9]\d{0,15})$/);if(!match)continue;
      const [,kind,target]=match,entry=`${identity.accountId}:${key(kind,target)}`;
      if(!allowed(current,kind,target)||value.chats[entry])continue;
      try{value.chats[entry]={grants:validateGrants(raw),source:'legacy-chat-selection',updatedAt:new Date().toISOString()};imported++;}catch{}
    }
    const again=await verified();if(again.accountId!==identity.accountId||again.connectionId!==identity.connectionId)throw fail('微信连接已变化，未迁入授权。');
    value.legacyAccountId=identity.accountId;
    store.saveSettings({dshWechatGrants:value});onChange();
    return {imported:true,chatsImported:imported,...await getState()};
  }
  async function saveComputerAccess({kind,target,enabled,confirmation}={}){
    if(kind!=='private'||typeof enabled!=='boolean'||enabled&&confirmation!=='allow-computer-control')throw fail('电脑控制只能在已核验的私聊中由主人明确启用。');
    const identity=await verified(kind,target),value=registry(),entry=`${identity.accountId}:${key(kind,target)}`;
    const selected=savedFor(identity.accountId,kind,target),tools=selected.tools.filter(computerGrantableTool);
    if(enabled&&!tools.length)throw fail('此聊天没有原先明确选择的电脑工具，请先迁入并核对原选择。');
    value.chats[entry]={...value.chats[entry],grants:selected,computerAccess:{enabled,tools:enabled?tools:[],approvedAt:new Date().toISOString()},source:'desktop-explicit'};
    store.saveSettings({dshWechatGrants:value});onChange();return getState({kind,target});
  }
  async function accessForMessage(message){
    const empty=()=>({grants:EMPTY()});
    if(!message||message.outgoing||!allowed(config(),message.kind,message.conversationId))return empty();
    try{
      const identity=await verified(message.kind,message.conversationId);if(identity.accountId!==message.accountId)return empty();
      const state=await getState({kind:message.kind,target:message.conversationId});
      const computer=state.computerAccess.enabled&&state.effective.tools.some(computerGrantableTool);
      return {grants:state.effective,...(computer?{executionPolicy:'trusted-computer-task-v1',computerScope:{accountId:identity.accountId,kind:message.kind,target:message.conversationId}}:{})};
    }catch{return empty();}
  }
  async function grantsForMessage(message){return (await accessForMessage(message)).grants;}
  return {getState,saveGrants,saveComputerAccess,importLegacy,grantsForMessage,accessForMessage};
}
