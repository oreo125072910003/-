import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopController,desktopKeys} from '../packages/desktop-control/index.mjs';
const window={handle:'123',pid:44,started:'900',title:'Fixture',process:'fixture'};
function fixture(){let at=100;const calls=[];let permitted=true;
 const controller=createDesktopController({now:()=>at,run:async request=>{calls.push(request);return request.operation==='list'?{windows:[window]}:{window,rect:[100,200,800,600],origin:[100,200],width:400,height:300,scale:.5,image:'fixture',mime:'image/jpeg',elements:[{x:100,y:40,width:20,height:20,name:'Fixture'}]};}});
 const execute=args=>controller.execute(args,{authorize:async()=>permitted});
 return {controller,calls,execute,expire(){at+=60001;},revoke(){permitted=false;}};
}
test('client windows must be selected from returned identities; each action consumes its observation',async()=>{
 const f=fixture();await assert.rejects(f.execute({action:'observe',windowId:'invented'}),/先列出/);
 const {windows}=await f.execute({action:'windows'}),state=await f.execute({action:'observe',windowId:windows[0].windowId});
 assert.equal(state.elements[0].x,50);const next=await f.execute({action:'click',snapshotId:state.snapshotId,x:50,y:20});
 assert.equal(f.calls.at(-1).screenX,200);assert.equal(f.calls.at(-1).screenY,240);
 await assert.rejects(f.execute({action:'click',snapshotId:state.snapshotId,x:50,y:20}),/过期或已使用/);
 await f.execute({action:'type',snapshotId:next.snapshotId,text:'Fixture input'});f.controller.close();await assert.rejects(f.execute({action:'windows'}),/撤销/);
});
test('expired or revoked observations cannot inject input and coordinates stay inside the screenshot',async()=>{
 const f=fixture(),{windows}=await f.execute({action:'windows'});let state=await f.execute({action:'observe',windowId:windows[0].windowId});
 await assert.rejects(f.execute({action:'click',snapshotId:state.snapshotId,x:401,y:20}),/坐标/);
 state=await f.execute({action:'observe',windowId:windows[0].windowId});f.expire();await assert.rejects(f.execute({action:'key',snapshotId:state.snapshotId,key:'Enter'}),/过期/);
 f.revoke();await assert.rejects(f.execute({action:'windows'}),/撤销/);assert.equal(f.calls.some(x=>x.operation==='click'||x.operation==='key'),false);
});
test('keyboard supports ordinary navigation but rejects system switches and unknown aliases',()=>{
 assert.deepEqual(desktopKeys('Ctrl+A'),[17,65]);assert.deepEqual(desktopKeys('Shift+Tab'),[16,9]);
 for(const key of ['Win+R','Meta+R','Alt+Tab','Ctrl+Alt+Delete','Ctrl+Ctrl+A','NoSuchKey'])assert.throws(()=>desktopKeys(key));
});
