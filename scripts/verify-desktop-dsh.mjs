import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createDesktopController} from '../packages/desktop-control/index.mjs';
import {createTaskToolAccess} from '../apps/service/task-tools.mjs';
import {runHostedTask} from '../packages/runtime-harness/hosted.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),{dataHome}=JSON.parse(fs.readFileSync(path.join(root,'config/desktop-install.local.json'),'utf8'));
const workspace=path.join(dataHome,'tasks','task_'+randomUUID());fs.mkdirSync(workspace,{recursive:true});
const child=spawn(path.join(root,'dist/desktop-control-verification/native-control-fixture.exe'),[],{windowsHide:false,stdio:'ignore'}),controller=new AbortController();
const native=createDesktopController();let last,calls=0;
const desktop={async execute(args,options){calls++;last=await native.execute(args,options);return last;},close(){native.close();}};
const access=await createTaskToolAccess({task:{id:'task_'+randomUUID(),workspace},tools:['xiaozhushou_desktop'],signal:controller.signal,authorize:async()=>true,addArtifact(){throw Error('This UI test creates no user artifact');},resolveArtifact(){throw Error('No user artifacts');},onDelivery(){throw Error('This test cannot send messages');},desktop});
try{
 const result=await runHostedTask({prompt:'这是单独的 Windows 客户端验收。仅操作标题为“小助手客户端控制验证”的独立测试窗口。先使用 xiaozhushou_desktop 的 windows，再 observe。查看截图与控件，点击“验证输入框”，输入“原生联调成功”，再点击“验证按钮”。检查返回截图出现“已点击：原生联调成功”后，简短报告实际观察结果。必须实际调用工具。不能操作其他窗口，不发消息，不访问用户文件。',workspace,signal:controller.signal,settings:{hostedConfigFile:path.join(dataHome,'harness-host/client.json'),hostedOwnerGrants:{skills:[],tools:['xiaozhushou_desktop']},hostedExecutionPolicy:'trusted-desktop-computer-task-v1',hostedProductConnection:access.connection,hostedTaskTimeoutMs:180000},onEvent:({type,message})=>{if(type==='status')console.log(message);}});
 const output=path.join(root,'dist/desktop-dsh-verification');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:result.ok,calls,finalText:result.finalText,error:result.error,sessionId:result.sessionId},null,2));
 assert.equal(result.ok,true,JSON.stringify(result.error));assert.ok(calls>=4);assert.ok(last?.elements?.some(e=>e.name==='已点击：原生联调成功'),'actual native UI label must confirm the completed input');
 if(last.image)fs.writeFileSync(path.join(output,'verified.jpg'),Buffer.from(last.image,'base64'));
 console.log(JSON.stringify({ok:true,realDshModel:true,nativeToolCalls:calls,actualUiConfirmed:true,nativeImageResults:true,sessionSaved:result.ok,privateMessagesSent:0}));
}finally{await access.close();child.kill();}
