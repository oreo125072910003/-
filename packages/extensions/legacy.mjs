import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { inspectExtension,assertPlainTree } from '../../代码/项目/packages/extension-runtime/catalog.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const within=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
function plain(file,limit=262144){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)throw Error('文件类型或大小不适合导入。');return fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');}
function skillName(directory){const raw=plain(path.join(directory,'SKILL.md'));const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);if(!match)throw Error('缺少技能元数据。');const meta=YAML.parse(match[1],{uniqueKeys:true,maxAliasCount:0});if(typeof meta.name!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name))throw Error('技能名称无效。');return meta.name;}

/** Reads only approved skill/extension directories; importing never starts legacy code. */
export function createLegacyMigration({dataDir,sources=[],manager,ownerContext,fetchImpl=fetch}={}){
  const directory=path.join(dataDir,'legacy-migration'),reportFile=path.join(directory,'report.json');fs.mkdirSync(directory,{recursive:true});
  let report=fs.existsSync(reportFile)?JSON.parse(plain(reportFile,2*1024*1024)):null,operation=null;
  const approved=sources.filter(source=>source&&path.isAbsolute(source.path??'')&&fs.existsSync(source.path)).map(source=>({...source,path:fs.realpathSync(source.path)}));
  function inventory(){
    const items=[];
    for(const source of approved){
      if(source.kind==='dsh-profile')continue;
      const roots=source.kind==='skills'?[source.path]:[path.join(source.path,'extensions','skills'),path.join(source.path,'packages','dsh-social-bridge-plugin','skills')];
      for(const root of roots){if(!fs.existsSync(root)||fs.lstatSync(root).isSymbolicLink())continue;for(const entry of fs.readdirSync(root,{withFileTypes:true}).slice(0,256)){
        if(!entry.isDirectory()||entry.name.startsWith('.'))continue;const filename=path.join(root,entry.name);if(!within(source.path,fs.realpathSync(filename)))continue;
        if(fs.existsSync(path.join(filename,'SKILL.md')))items.push({sourceId:source.id,kind:'skill',name:entry.name,directory:filename});
        else if(fs.existsSync(path.join(filename,'skill.json')))items.push({sourceId:source.id,kind:'dsh-extension',name:entry.name,directory:filename});
      }}
      if(source.kind!=='skills'){const base=path.join(source.path,'extensions','plugins');if(fs.existsSync(base)&&!fs.lstatSync(base).isSymbolicLink())for(const entry of fs.readdirSync(base,{withFileTypes:true}).slice(0,100))if(entry.isDirectory())items.push({sourceId:source.id,kind:'dsh-extension',name:entry.name,directory:path.join(base,entry.name)});}
    }
    return items;
  }
  function nativePlugins(){const items=[];for(const source of approved.filter(item=>item.kind==='dsh-profile')){try{const manifest=JSON.parse(plain(path.join(source.path,'package.json')));const bundles=manifest.dsh?.profile?.bundles??[];for(const name of new Set([...Object.keys(manifest.dependencies??{}),...bundles]))items.push({id:name,name,version:manifest.dependencies?.[name]??'随 DSH 安装',bundled:bundles.includes(name),host:'dsh',sourceId:source.id,state:'configured',detail:'已存在于原 Harness 配置，沿用原安装与数据。'});}catch{}}return items;}
  function persist(){const temp=reportFile+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});fs.renameSync(temp,reportFile);}
  async function nativeCatalog(){
    const source=approved.find(source=>source.kind==='wechatagent');if(!source)return{connected:false,skills:[],tools:[],detail:'尚未选择原有 Harness 连接。'};
    try{
      const config=JSON.parse(plain(path.join(source.path,'config','wechatagent.json'))),port=config.ports?.dshPlugin;
      if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('连接端口无效。');
      const token=plain(path.join(source.path,'state','social-dsh-token.txt'),8192).trim();
      const response=await fetchImpl('http://127.0.0.1:'+port+'/dsh-catalog',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(6000)});
      if(!response.ok)throw Error('Harness 能力目录暂不可用。');let size=0;const parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>512*1024)throw Error('能力目录过大。');parts.push(Buffer.from(chunk));}
      const value=JSON.parse(Buffer.concat(parts).toString('utf8'));if(value.source!=='dsh'||!Array.isArray(value.skills)||!Array.isArray(value.tools))throw Error('不是已识别的 DSH 能力目录。');
      const select=(items,max)=>items.slice(0,max).filter(item=>typeof item.name==='string'&&item.name.length<160).map(({name,description,provider})=>({name,description:String(description??'').slice(0,500),...(provider?{provider:String(provider).slice(0,100)}:{})}));
      return{connected:true,source:'existing-dsh',checkedAt:new Date().toISOString(),skills:select(value.skills,200),tools:select(value.tools,300),detail:'这是现有 DSH 实际提供的能力目录；小助手桌面调用权限另行显示。'};
    }catch{return{connected:false,skills:[],tools:[],detail:'现有 Harness 的能力目录尚未连接，请启动已经配置的 Harness 后刷新。'};}
  }
  const api={
    getState(){const items=inventory(),plugins=nativePlugins();return{sources:approved.map(({id,name})=>({id,name,skillCount:items.filter(item=>item.sourceId===id&&item.kind==='skill').length,pluginCount:items.filter(item=>item.sourceId===id&&item.kind==='dsh-extension').length+plugins.filter(item=>item.sourceId===id).length})),nativePlugins:plugins,report};},
    nativeCatalog,
    async importAll(){
      if(operation)return operation;
      operation=(async()=>{
        const items=inventory(),entries=[];
        for(const item of items){
          try{
            if(item.kind==='skill'){
              assertPlainTree(item.directory);
              const id=skillName(item.directory),existing=manager.listSkills().find(skill=>skill.id===id);
              if(existing){entries.push({sourceId:item.sourceId,kind:item.kind,id,status:existing.usable?'already-imported':'needs-adaptation',usable:existing.usable===true,detail:existing.usable?'已存在并可使用同名技能，保留当前版本。':'技能已保存，依赖或宿主接口仍需适配。',diagnostics:existing.diagnostics});continue;}
              let sourceDirectory=item.directory,stage;
              try{
                if(path.basename(item.directory)!==id){stage=path.join(directory,'stage-'+randomUUID());fs.mkdirSync(stage);sourceDirectory=path.join(stage,id);fs.cpSync(item.directory,sourceDirectory,{recursive:true,filter:file=>!fs.lstatSync(file).isSymbolicLink()});}
                const version='migrated-'+sha(plain(path.join(sourceDirectory,'SKILL.md'))).slice(0,12);
                const imported=await manager.importSkill(sourceDirectory,{version,source:item.directory},ownerContext);
                let enabled=false;try{await manager.enableSkill(id,ownerContext);enabled=true;}catch{}
                entries.push({sourceId:item.sourceId,kind:item.kind,id,status:enabled?'ready':'needs-adaptation',detail:enabled?'已复制并启用工作方法。':'技能与资料已保留，依赖或宿主接口仍需适配。',diagnostics:imported.diagnostics});
              }finally{if(stage&&within(directory,stage))fs.rmSync(stage,{recursive:true,force:true});}
            }else{
              const extension=inspectExtension(item.directory,fs.existsSync(path.join(item.directory,'plugin.json'))?'plugins':'skills');
              const destination=path.join(directory,'dsh-extensions',extension.id+'-'+extension.revision.slice(0,12));fs.mkdirSync(path.dirname(destination),{recursive:true});
              if(!fs.existsSync(destination))fs.cpSync(item.directory,destination,{recursive:true,errorOnExist:true,force:false});
              entries.push({sourceId:item.sourceId,kind:item.kind,id:extension.id,name:extension.name,version:extension.version,revision:extension.revision,status:'dsh-managed',detail:'原生 DSH 扩展代码已保留；沿用 DSH 宿主的已安装能力，未另启扩展进程。'});
            }
          }catch(error){entries.push({sourceId:item.sourceId,kind:item.kind,id:item.name,status:'needs-adaptation',detail:String(error.message).slice(0,500)});}
        }
        const catalog=await nativeCatalog();report={at:new Date().toISOString(),entries,nativeCatalog:catalog,nativePlugins:nativePlugins(),summary:{ready:entries.filter(item=>item.status==='ready'||item.status==='already-imported'&&item.usable).length,preserved:entries.filter(item=>['already-imported','dsh-managed'].includes(item.status)).length,needsAdaptation:entries.filter(item=>item.status==='needs-adaptation').length},originalDataModified:false};persist();return api.getState();
      })();try{return await operation;}finally{operation=null;}
    },
    async refreshCatalog(){const catalog=await nativeCatalog();report={...(report??{entries:[],summary:{ready:0,preserved:0,needsAdaptation:0}}),nativeCatalog:catalog};persist();return api.getState();},
    async close(){if(operation)await operation;}
  };return api;
}
