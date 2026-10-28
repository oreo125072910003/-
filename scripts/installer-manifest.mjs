import path from 'node:path';

export function assertInstallerVersions({version,manifestVersion,packageVersion,executableSha256,manifestSha256}){
  if(!/^\d+\.\d+\.\d+$/.test(version)||version!==manifestVersion||version!==packageVersion||executableSha256!==manifestSha256)throw Error('Application release does not match the requested installer version.');
}

export function assertDistributionArchive(entries){
  for(const entry of entries){
    const name='/'+entry.replaceAll('\\','/').replace(/^\/+/, '');
    if(/\/(?:config\/(?:runtime-locations|wechat-locations|desktop-install\.local)\.json|(?:state|logs|\.assistant-data)(?:\/|$)|secrets\.protected\.json)/.test(name))throw Error('Build a distribution application without machine-specific settings: '+name);
  }
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
