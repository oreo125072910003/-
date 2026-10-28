// Real bundled-component preparation in an isolated smoke data directory.
// Never opens WeChat, discovers an account, logs in, or sends a message.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');

exports.verifyPortableWechatUI=async function({window,dataDir,artifactsDir,required}){
  const evaluate=source=>window.webContents.executeJavaScript(source);
  const wait=async(predicate,label,timeout=20000)=>{const until=Date.now()+timeout;while(!await predicate()){if(Date.now()>until)throw Error(label);await new Promise(resolve=>setTimeout(resolve,100));}};
  const initial=await evaluate('window.assistant.getPortableWechatState()');
  if(!initial.available){if(required)throw Error('独立安装包没有内置微信组件。');return{portableWechatComponentsPrepared:false,portableWechatRuntimeVerified:false};}
  assert.equal(initial.connectionImported,false);
  await wait(()=>evaluate(`Boolean(document.querySelector('[data-page="wechat"]'))`),'微信导航未加载');
  await evaluate(`document.querySelector('[data-page="wechat"]').click()`);
  await wait(()=>evaluate(`Boolean(document.querySelector('[data-action="wechat-setup"]'))`),'微信页没有内置组件准备入口');
  await evaluate(`document.querySelector('[data-action="wechat-setup"]').click()`);
  await wait(()=>evaluate(`Boolean(document.querySelector('dialog.portable-setup-dialog[open]'))`),'微信准备向导未打开');
  await evaluate(`document.querySelector('[data-setup="prepare"]').click()`);
  let state;
  await wait(async()=>{state=await evaluate('window.assistant.getPortableWechatState()');if(state.job?.state==='failed')throw Error(state.job.message);return state.job?.kind==='prepare'&&state.job.state==='succeeded';},'真实微信组件准备超时',180000);
  assert.equal(state.prepared,true);assert.equal(state.accountConfigured,false);assert.equal(state.connectionImported,false);
  const environment=path.join(dataDir,'wechat-environment'),config=JSON.parse(fs.readFileSync(path.join(environment,'config/wechatagent.json'),'utf8'));
  assert.equal(config.runtime.python,path.join(environment,'python/python.exe'));
  assert.deepEqual(config.wechat.whitelist,{private:[],groups:[]});
  assert.match(fs.readFileSync(path.join(environment,'state/hook/native-token.txt'),'utf8'),/^[a-f0-9]{64}$/);
  const pythonCode="import sys,runpy,json,ctypes; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[1]+'/reader-api.py',run_name='offline_import'); import sqlcipher3,cryptography,zstandard,Crypto,PIL; ctypes.CDLL(sys.argv[2]); print(json.dumps({'readerImports':True,'nativeKeyComponentLoads':True,'accountRead':False}))";
  const runtime=spawnSync(config.runtime.python,['-B','-c',pythonCode,path.join(environment,'scripts'),path.join(environment,'components/weflow-cli/resources/key/win32/x64/wx_key.dll')],{cwd:environment,windowsHide:true,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:45000});
  if(runtime.status!==0)throw Error('安装包中的 Python/微信读取组件不能启动：'+String(runtime.stderr||runtime.error?.message).slice(-1500));
  const verified=JSON.parse(runtime.stdout.trim());assert.equal(verified.readerImports,true);assert.equal(verified.nativeKeyComponentLoads,true);assert.equal(verified.accountRead,false);
  await wait(()=>evaluate(`Boolean(document.querySelector('[data-setup="open"]:not(:disabled)'))`),'准备完成后打开微信按钮未启用');
  fs.writeFileSync(path.join(artifactsDir,'desktop-wechat-bundled-ready.png'),(await window.webContents.capturePage()).toPNG());
  await evaluate(`document.querySelector('.portable-close').click();document.querySelector('[data-page="home"]').click()`);
  await wait(()=>evaluate(`Boolean(document.querySelector('#task-form'))`),'准备后未能返回工作台');
  return{portableWechatComponentsPrepared:true,portableWechatRuntimeVerified:true,portableWechatSetupEntryVisible:true,portableWechatSetupDialogExercised:true,portableWechatClientOpened:false,portableWechatAccountRead:false,portableWechatMessagesSent:0};
};
