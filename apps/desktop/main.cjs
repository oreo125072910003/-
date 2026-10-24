const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

const projectRoot=path.resolve(__dirname,'../..');
const smoke=process.argv.includes('--smoke-test');
const smokeRoot=smoke?fs.mkdtempSync(path.join(os.tmpdir(),'xiaozhushou-desktop-smoke-')):null;
const dataHomeIndex=process.argv.indexOf('--data-home');
const requestedDataHome=dataHomeIndex>=0?process.argv[dataHomeIndex+1]:undefined;
if(dataHomeIndex>=0&&(!requestedDataHome||!path.isAbsolute(requestedDataHome)))throw Error('数据目录需要绝对路径。');
const dataCandidate=smokeRoot||requestedDataHome||process.env.XIAOZHUSHOU_DATA_HOME||path.join(app.getPath('appData'),'XiaoZhuShou');
fs.mkdirSync(dataCandidate,{recursive:true});
// Pass the physical path across independently installed Windows applications,
// including when the developer shell uses packaged-app AppData redirection.
const dataRoot=fs.realpathSync.native(dataCandidate);
app.setName('小助手');
app.setAppUserModelId('local.xiaozhushou.desktop');
app.setPath('userData',path.join(dataRoot,'desktop'));
let window,service,tray,contractChild,smokeAttachment,smokeWechat,closing=false,quitting=false;
const entry=pathToFileURL(path.join(__dirname,'renderer','index.html')).href;
function contractExecutable(){
  const candidates=app.isPackaged?[path.join(process.resourcesPath,'contract-resource','合同填写小助手.exe')]:[
    path.join(projectRoot,'代码','合同助手','desktop','out','desktop-release','合同填写小助手.exe'),
    path.join(projectRoot,'代码','合同助手','desktop','out','verification-20261025','合同填写小助手.exe')];
  return candidates.find(filename=>fs.existsSync(filename))||null;
}
function wechatSource(){
  const index=process.argv.indexOf('--connect-wechat-source');
  if(index>=0){const source=process.argv[index+1];if(!source||!path.isAbsolute(source))throw Error('微信连接导入需要明确的本机项目绝对路径。');return source;}
  const locations=path.join(projectRoot,'config','wechat-locations.json');
  if(fs.existsSync(locations)&&fs.statSync(locations).size<8192){try{const value=JSON.parse(fs.readFileSync(locations,'utf8')).workspace;if(typeof value==='string'&&path.isAbsolute(value)&&fs.existsSync(value))return value;}catch{}}
  return undefined;
}
function builtinMcp(){
  const desktop=contractExecutable();if(!desktop)return[];
  const command=path.join(path.dirname(desktop),'合同助手MCP.exe');if(!fs.existsSync(command))return[];
  return[{id:'contract-helper',name:'合同助手',version:'2.3.0-preview.0.2.0',source:'bundled-synthetic-contract',transport:'stdio',command,
    args:['--data-dir',path.join(dataRoot,'contract'),'--output-dir',path.join(dataRoot,'contract','成果')],
    allowedTools:['get_contract_schema','preview_contract','generate_contract'],permissions:['contract.read','contract.generate']}];
}

