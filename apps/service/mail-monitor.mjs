import { createHash } from 'node:crypto';
const stamp=()=>new Date().toISOString();
const clean=(text,max)=>String(text??'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,max);
export function mailNotice(account,message){
  const sender=(message.from??[]).map(item=>item.name||item.address).filter(Boolean).join('、');
  return `小助手提醒你：收到新邮件\n邮箱：${clean(account.name||account.address,120)}\n发件人：${clean(sender,180)}\n主题：${clean(message.subject||'（无主题）',300)}\n${clean(message.text||'正文暂未读取，可在小助手收件箱查看。',360)}`;
}
/** Product-owned polling. Mail content never selects a recipient or grants tools. */
export function createMailMonitor({store,mail,wechat,onChange=()=>{},intervalMs=60000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let timer,operation,closed=false;
  const config=()=>store.getSettings().mailNotifications??{enabled:false};
  const state=()=>structuredClone(store.getSettings().mailNotificationState??{accounts:{},pending:[],lastCheckAt:null,error:''});
  function save(value){store.saveSettings({mailNotificationState:value});onChange();}
  function targetReady(selected){const value=wechat.getState(),settings=value.settings??{};return value.connection?.state==='ready'&&value.connection.accountVerified&&value.connection.selfId===selected.accountId&&settings.boundAccountId===selected.accountId&&settings.allowedPrivate?.includes(selected.target);}
  async function tick(){
    if(closed)return;if(operation)return operation;
    clearTimer(timer);timer=null;
    operation=(async()=>{
      const selected=config();if(!selected.enabled)return;
      const current=state();current.accounts??={};current.pending??=[];
      try{
        for(const account of mail.getState().accounts){
          if(closed||!config().enabled)break;
          const previous=current.accounts[account.id];
          const result=await mail.sync({accountId:account.id,limit:100,...(previous?{afterUid:previous.uid,uidValidity:previous.validity}:{})});
          if(closed)return;
          const max=Math.max(previous?.validity===result.uidValidity?previous.uid:0,...result.messages.map(item=>item.uid));
          // Initial sync and a changed UIDVALIDITY establish a baseline.
          if(previous?.validity===result.uidValidity)for(const message of result.messages){
            if(message.uid<=previous.uid)continue;
            const id='mailnotice_'+createHash('sha256').update(message.id).digest('hex').slice(0,32);
            if(!current.pending.some(item=>item.id===id))current.pending.push({id,messageId:message.id,accountId:account.id,text:mailNotice(account,message),status:'pending',createdAt:stamp(),destination:{accountId:selected.accountId,target:selected.target}});
          }
          current.accounts[account.id]={validity:result.uidValidity,uid:max};save(current);
        }
        for(const notice of current.pending){
          if(closed||!config().enabled)break;
          if(notice.status!=='pending'||notice.destination.accountId!==selected.accountId||notice.destination.target!==selected.target)continue;
          if(!targetReady(selected)){current.error='新邮件已保存，等待原微信账号和私聊连接恢复后通知。';break;}
          const delivery=await wechat.sendNotification({accountId:selected.accountId,target:selected.target,text:notice.text,requestId:notice.id,beforeSubmit:()=>{const latest=config();if(closed||!latest.enabled||latest.accountId!==selected.accountId||latest.target!==selected.target||!targetReady(selected))throw Error('通知目标或授权已变化。');}});
          notice.status=delivery.status==='delivered'?'delivered':'unconfirmed';notice.deliveryId=delivery.id;notice.updatedAt=stamp();save(current);
          if(notice.status==='unconfirmed')current.error='一条新邮件通知的送达结果待核对，未自动重发。';
        }
        current.lastCheckAt=stamp();if(!current.pending.some(n=>n.status==='pending'||n.status==='unconfirmed'))current.error='';
        const delivered=current.pending.filter(n=>n.status==='delivered').slice(-200);
        current.pending=[...current.pending.filter(n=>n.status!=='delivered'),...delivered];save(current);
      }catch{if(!closed){current.error='自动收信暂未完成，请在邮箱通信中检查账号或网络；稍后会重试。';save(current);}}
    })().finally(()=>{operation=null;if(!closed){timer=setTimer(()=>void tick(),intervalMs);timer?.unref?.();}});
    return operation;
  }
  return {start(){if(!closed&&!timer){timer=setTimer(()=>void tick(),1000);timer?.unref?.();}},tick,getState(){const s=state();return {...config(),lastCheckAt:s.lastCheckAt,error:s.error,pending:s.pending?.filter(n=>n.status==='pending').length??0,unconfirmed:s.pending?.filter(n=>n.status==='unconfirmed').length??0};},async close(){closed=true;clearTimer(timer);await operation;}};
}
