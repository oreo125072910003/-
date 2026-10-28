import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStore} from '../packages/storage/index.mjs';
// Run only after the old desktop has gracefully released its single-writer lock.
// The user authorized the current original WeChat private chat, never every chat.
const root=fileURLToPath(new URL('../',import.meta.url));
const {dataHome}=JSON.parse(fs.readFileSync(path.join(root,'config/desktop-install.local.json'),'utf8'));
const backup=path.join(dataHome,'backups','before-mail-notifications-'+Date.now());fs.mkdirSync(backup,{recursive:true});
const store=await createStore(path.join(dataHome,'db'));
try{
  fs.copyFileSync(path.join(dataHome,'db/assistant.sqlite'),path.join(backup,'assistant.sqlite'));
  const settings=store.getSettings(),wechat=settings.wechatConnection??{};
  const latest=store.listTasks().filter(task=>task.conversationId).map(task=>store.getConversation(task.conversationId)).find(c=>c?.channel==='wechat'&&c.kind==='private'&&c.accountId===wechat.boundAccountId&&wechat.allowedPrivate?.includes(c.target));
  if(!latest)throw Error('没有唯一可核验的最近微信私聊，未变更授权。');
  const registry=structuredClone(settings.dshWechatGrants),key=`${latest.accountId}:private:${latest.target}`,entry=registry?.chats?.[key];
  if(!entry?.computerAccess?.enabled)throw Error('最近私聊的电脑控制尚未启用，未扩大授权。');
  entry.grants.tools=[...new Set([...entry.grants.tools,'xiaozhushou_mail','xiaozhushou_desktop'])];
  entry.computerAccess.tools=[...new Set([...entry.computerAccess.tools,'xiaozhushou_desktop'])];
  entry.updatedAt=new Date().toISOString();entry.source='owner-approved-desktop-control-and-mail-notifications';
  if(!store.listMailAccounts().length)throw Error('尚未配置邮箱。');
  store.saveSettings({dshWechatGrants:registry,mailNotifications:{enabled:true,accountId:latest.accountId,target:latest.target,enabledAt:new Date().toISOString()}});
  console.log(JSON.stringify({configured:true,privateChatsChanged:1,mailAccounts:store.listMailAccounts().length,computerAccess:true,mailTool:true,notifications:'original-private-chat',backup}));
}finally{store.close();}
