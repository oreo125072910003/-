import test from 'node:test';
import assert from 'node:assert/strict';
import {createMailMonitor} from '../apps/service/mail-monitor.mjs';
function fixture(){
 let settings={mailNotifications:{enabled:true,accountId:'111',target:'222'}},uid=1,validity='11',online=true,unknown=false;
 const sent=[],requests=[],account={id:'account_fixture',name:'Fixture'},messages=()=>Array.from({length:uid},(_,n)=>({id:'mail_'+n,uid:n+1,subject:'Subject '+(n+1),text:'Untrusted mail content',from:[{name:'Sender'}]}));
 const store={getSettings:()=>structuredClone(settings),saveSettings:patch=>{settings={...settings,...structuredClone(patch)};}};
 const mail={getState:()=>({accounts:[account]}),sync:async args=>{requests.push(args);return {uidValidity:validity,messages:messages().filter(m=>!args.afterUid||m.uid>args.afterUid)};}};
 const wechat={getState:()=>({settings:{boundAccountId:'111',allowedPrivate:['222']},connection:{state:online?'ready':'offline',accountVerified:true,selfId:'111'}}),sendNotification:async value=>{value.beforeSubmit();sent.push(value);return {id:'delivery_fixture',status:unknown?'unconfirmed':'delivered'};}};
 const make=()=>createMailMonitor({store,mail,wechat,setTimer:()=>({unref(){}}),clearTimer(){}});
 return {make,sent,requests,store,newMail(){uid++;},offline(){online=false;},online(){online=true;},unknown(){unknown=true;},changeMailbox(){validity='12';uid=1;},changeAccount(){settings.mailNotifications.accountId='999';}};
}
test('baseline is quiet; new mail is sent once to the selected private chat across restart',async()=>{
 const f=fixture();let monitor=f.make();await monitor.tick();assert.equal(f.sent.length,0);
 f.newMail();await monitor.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].target,'222');assert.match(f.sent[0].text,/Subject 2/);
 assert.equal(f.requests.at(-1).afterUid,1);await monitor.close();monitor=f.make();await monitor.tick();assert.equal(f.sent.length,1);await monitor.close();
});
test('offline notices persist and resume; ambiguous delivery is never resubmitted',async()=>{
 const f=fixture(),m=f.make();await m.tick();f.offline();f.newMail();await m.tick();assert.equal(m.getState().pending,1);assert.equal(f.sent.length,0);
 f.online();f.unknown();await m.tick();assert.equal(f.sent.length,1);assert.equal(m.getState().unconfirmed,1);await m.tick();assert.equal(f.sent.length,1);await m.close();
});
test('a changed mailbox generation establishes a baseline and account changes cannot redirect pending mail',async()=>{
 const f=fixture(),m=f.make();await m.tick();f.changeMailbox();await m.tick();assert.equal(f.sent.length,0);
 f.offline();f.newMail();await m.tick();f.changeAccount();f.online();await m.tick();assert.equal(f.sent.length,0);await m.close();
});
