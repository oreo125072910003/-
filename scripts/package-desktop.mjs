import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { inspectRuntime } from '../packages/runtime-harness/index.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const metadata=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const releaseRoot=path.join(root,'dist','releases',metadata.version);
const stage=fs.mkdtempSync(path.join(os.tmpdir(),'xiaozhushou-package-'));
const contractOutput=path.join(root,'代码','合同助手','desktop','out','desktop-release');
function inside(base,target){const relative=path.relative(path.resolve(base),path.resolve(target));return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
function copy(relative){const source=path.join(root,relative),destination=path.join(stage,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(source,destination,{recursive:true,dereference:false,filter:filename=>!fs.lstatSync(filename).isSymbolicLink()});}
function crc32(buffer){let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function verifiedElectronCache(){
  const name=`electron-v${metadata.devDependencies.electron}-win32-x64.zip`;
  const checksums=JSON.parse(fs.readFileSync(path.join(root,'node_modules','electron','checksums.json'),'utf8'));
  const cache=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'electron','Cache');
  if(!fs.existsSync(cache))return undefined;
  for(const directory of fs.readdirSync(cache,{withFileTypes:true}).filter(item=>item.isDirectory())){
    const filename=path.join(cache,directory.name,name);if(!fs.existsSync(filename))continue;
    const digest=createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    if(digest===checksums[name])return path.dirname(filename);
  }
  return undefined;
}
function chunk(type,body){const name=Buffer.from(type);const size=Buffer.alloc(4);size.writeUInt32BE(body.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([name,body])));return Buffer.concat([size,name,body,crc]);}
function createIcon(filename){
  const width=64;const raw=Buffer.alloc((width*4+1)*width);
  for(let y=0;y<width;y++)for(let x=0;x<width;x++){const dx=x-31.5,dy=y-31.5;const i=y*(width*4+1)+1+x*4;const fill=dx*dx+dy*dy<30*30;const sparkle=Math.abs(dx)*0.65+Math.abs(dy)<12||Math.abs(dx)+Math.abs(dy)*0.65<12;if(fill){raw[i]=sparkle?246:30;raw[i+1]=sparkle?246:83;raw[i+2]=sparkle?231:71;raw[i+3]=255;}}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(width,4);header[8]=8;header[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
  const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=width;ico[7]=width;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
  fs.writeFileSync(filename,Buffer.concat([ico,png]));
}
try{
  if(process.platform!=='win32')throw Error('当前发布脚本针对 Windows，请在 Windows 构建。');
  const ps=process.env.WINDIR?path.join(process.env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe'):'powershell.exe';
  const built=spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'代码','合同助手','mcp','build.ps1'),'-OutputFolder','out/desktop-release'],{cwd:root,encoding:'utf8',windowsHide:true});
  if(built.status!==0)throw Error('合同程序构建失败：'+(built.stderr||built.stdout).slice(-3000));
  for(const relative of ['apps/desktop','apps/service','packages/contracts','packages/storage','packages/runtime-harness','node_modules/sql.js'])copy(relative);
  const appPackage={...metadata,devDependencies:undefined,scripts:undefined};
  fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify(appPackage,null,2)+'\n');
  fs.mkdirSync(path.join(stage,'config'),{recursive:true});
  const runtime=await inspectRuntime();
  if(runtime.available)fs.writeFileSync(path.join(stage,'config','runtime-locations.json'),JSON.stringify({harnessCommand:runtime.command},null,2)+'\n');
  const icon=path.join(stage,'assistant.ico');createIcon(icon);
  const embeddedContract=path.join(stage,'contract-resource');fs.mkdirSync(embeddedContract);
  for(const name of ['合同填写小助手.exe','合同助手MCP.exe'])fs.copyFileSync(path.join(contractOutput,name),path.join(embeddedContract,name));
  fs.copyFileSync(path.join(root,'代码','合同助手','desktop','source-origin.json'),path.join(embeddedContract,'source-origin.json'));
  fs.writeFileSync(path.join(stage,'THIRD-PARTY-NOTICES.txt'),'小助手 0.1 开发预览版\nSQLite: sql.js (MIT) https://github.com/sql-js/sql.js\nElectron (MIT) https://github.com/electron/electron\n合同源码来源见 resources/contract-resource/source-origin.json\nHarness 是独立安装的核心依赖，本包不复制用户 Harness 或其个人配置。\n');
  fs.mkdirSync(releaseRoot,{recursive:true});
  const expected=path.join(releaseRoot,'小助手-win32-x64');
  if(!inside(releaseRoot,expected)||path.basename(expected)!=='小助手-win32-x64')throw Error('Unexpected package overwrite target');
  const output=await packager({dir:stage,out:releaseRoot,name:'小助手',platform:'win32',arch:'x64',electronVersion:metadata.devDependencies.electron,
    appVersion:metadata.version,buildVersion:metadata.version,appBundleId:'local.xiaozhushou.desktop',asar:true,prune:false,overwrite:true,
    icon,electronZipDir:verifiedElectronCache(),extraResource:[embeddedContract],ignore:[/contract-resource/,/assistant\.ico$/],
    win32metadata:{CompanyName:'小助手项目',FileDescription:'小助手个人桌面助理',ProductName:'小助手'},
  });
  const executable=path.join(output[0],'小助手.exe');
  const manifest={version:metadata.version,createdAt:new Date().toISOString(),executable,sha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
    harness:{bundled:false,detectedVersion:runtime.version??null,programLocationOnly:runtime.available?runtime.command:null},
    contract:{included:true,syntheticDevelopmentTemplate:true},accountCredentialsIncluded:false,personalChatIncluded:false,
    signature:'unsigned-development-preview',capabilities:['local-organize','persistent-tasks','text-harness-adapter','local-contract-form']};
  fs.writeFileSync(path.join(releaseRoot,'release.json'),JSON.stringify(manifest,null,2)+'\n');
  fs.writeFileSync(path.join(output[0],'使用说明.txt'),'小助手 0.1 开发预览版\r\n\r\n双击“小助手.exe”启动。请保留整个文件夹，不要单独移动 EXE。\r\n\r\n现在可以：添加文件并整理清单、保存任务与成果、设置名字和人格、打开本地合同表单工具。\r\nAI 文本工作需要在“助手设置”填写模型 API Key；密钥由 Windows 保护保存。\r\n引擎需本机已安装支持的 DeepSeek Harness 0.2.1-rc.2。\r\n模型地址使用 Messages 兼容接口，默认 https://api.deepseek.com/anthropic。\r\n微信、邮箱、任意MCP/Skill和多agent尚未接入新桌面入口。\r\n合同内置合成开发模板，正式工作请导入并核对自己的模板。\r\n关闭窗口后留在托盘，右键托盘可退出。\r\n这是一份未签名的开发预览版，不是全部计划的最终交付。\r\n');
  console.log(JSON.stringify({ok:true,executable,releaseManifest:path.join(releaseRoot,'release.json')}));
}finally{
  const expectedParent=path.resolve(os.tmpdir());
  if(path.dirname(path.resolve(stage))!==expectedParent||!path.basename(stage).startsWith('xiaozhushou-package-'))throw Error('Unexpected staging cleanup path');
  fs.rmSync(stage,{recursive:true,force:true});
}
