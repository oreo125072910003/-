const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const projectRoot=path.resolve(__dirname,'../..');
const smoke=process.argv.includes('--smoke-test');
const smokeRoot=smoke?fs.mkdtempSync(path.join(os.tmpdir(),'xiaozhushou-desktop-smoke-')):null;
const dataRoot=smokeRoot||process.env.XIAOZHUSHOU_DATA_HOME||path.join(app.getPath('appData'),'XiaoZhuShou');
fs.mkdirSync(dataRoot,{recursive:true});
app.setName('小助手');
app.setAppUserModelId('local.xiaozhushou.desktop');
app.setPath('userData',path.join(dataRoot,'desktop'));
let window,service,tray,contractChild,smokeAttachment,closing=false,quitting=false;
const entry=pathToFileURL(path.join(__dirname,'renderer','index.html')).href;
function contractExecutable(){
  const candidates=app.isPackaged?[path.join(process.resourcesPath,'contract-resource','合同填写小助手.exe')]:[
    path.join(projectRoot,'代码','合同助手','desktop','out','desktop-release','合同填写小助手.exe'),
    path.join(projectRoot,'代码','合同助手','desktop','out','verification-20261025','合同填写小助手.exe')];
  return candidates.find(filename=>fs.existsSync(filename))||null;
}

function secretStore(){
  const filename=path.join(dataRoot,'secrets.protected.json');
  let pending=Promise.resolve();
  const read=()=>{if(!fs.existsSync(filename))return{};if(fs.statSync(filename).size>65536)throw Error('凭据文件异常，请检查数据目录。');return JSON.parse(fs.readFileSync(filename,'utf8'));};
  async function available(){return typeof safeStorage.isAsyncEncryptionAvailable==='function'?await safeStorage.isAsyncEncryptionAvailable():safeStorage.isEncryptionAvailable();}
  function save(data){const temp=filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{encoding:'utf8',mode:0o600});fs.renameSync(temp,filename);}
  const serialize=fn=>{const operation=pending.then(fn);pending=operation.catch(()=>{});return operation;};
  return{
    get: name=>serialize(async()=>{const value=read()[name];if(!value)return null;if(!await available())throw Error('Windows 凭据保护暂不可用，密钥没有解密。');return typeof safeStorage.decryptStringAsync==='function'?await safeStorage.decryptStringAsync(Buffer.from(value,'base64')):safeStorage.decryptString(Buffer.from(value,'base64'));}),
    set:(name,value)=>serialize(async()=>{if(!await available())throw Error('系统凭据保护不可用，未保存密钥。');const bytes=typeof safeStorage.encryptStringAsync==='function'?await safeStorage.encryptStringAsync(value):safeStorage.encryptString(value);const data=read();data[name]=bytes.toString('base64');save(data);}),
    delete:name=>serialize(async()=>{const data=read();delete data[name];save(data);})
  };
}
function trusted(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===entry;}
function bringForward(){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}}
async function quit(){
  if(closing)return;closing=true;
  try{await service?.close();quitting=true;app.quit();}
  catch(error){closing=false;dialog.showErrorBox('尚未退出',String(error.message));bringForward();}
}
async function registerIPC(){
  for(const name of ['getBootstrap','listTasks','getTask','createTask','cancelTask','getSettings','saveSettings']){
    ipcMain.handle('assistant:'+name,async(event,...args)=>{if(!trusted(event))throw Error('此窗口无权访问小助手。');return service[name](...args);});
  }
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
    if(declared&&fs.existsSync(declared)&&!bootstrap.runtime.available)throw Error('打包后的 Harness 检测失败：'+bootstrap.runtime.detail);
  }
  await new Promise(resolve=>setTimeout(resolve,800));
  const screenshot=await window.webContents.capturePage();fs.writeFileSync(path.join(artifactsDir,'desktop-home.png'),screenshot.toPNG());
  // Ask the actual renderer to open the persisted task, so the detail view is exercised as well.
  await window.webContents.executeJavaScript(`document.querySelector('[data-action="open-task"]')?.click()`);
  await new Promise(resolve=>setTimeout(resolve,500));
  fs.writeFileSync(path.join(artifactsDir,'desktop-task.png'),(await window.webContents.capturePage()).toPNG());
  const fixtureKey='sk-smoke-only-not-a-real-account';
  await service.saveSettings({runtimeApiKey:fixtureKey});
  const exposed=await service.getSettings();const encrypted=fs.readFileSync(path.join(dataRoot,'secrets.protected.json'),'utf8');
  if(encrypted.includes(fixtureKey)||exposed.runtimeApiKey!==undefined||!exposed.runtimeCredentialConfigured)throw Error('Windows 凭据保护验收失败。');
  await service.saveSettings({clearRuntimeApiKey:true});
  await service.close();
  const {createAssistantService}=await import(pathToFileURL(path.join(projectRoot,'apps/service/index.mjs')).href);
  const runtime=await import(pathToFileURL(path.join(projectRoot,'packages/runtime-harness/index.mjs')).href);
  service=await createAssistantService({dataDir:dataRoot,runtime,secretStore:secretStore(),contractAvailable:!!contractExecutable()});
  const restored=service.getTask(task.id);
  if(restored.task.status!=='succeeded'||restored.artifacts.length!==2)throw Error('重新打开数据后任务或成果丢失。');
  const report={ok:true,version:app.getVersion(),dataDir:smokeRoot,taskId:task.id,status:detail.task.status,artifactCount:detail.artifacts.length,
    rendererNodeAccess:isolation.node,preloadAPI:isolation.api,windowsSecretProtection:true,reopenPreserved:true,rendererSubmitExercised:true,
    runtimeDetected:bootstrap.runtime.available,runtimeVersion:bootstrap.runtime.version,contractAvailable:!!contractExecutable(),
    consoleErrors:failures,capturedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(artifactsDir,'desktop-smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));await service.close();quitting=true;app.exit(failures.length?1:0);
}
async function start(){
  Menu.setApplicationMenu(null);
  const runtime=await import(pathToFileURL(path.join(projectRoot,'packages/runtime-harness/index.mjs')).href);
  const {createAssistantService}=await import(pathToFileURL(path.join(projectRoot,'apps/service/index.mjs')).href);
  service=await createAssistantService({dataDir:dataRoot,runtime,secretStore:secretStore(),contractAvailable:!!contractExecutable()});
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
  app.on('second-instance',bringForward);app.on('activate',bringForward);
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void quit();}});
  app.whenReady().then(start).catch(error=>{console.error(String(error.stack||error));if(smoke){app.exit(1);}else{dialog.showErrorBox('小助手启动失败',String(error.message));quitting=true;app.quit();}});
}
