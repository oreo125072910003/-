import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const types=new Set(['.docx','.xlsx','.pdf','.txt','.md','.csv','.tsv','.json','.tex','.yaml','.yml']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function snapshotWechatFile({wechat,kind,target,message,file,workspace,signal,maxBytes=16*1024*1024,allowIndexedFallback=false,verifyIndexedScope}){
  signal?.throwIfAborted();
  const ext=path.extname(file.name).toLowerCase();
  if(!types.has(ext))throw Object.assign(Error('FILE_FORMAT_UNSUPPORTED'),{code:'FILE_FORMAT_UNSUPPORTED'});
  const cacheAllowed=allowIndexedFallback===true&&typeof verifyIndexedScope==='function'&&await verifyIndexedScope()===true;
  const result=await new Promise((resolve,reject)=>{
    const abort=()=>reject(Object.assign(Error('FILE_READ_CANCELLED'),{code:'FILE_READ_CANCELLED'}));
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{signal?.throwIfAborted();return wechat.resolveFile({kind,target,messageId:message.id,id:file.id,signal,allowIndexedFallback:cacheAllowed});}).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',abort));
    if(signal?.aborted)abort();
  });
  signal?.throwIfAborted();
  if(result?.verification==='owner-authorized-cache-index'&&(!cacheAllowed||await verifyIndexedScope()!==true))throw Object.assign(Error('FILE_SCOPE_CHANGED'),{code:'FILE_SCOPE_CHANGED'});
  if(result?.id!==file.id||result.name!==file.name||typeof result.b64!=='string'||result.b64.length>Math.ceil(16*1024*1024/3)*4)throw Object.assign(Error('FILE_INTEGRITY_FAILED'),{code:'FILE_INTEGRITY_FAILED'});
  const bytes=Buffer.from(result.b64,'base64');
  if(bytes.length>maxBytes)throw Object.assign(Error('FILE_TOTAL_LIMIT'),{code:'FILE_TOTAL_LIMIT'});
  if(!bytes.length||bytes.length>16*1024*1024||bytes.length!==result.size||file.size&&file.size!==bytes.length||bytes.toString('base64')!==result.b64||hash(bytes)!==result.sha256)throw Object.assign(Error('FILE_INTEGRITY_FAILED'),{code:'FILE_INTEGRITY_FAILED'});
  const directory=path.join(workspace,'资料');
  if(fs.lstatSync(directory).isSymbolicLink()||fs.realpathSync.native(directory)!==path.join(fs.realpathSync.native(workspace),'资料'))throw Error('资料目录无效。');
  const destination=path.join(directory,'wechat-file-'+file.id.slice(0,16)+'-'+result.sha256.slice(0,16)+ext);
  if(fs.existsSync(destination)){if(fs.lstatSync(destination).isSymbolicLink()||hash(fs.readFileSync(destination))!==result.sha256)throw Error('附件快照已变化。');}
  else fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
  return{name:file.name,path:destination,size:bytes.length,sha256:result.sha256,status:'provided',verification:result.verification};
}
export async function prepareWechatTaskFiles({task,store,wechat,signal,saveAttachments,allowIndexedFallback=false,verifyIndexedScope}){
  const records=task.attachments.map(item=>({...item})),snippets=[],sources=[];
  const refs=records.filter(item=>item.source==='wechat-file'),conversation=store.getConversation(task.conversationId);
  if(!refs.length)return{snippets,sources};
  try{for(const item of refs){
    signal.throwIfAborted();
    const message=store.getWechatMessage(item.replyToMessageId),file=message?.files?.find(value=>value.id===item.fileId);
    if(!conversation||!message||message.outgoing||message.accountId!==conversation.accountId||message.kind!==conversation.kind||message.conversationId!==conversation.target||!file)throw Error('微信文件与原来信不一致。');
    try{
      const used=records.filter(record=>record.path&&record.status==='provided').reduce((sum,record)=>sum+(record.size??0),0);
      const snapshot=await snapshotWechatFile({wechat,kind:message.kind,target:message.conversationId,message,file,workspace:task.workspace,signal,maxBytes:Math.min(16*1024*1024,64*1024*1024-used),allowIndexedFallback,verifyIndexedScope});
      Object.assign(item,snapshot);saveAttachments(records);
      sources.push({name:item.name,source:'wechat-file',fileId:item.fileId,sha256:item.sha256,status:'provided'});
    }catch(error){
      if(signal.aborted)throw error;
      item.status='unavailable';item.errorCode=/^FILE_[A-Z_]+$/.test(error.code??'')?error.code:'FILE_READ_FAILED';saveAttachments(records);
      sources.push({name:item.name,source:'wechat-file',status:item.status,errorCode:item.errorCode});
      snippets.push(`[微信附件资料：${item.name}；本轮未取得可核验正文（${item.errorCode}）。若未缓存，请对方先在微信下载附件；旧 DOC/XLS 或加密文件需转为 DOCX/XLSX。不能仅凭名称猜测内容。]`);
    }
  }}finally{
    for(const item of refs.filter(item=>item.status==='pending'))Object.assign(item,{status:signal.aborted?'cancelled':'not_read',errorCode:signal.aborted?'FILE_READ_CANCELLED':'FILE_READ_NOT_COMPLETED'});
    saveAttachments(records);
  }
  return{snippets,sources};
}
