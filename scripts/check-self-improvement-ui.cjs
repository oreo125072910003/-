// Hidden renderer QA with synthetic IPC. No live account or messages are used.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),output=path.join(root,'dist/self-improvement-ui'),isolated=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-improvement-ui-'));
app.setPath('userData',isolated);
const improvement={config:{enabled:false},memories:{},proposals:[{id:'abcdef123456',operation:'memory.set',target:'reply-style',reason:'保留主人纠正后的答复偏好',payload:{text:'日常闲聊简洁自然。<script>throw new Error("untrusted")</script>'},before:null,createdAt:new Date().toISOString(),status:'pending',notification:'delivered'}]};
let writes=0;
const mock={getBootstrap:()=>({identity:{name:'小助手'},runtime:{available:false},capabilities:[]}),listTasks:()=>[],getSettings:()=>({}),getWechatState:()=>({settings:{allowedPrivate:['101']},connection:{state:'ready'},allowedContacts:[{id:'101',kind:'private',name:'合成审批联系人'}],messages:[]}),getExtensionsState:()=>({skills:[],mcp:[],bundledSkills:[],selfImprovement:improvement}),getWorkflowsState:()=>({workflows:[]}),getDshAccessState:()=>null,getMailState:()=>({accounts:[],messages:[],drafts:[]}),configureSelfImprovement:value=>{writes++;improvement.config={enabled:value.enabled,target:value.target,ownerName:value.ownerName};return improvement;}};
app.whenReady().then(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const methods=vm.runInNewContext(fs.readFileSync(path.join(root,'apps/desktop/preload.cjs'),'utf8').match(/const methods = (\[[\s\S]+?\]);/)[1]);
 for(const method of methods)ipcMain.handle('assistant:'+method,(_event,...args)=>{if(!mock[method])throw Error('Unexpected QA call: '+method);return mock[method](...args);});
 const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{preload:path.join(root,'apps/desktop/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}}),errors=[];
 window.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
 const evaluate=source=>window.webContents.executeJavaScript(source);
 const wait=async source=>{const end=Date.now()+5000;while(Date.now()<end){if(await evaluate(source))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('UI timeout: '+source);};
 try{
  await window.loadFile(path.join(root,'apps/desktop/renderer/index.html'));await wait('Boolean(document.querySelector("[data-page=capabilities]"))');
  await evaluate('document.querySelector("[data-page=capabilities]").click();document.querySelector("[data-tab=improvement]").click()');
  await wait('Boolean(document.querySelector("#improvement-owner"))');
  assert.match(await evaluate('document.querySelector("#improvement-owner").textContent'),/合成审批联系人/);
  await evaluate('document.querySelector("[data-action=improvement-toggle]").click()');await wait('document.querySelector("[data-action=improvement-toggle]").textContent.includes("关闭")');
  assert.equal(writes,1);assert.equal(improvement.config.ownerName,'合成审批联系人');
  await evaluate('document.querySelector("#capability-panel details").open=true');
  assert.equal(await evaluate('document.querySelectorAll("#capability-panel script").length'),0);
  assert.equal(await evaluate('Boolean(document.querySelector("[data-action=improvement-approve]"))'),false);
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  fs.writeFileSync(path.join(output,'self-improvement.png'),(await window.webContents.capturePage()).toPNG());
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,ownerSelection:true,configurationSaved:true,wechatOnlyApproval:true,escapedContent:true,consoleErrors:errors},null,2));
  console.log(JSON.stringify({ok:true,output}));
 }finally{window.destroy();app.quit();}
}).catch(error=>{console.error(error.stack);app.exit(1);});
