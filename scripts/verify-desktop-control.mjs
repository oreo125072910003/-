import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildDesktopHelper} from '../packages/desktop-control/build.mjs';
import {createDesktopController} from '../packages/desktop-control/index.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),output=path.join(root,'dist/desktop-control-verification');fs.mkdirSync(output,{recursive:true});
buildDesktopHelper();
const exe=path.join(output,'native-control-fixture.exe'),compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const built=spawnSync(compiler,['/nologo','/target:winexe','/out:'+exe,'/r:System.Drawing.dll','/r:System.Windows.Forms.dll',path.join(root,'tests/fixtures/desktop-control-form.cs')],{encoding:'utf8',windowsHide:true});
if(built.status!==0)throw Error(built.stdout+built.stderr);
const child=spawn(exe,[],{windowsHide:false,stdio:'ignore'}),desktop=createDesktopController(),options={authorize:async()=>true};
try{
 let selected;for(let n=0;n<30;n++){const {windows}=await desktop.execute({action:'windows'},options);selected=windows.find(w=>w.title==='小助手客户端控制验证');if(selected)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(selected,'test fixture window must appear');
 let state=await desktop.execute({action:'observe',windowId:selected.windowId},options);
 const point=name=>{const e=state.elements.find(e=>e.name===name);assert.ok(e,'fixture element '+name);return {x:e.x+Math.round(e.width/2),y:e.y+Math.round(e.height/2)};};
 state=await desktop.execute({action:'click',snapshotId:state.snapshotId,...point('验证输入框')},options);
 state=await desktop.execute({action:'type',snapshotId:state.snapshotId,text:'xzs-native-check'},options);
 state=await desktop.execute({action:'key',snapshotId:state.snapshotId,key:'Tab'},options);
 state=await desktop.execute({action:'click',snapshotId:state.snapshotId,...point('验证按钮')},options);
 assert.ok(state.elements.some(e=>e.name==='已点击：xzs-native-check'));
 fs.writeFileSync(path.join(output,'verified.jpg'),Buffer.from(state.image,'base64'));
 const report={ok:true,realWindowsFixture:true,listed:true,screenshot:true,accessibility:true,click:true,unicodeTyping:true,keyboard:true,imageBytes:Buffer.from(state.image,'base64').length,credentialsUsed:false};
 fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{desktop.close();child.kill();}
