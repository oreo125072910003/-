import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

export function assertInstallerVersions({version,manifestVersion,packageVersion,executableSha256,manifestSha256}){
  if(!/^\d+\.\d+\.\d+$/.test(version)||version!==manifestVersion||version!==packageVersion||executableSha256!==manifestSha256)throw Error('Application release does not match the requested installer version.');
}

export function assertDistributionArchive(entries){
  for(const entry of entries){
    const name='/'+entry.replaceAll('\\','/').replace(/^\/+/, '');
    if(/\/(?:config\/(?:runtime-locations|wechat-locations|desktop-install\.local)\.json|(?:state|logs|\.assistant-data)(?:\/|$)|secrets\.protected\.json)/.test(name))throw Error('Build a distribution application without machine-specific settings: '+name);
    if(/^\/companions(?:\/|$)/.test(name))throw Error('Wechat companions must be external resources, not duplicated inside app.asar.');
  }
}

function digestFile(filename){
  const hash=createHash('sha256'),descriptor=fs.openSync(filename,'r'),buffer=Buffer.allocUnsafe(1024*1024);
  try{let count;while((count=fs.readSync(descriptor,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count));return hash.digest('hex');}finally{fs.closeSync(descriptor);}
}

/** Verify the actual externally installed files, not just flags in release.json. */
export function verifyWechatCompanions(application,release,{required=true}={}){
  const directory=path.join(application,'resources/companions'),manifestFile=path.join(directory,'manifest.json');
  if(!fs.existsSync(manifestFile)){
    if(required||release.wechatClientBundled||release.readerRuntimeBundled)throw Error('Full installer requires the bundled WeChat client and reader runtime.');
    return {included:false};
  }
  if(release.wechatClientBundled!==true||release.readerRuntimeBundled!==true||release.clientVersion!=='4.1.10.27')throw Error('Release does not declare the complete WeChat runtime.');
  const bytes=fs.readFileSync(manifestFile),manifest=JSON.parse(bytes),manifestSha256=createHash('sha256').update(bytes).digest('hex');
  if(manifest.schemaVersion!==1||manifest.clientVersion!=='4.1.10.27'||manifest.platform!=='win32'||manifest.arch!=='x64'||!Array.isArray(manifest.files)||!manifest.files.length||manifest.accountDataIncluded!==false||manifest.existingTokensIncluded!==false||manifest.credentialsIncluded!==false)throw Error('Invalid or private-data-bearing WeChat companion manifest.');
  if(release.companions?.manifestSha256!==manifestSha256)throw Error('WeChat companion manifest differs from the release digest.');
  const expected=new Map();let total=0;
  for(const item of manifest.files){
    const relative=relativeFile(item.path).replaceAll('\\','/');
    if(!/^(wechat-client|python|reader)\//.test(relative)||/(^|\/)(state|config|logs|__pycache__)(\/|$)|\.token$|\.sqlite(?:$|-)|wechatagent-hook\.token/.test(relative)||!Number.isSafeInteger(item.bytes)||item.bytes<0||! /^[a-f0-9]{64}$/.test(item.sha256))throw Error('Invalid distributable WeChat component entry.');
    const key=relative.toLowerCase();if(expected.has(key))throw Error('Duplicate WeChat component path.');
    expected.set(key,{...item,path:relative});total+=item.bytes;
  }
  for(const name of ['wechat-client/Weixin.exe','wechat-client/version.dll','python/python.exe','python/python313.zip','reader/scripts/reader-api.py','reader/scripts/reader_setup.py','reader/scripts/wechat_image_normalize.py','reader/components/weflow-cli/resources/key/win32/x64/wx_key.dll']){
    if(!expected.has(name.toLowerCase()))throw Error('Required WeChat runtime component is missing: '+name);
  }
  const actual=[];
  function walk(folder){
    const stat=fs.lstatSync(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('WeChat companion directory is not a physical directory.');
    for(const item of fs.readdirSync(folder,{withFileTypes:true})){
      const filename=path.join(folder,item.name);if(item.isSymbolicLink())throw Error('WeChat companion files cannot be links.');
      if(item.isDirectory())walk(filename);else if(item.isFile())actual.push({filename,relative:path.relative(directory,filename).replaceAll('\\','/')});else throw Error('Unsupported WeChat companion file.');
    }
  }
  walk(directory);
  for(const {filename,relative} of actual){
    if(relative==='manifest.json')continue;
    const entry=expected.get(relative.toLowerCase());
    if(!entry||fs.statSync(filename).size!==entry.bytes||digestFile(filename)!==entry.sha256)throw Error('WeChat companion file is unlisted, missing or changed: '+relative);
  }
  if(actual.length!==expected.size+1||release.companions.files!==expected.size||release.companions.bytes!==total)throw Error('WeChat companion file count or size differs.');
  const hook=expected.get('wechat-client/version.dll');
  if(manifest.hookSha256!==hook.sha256||release.companions.hookSha256!==hook.sha256)throw Error('WeChat hook digest differs.');
  for(const name of ['wechat-client/Weixin.exe','python/python.exe']){
    const descriptor=fs.openSync(path.join(directory,...name.split('/')),'r'),signature=Buffer.alloc(2);try{fs.readSync(descriptor,signature,0,2,0);}finally{fs.closeSync(descriptor);}
    if(signature.toString()!=='MZ')throw Error('WeChat or Python executable is not a Windows program.');
  }
  return {included:true,clientVersion:manifest.clientVersion,files:expected.size,bytes:total,manifestSha256,hookSha256:hook.sha256,allFileDigestsVerified:true};
}

function relativeFile(name){
  if(typeof name!=='string'||!name||path.win32.isAbsolute(name)||/[\0\r\n:*?"<>|]/.test(name)||name.split(/[\\/]/).some(part=>part==='..'||part==='.'||part===''))throw Error('Installer file list contains an unsafe relative path.');
  return name.replaceAll('/','\\');
}
export const quoteNsis=value=>String(value).replaceAll('$',()=>'$$').replaceAll('"',()=>'$\\"');

/** A closed program-file ledger. Uninstall never walks or deletes arbitrary
 * directory contents, even when users leave their own files beside the app. */
export function renderInstallerFileLists(files,application){
  const names=files.map(file=>relativeFile(file.path));
  if(new Set(names.map(name=>name.toLowerCase())).size!==names.length)throw Error('Installer file list contains duplicate Windows paths.');
  const directories=new Set(),install=[];
  let current;
  for(const name of names){
    const folder=path.win32.dirname(name);
    let parent=folder;
    while(parent!=='.'){directories.add(parent);parent=path.win32.dirname(parent);}
    if(folder!==current){current=folder;install.push('SetOutPath "'+(folder==='.'?'$INSTDIR':'$INSTDIR\\'+quoteNsis(folder))+'"');}
    install.push('File "'+quoteNsis(path.win32.join(application,name))+'"');
  }
  const uninstall=[...names.map(name=>'Delete "$INSTDIR\\'+quoteNsis(name)+'"'),...Array.from(directories).sort((a,b)=>b.split('\\').length-a.split('\\').length||a.localeCompare(b)).map(name=>'RMDir "$INSTDIR\\'+quoteNsis(name)+'"')];
  return {install:install.join('\r\n')+'\r\n',uninstall:uninstall.join('\r\n')+'\r\n'};
}