function secretStore(){
  return require('./secret-store.cjs').createSecretStore({dataDir:dataRoot,safeStorage});
}
function legacySources(){if(smoke)return[];const source=wechatSource();return[...(source?[{id:'wechatagent',name:'原有 WeChatAgent',kind:'wechatagent',path:source}]:[]),{id:'personal-skills',name:'原有个人技能',kind:'skills',path:path.join(os.homedir(),'.codex','skills')},{id:'agents-skills',name:'共享工作技能',kind:'skills',path:path.join(os.homedir(),'.agents','skills')},{id:'dsh-profile',name:'原有 Harness 插件',kind:'dsh-profile',path:path.join(os.homedir(),'.dsh','profiles','desktop')}];}
function trusted(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===entry;}
function bringForward(){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}}
async function quit(){
  if(closing)return;closing=true;
  try{await service?.close();quitting=true;app.quit();}
  catch(error){closing=false;dialog.showErrorBox('尚未退出',String(error.message));bringForward();}
}
async function registerIPC(){
  for(const name of ['getBootstrap','listTasks','getTask','createTask','cancelTask','getSettings','saveSettings','getWorkflowsState','exportTaskDocument',
    'getWechatState','saveWechatSettings','connectWechat','disconnectWechat','draftWechatReply','sendWechatReply','searchWechatContacts','refreshWechatProfile','getWechatSessions','getWechatHistory','resolveWechatImage','getWechatStickers','sendWechatMessage','sendWechatSticker',
    'importLegacyExtensions','refreshDshCatalog',
    'getMailState','importMailAccounts','syncMail','getMailMessage','createMailDraft','sendMailDraft','resolveMailAttachment','draftMailReply',
    'getDshAccessState','refreshDshAccessCatalog','saveDshOwnerGrants',
    'getExtensionsState','installBuiltinMcp','enableMcp','disableMcp','testMcp','setMcpTools','importBundledSkill','enableSkill','disableSkill']){
    ipcMain.handle('assistant:'+name,async(event,...args)=>{if(!trusted(event))throw Error('此窗口无权访问小助手。');return service[name](...args);});
  }
  ipcMain.handle('assistant:importMailAccountsFile',async event=>{
    if(!trusted(event))throw Error('此窗口无权导入邮箱。');
    const result=await dialog.showOpenDialog(window,{title:'导入邮箱账号配置 JSON',properties:['openFile'],filters:[{name:'邮箱账号配置',extensions:['json']}]});
    if(result.canceled)return null;
    const filename=result.filePaths[0],stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('请选择 64 KB 以内的普通 JSON 账号配置文件。');
    return service.importMailAccounts(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));
  });
  ipcMain.handle('assistant:saveMailAttachment',async(event,value)=>{
    if(!trusted(event))throw Error('此窗口无权保存邮件附件。');
    const item=service.resolveMailAttachment(value);
    const filename=item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,180)||'附件';
    const result=await dialog.showSaveDialog(window,{title:'另存邮件附件',defaultPath:path.join(app.getPath('downloads'),filename),buttonLabel:'保存附件'});
    if(result.canceled)return null;
    const content=fs.readFileSync(item.path);
    if(content.length!==item.size||createHash('sha256').update(content).digest('hex')!==item.sha256)throw Error('附件在保存前发生变化，请重新读取。');
    fs.writeFileSync(result.filePath,content);
    return{saved:true,path:result.filePath,name:path.basename(result.filePath),size:content.length};
  });
  ipcMain.handle('assistant:importMcpManifest',async event=>{
    if(!trusted(event))throw Error('此窗口无权安装插件。');
    const selected=await dialog.showOpenDialog(window,{title:'导入已安装 MCP 插件的 JSON 配置',properties:['openFile'],filters:[{name:'MCP 插件配置',extensions:['json']}]});
    if(selected.canceled)return null;
    const filename=selected.filePaths[0],stat=fs.lstatSync(filename);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('插件配置必须是 64 KB 以内的普通 JSON 文件。');
    let config;try{config=JSON.parse(fs.readFileSync(filename,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('插件配置不是有效的 JSON。');}
    return service.installMcp(config);
  });
  ipcMain.handle('assistant:importSkill',async event=>{
    if(!trusted(event))throw Error('此窗口无权导入技能。');
    const selected=await dialog.showOpenDialog(window,{title:'选择包含 SKILL.md 的技能文件夹',properties:['openDirectory']});
    if(selected.canceled)return null;
    return service.importSkill(selected.filePaths[0]);
  });
  ipcMain.handle('assistant:importWechatConnection',async event=>{
    if(!trusted(event))throw Error('此窗口无权导入微信连接。');
    if(smoke&&smokeWechat)return service.importWechatConnection(smokeWechat.source);
    const result=await dialog.showOpenDialog(window,{title:'选择现有微信项目文件夹（包含 config 和 state）',defaultPath:wechatSource(),properties:['openDirectory'],buttonLabel:'导入连接'});
    if(result.canceled)return null;
    return service.importWechatConnection(result.filePaths[0]);
  });
  ipcMain.handle('assistant:pickAttachments',async event=>{
    if(!trusted(event))throw Error('此窗口无权选择资料。');
    if(smoke&&smokeAttachment){service.grantAttachments([smokeAttachment]);return[{name:path.basename(smokeAttachment),path:smokeAttachment,size:fs.statSync(smokeAttachment).size}];}
    const result=await dialog.showOpenDialog(window,{title:'添加任务资料',properties:['openFile','multiSelections'],buttonLabel:'添加资料'});
    if(result.canceled)return[];
    if(result.filePaths.length>20)throw Error('每次最多添加 20 份资料。');
    const selected=result.filePaths.map(filename=>{const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('只支持 16 MB 以内的普通文件。');return{name:path.basename(filename),path:filename,size:stat.size};});
    service.grantAttachments(selected.map(item=>item.path));return selected;
  });
  ipcMain.handle('assistant:openArtifact',async(event,id)=>{if(!trusted(event))throw Error('此窗口无权打开成果。');const filename=service.resolveArtifact(id);const message=await shell.openPath(filename);if(message)throw Error(message);return{opened:true};});
  ipcMain.handle('assistant:openWorkspace',async(event,id)=>{if(!trusted(event))throw Error('此窗口无权打开工作目录。');const filename=service.resolveWorkspace(id);const message=await shell.openPath(filename);if(message)throw Error(message);return{opened:true};});
  ipcMain.handle('assistant:openContract',async event=>{
    if(!trusted(event))throw Error('此窗口无权启动合同工具。');
    const filename=contractExecutable();if(!filename)throw Error('当前版本没有找到合同工具。');
    if(contractChild&&contractChild.exitCode===null)throw Error('合同工具已经打开，请在任务栏中查看。');
    const contractData=path.join(dataRoot,'contract');fs.mkdirSync(contractData,{recursive:true});
    await new Promise((resolve,reject)=>{const child=spawn(filename,['--data-dir',contractData],{cwd:path.dirname(filename),stdio:'ignore',windowsHide:false});contractChild=child;child.once('spawn',resolve);child.once('error',reject);child.once('close',()=>{if(contractChild===child)contractChild=null;});});
    return{opened:true};
  });
}
async function smokeTest(){
  const artifactsDir=process.env.XIAOZHUSHOU_SMOKE_OUTPUT||path.join(projectRoot,'dist','smoke');
  fs.mkdirSync(artifactsDir,{recursive:true});
  const failures=[];window.webContents.on('console-message',details=>{if(details.level==='error')failures.push(details.message);});
  const source=path.join(smokeRoot,'示例资料.txt');fs.writeFileSync(source,'这是用于桌面验收的合成资料。\n数量：3\n状态：待核对\n');
  smokeAttachment=source;
  const uiDeadline=Date.now()+10000;
  while(!await window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-kind="organize"]'))`)){if(Date.now()>uiDeadline)throw Error('工作台未加载。');await new Promise(r=>setTimeout(r,50));}
  await window.webContents.executeJavaScript(`document.querySelector('[data-kind="organize"]').click()`);
  while(!await window.webContents.executeJavaScript(`document.querySelector('#attachments')?.textContent.includes('示例资料.txt')`)){if(Date.now()>uiDeadline)throw Error('界面未能添加资料。');await new Promise(r=>setTimeout(r,50));}
  await window.webContents.executeJavaScript(`const input=document.querySelector('#task-prompt');input.value='整理这份合成资料，生成目录和校验记录';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#task-form').requestSubmit();`);
  while(!service.listTasks().length){if(Date.now()>uiDeadline)throw Error('界面提交任务失败。');await new Promise(r=>setTimeout(r,50));}
  const task=service.listTasks()[0];
  let detail;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){detail=service.getTask(task.id);if(['succeeded','failed'].includes(detail.task.status))break;await new Promise(resolve=>setTimeout(resolve,80));}
  if(detail.task.status!=='succeeded'||detail.artifacts.length!==2)throw Error('本地任务与成果闭环验收失败。');
  const isolation=await window.webContents.executeJavaScript(`({node:typeof require,api:typeof window.assistant?.createTask,text:document.body.innerText,errors:window.__desktopErrors||[]})`);
  if(isolation.node!=='undefined'||isolation.api!=='function'||!isolation.text.includes('小助手'))throw Error('桌面隔离或界面加载失败。');
  const bootstrap=await service.getBootstrap();
  const localRuntime=path.join(projectRoot,'config','runtime-locations.json');
  if(fs.existsSync(localRuntime)){
    const declared=JSON.parse(fs.readFileSync(localRuntime,'utf8')).harnessCommand;
    if(declared&&fs.existsSync(declared)&&bootstrap.runtime.source!=='existing-harness-host')throw Error('默认运行方式未使用现有 DSH 宿主。');
  }
  await new Promise(resolve=>setTimeout(resolve,800));
  const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(artifactsDir,'desktop-home.png'),screenshot.toPNG());
  // Ask the actual renderer to open the persisted task, so the detail view is exercised as well.
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="open-task"]')?.click()`);
  await new Promise(resolve=>setTimeout(resolve,500));
  fs.writeFileSync(path.join(artifactsDir,'desktop-task.png'),(await window.webContents.capturePage()).toPNG());
  // The real renderer, IPC, service, reused WeChat transport, and local socket
  // backend are exercised together. No real WeChat account is contacted here.
  smokeWechat=await require('./smoke-wechat.cjs').createWechatSmoke(smokeRoot);
  const waitFor=async(predicate,label)=>{const until=Date.now()+15000;while(!await predicate()){if(Date.now()>until)throw Error(label);await new Promise(resolve=>setTimeout(resolve,50));}};
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="close-task"]')?.click();document.querySelector('[data-page="wechat"]')?.click();`);
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="wechat-import"]'))`),'微信页未加载');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="wechat-import"]').click()`);
  await waitFor(async()=>(await service.getWechatState()).settings.connectionImported,'微信连接导入失败');
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="wechat-connect"]:not(:disabled)'))`),'微信连接按钮不可用');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="wechat-connect"]').click()`);
  await waitFor(async()=>(await service.getWechatState()).connection.state==='ready','微信连接未就绪');
  await waitFor(async()=>(await service.getWechatState()).profile.nickname==='离线验收登录用户','微信真实资料回退或登录用户名称未显示');
  await waitFor(()=>window.webContents.executeJavaScript(`document.body.innerText.includes('离线验收登录用户')`),'界面未显示已登录微信用户名称');
  smokeWechat.emit();
  await waitFor(async()=>(await service.getWechatState()).messages.length===1,'微信接收或去重失败');
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="wechat-select"], [data-action="wechat-target"]'))`),'微信消息未展示');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="wechat-select"], [data-action="wechat-target"]').click()`);
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('#wechat-reply'))`),'微信回复表单未加载');
  await window.webContents.executeJavaScript(`const reply=document.querySelector('#wechat-reply');reply.value='合成验收：材料已收到。';reply.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#wechat-reply-form').requestSubmit();`);
  await waitFor(async()=>(await service.getWechatState()).outbox[0]?.status==='delivered','微信离线发送回执未验证');
  if(smokeWechat.sends!==1)throw Error('微信发送次数异常');
  await new Promise(resolve=>setTimeout(resolve,500));
  fs.writeFileSync(path.join(artifactsDir,'desktop-wechat.png'),(await window.webContents.capturePage()).toPNG());
  await service.disconnectWechat();await smokeWechat.close();
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="capabilities"]').click();document.querySelector('[data-action="capability-tab"][data-tab="skills"]').click();`);
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="skill-import-bundled"][data-id="material-writing"]'))`),'内置技能列表未显示');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="skill-import-bundled"][data-id="material-writing"]').click()`);
  await waitFor(()=>service.getExtensionsState().skills.some(skill=>skill.id==='material-writing'),'内置技能导入失败');
  await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="skill-enable"][data-id="material-writing"]:not(:disabled)'))`),'内置技能启用按钮未显示');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="skill-enable"][data-id="material-writing"]').click()`);
  await waitFor(()=>service.getExtensionsState().skills.some(skill=>skill.id==='material-writing'&&skill.usable),'内置技能未启用');
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="capability-tab"][data-tab="mcp"]').click()`);
  if(builtinMcp().length){
    await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="mcp-install-builtin"]:not(:disabled)'))`),'合同插件安装按钮未显示');
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="mcp-install-builtin"]').click()`);
    await waitFor(()=>service.getExtensionsState().mcp.some(plugin=>plugin.id==='contract-helper'),'合同插件未安装');
    await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="mcp-enable"][data-id="contract-helper"]:not(:disabled)'))`),'合同插件启用按钮未显示');
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="mcp-enable"][data-id="contract-helper"]').click()`);
    await waitFor(()=>service.getExtensionsState().mcp.some(plugin=>plugin.id==='contract-helper'&&plugin.enabled),'合同插件未启用');
    await waitFor(()=>window.webContents.executeJavaScript(`Boolean(document.querySelector('[data-action="mcp-test"][data-id="contract-helper"]:not(:disabled)'))`),'合同插件检测按钮未显示');
    await window.webContents.executeJavaScript(`document.querySelector('[data-action="mcp-test"][data-id="contract-helper"]').click()`);
    await waitFor(()=>service.getExtensionsState().mcp.find(plugin=>plugin.id==='contract-helper')?.lastDiagnostic?.ok,'合同插件未通过MCP握手');
  }
  await new Promise(resolve=>setTimeout(resolve,400));
  fs.writeFileSync(path.join(artifactsDir,'desktop-extensions.png'),(await window.webContents.capturePage()).toPNG());
  const extensionUiReport=await require('./smoke-extensions.cjs').verifyExtensionsUI({window,service,waitFor,artifactsDir});
  const mailUiReport=await require('./smoke-mail.cjs').verifyMailUI({window,service,waitFor,artifactsDir});
  await window.webContents.executeJavaScript(`document.querySelector('[data-page="home"]')?.click()`);
  fs.writeFileSync(path.join(artifactsDir,'desktop-home.png'),(await window.webContents.capturePage()).toPNG());
  await window.setSize(920,760);
  await new Promise(resolve=>setTimeout(resolve,300));
  const overflow=await window.webContents.executeJavaScript(`document.documentElement.scrollWidth>window.innerWidth`);
  if(overflow)throw Error('窄窗口存在横向溢出');
  fs.writeFileSync(path.join(artifactsDir,'desktop-narrow.png'),(await window.webContents.capturePage()).toPNG());
  const fixtureKey='sk-smoke-only-not-a-real-account';
  await service.saveSettings({runtimeApiKey:fixtureKey});
  if(await secretStore().get('deepseek-api-key')!==fixtureKey)throw Error('凭据解密内容不一致');
  const exposed=await service.getSettings();const encrypted=fs.readFileSync(path.join(dataRoot,'secrets.protected.json'),'utf8');
  if(encrypted.includes(fixtureKey)||exposed.runtimeApiKey!==undefined||!exposed.runtimeCredentialConfigured)throw Error('Windows 凭据保护验收失败。');
  await service.saveSettings({clearRuntimeApiKey:true});
  await service.close();
  const {createAssistantService}=await import(pathToFileURL(path.join(projectRoot,'apps/service/index.mjs')).href);
  const runtime=await import(pathToFileURL(path.join(projectRoot,'packages/runtime-harness/index.mjs')).href);
  service=await createAssistantService({dataDir:dataRoot,runtime,secretStore:secretStore(),contractAvailable:!!contractExecutable(),builtinMcp:builtinMcp(),legacySources:legacySources()});
  const restored=service.getTask(task.id);
  if(restored.task.status!=='succeeded'||restored.artifacts.length!==2)throw Error('重新打开数据后任务或成果丢失。');
  const report={ok:true,version:app.getVersion(),dataDir:smokeRoot,taskId:task.id,status:detail.task.status,artifactCount:detail.artifacts.length,
    rendererNodeAccess:isolation.node,preloadAPI:isolation.api,windowsSecretProtection:true,reopenPreserved:true,rendererSubmitExercised:true,
    runtimeDetected:bootstrap.runtime.available,runtimeVersion:bootstrap.runtime.version,contractAvailable:!!contractExecutable(),wechatRendererFlow:true,wechatProfileNameShown:true,wechatSyntheticSends:smokeWechat.sends,extensionsRendererFlow:true,
    ...extensionUiReport,...mailUiReport,consoleErrors:failures,capturedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(artifactsDir,'desktop-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));await service.close();quitting=true;app.exit(failures.length?1:0);
}
async function start(){
  Menu.setApplicationMenu(null);
  const runtime=await import(pathToFileURL(path.join(projectRoot,'packages/runtime-harness/index.mjs')).href);
  const {createAssistantService}=await import(pathToFileURL(path.join(projectRoot,'apps/service/index.mjs')).href);
  service=await createAssistantService({dataDir:dataRoot,runtime,secretStore:secretStore(),contractAvailable:!!contractExecutable(),builtinMcp:builtinMcp(),legacySources:legacySources()});
  const importIndex=process.argv.indexOf('--connect-wechat-source');
  if(!smoke&&importIndex>=0){try{await service.importWechatConnection(wechatSource());await service.connectWechat();}catch{ /* The WeChat page retains its error; the desktop remains usable. */ }}
  await registerIPC();
  window=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:650,title:'小助手',backgroundColor:'#f8f7f2',show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false,devTools:!app.isPackaged}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==entry)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.webContents.session.setPermissionCheckHandler(()=>false);
  service.onChange(()=>{if(window&&!window.isDestroyed())window.webContents.send('assistant:change');});
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  await window.loadURL(entry);
  window.show();
  const bitmap=Buffer.alloc(32*32*4);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){const i=(y*32+x)*4;const dx=x-15.5,dy=y-15.5;if(dx*dx+dy*dy<225){const white=Math.abs(dx)*0.65+Math.abs(dy)<7||Math.abs(dx)+Math.abs(dy)*0.65<7;bitmap[i]=white?235:68;bitmap[i+1]=white?246:93;bitmap[i+2]=white?248:30;bitmap[i+3]=255;}}
  const image=nativeImage.createFromBitmap(bitmap,{width:32,height:32,scaleFactor:1});
  if(!image.isEmpty()){
    tray=new Tray(image);tray.setToolTip('小助手 · 你的个人助手');
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开小助手',click:bringForward},{label:'打开工作目录',click:()=>shell.openPath(service.resolveWorkspace())},{type:'separator'},{label:'退出小助手',click:quit}]));
    tray.on('double-click',bringForward);
  }
  if(smoke)await smokeTest();
}
if(!app.requestSingleInstanceLock()){app.quit();}
else{
  app.on('second-instance',(_event,argv)=>{if(argv.includes('--quit'))void quit();else bringForward();});app.on('activate',bringForward);
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void quit();}});
  app.whenReady().then(start).catch(error=>{console.error(String(error.stack||error));if(smoke){app.exit(1);}else{dialog.showErrorBox('小助手启动失败',String(error.message));quitting=true;app.quit();}});
}
