import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createExtensionManager} from '../packages/extensions/index.mjs';
import {createLegacyMigration} from '../packages/extensions/legacy.mjs';

test('migration imports original method/resources and retains incompatible skills with diagnostics',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-migration-')),source=path.join(directory,'old-skills'),dataDir=path.join(directory,'product'),context={owner:true};fs.mkdirSync(source);fs.mkdirSync(dataDir);
  const make=(folder,name,body)=>{const target=path.join(source,folder);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'SKILL.md'),`---\nname: ${name}\ndescription: 原有工作方法\n---\n${body}\n`);return target;};
  const first=make('old-folder-name','writing-method','使用来源编写材料。参考 [说明](notes.txt)。');fs.writeFileSync(path.join(first,'notes.txt'),'原有资源，不修改。');make('host-specific','host-specific','调用 mcp__host__tool 获取材料。');
  const original=fs.readFileSync(path.join(first,'SKILL.md'));
  const manager=await createExtensionManager({dataDir:path.join(dataDir,'extensions'),authorize:value=>value===context});
  const migration=createLegacyMigration({dataDir,sources:[{id:'previous',kind:'skills',name:'原有技能',path:source}],manager,ownerContext:context});
  t.after(async()=>{await migration.close();await manager.close();fs.rmSync(directory,{recursive:true,force:true});});
  const report=(await migration.importAll()).report;assert.equal(report.summary.ready,1);assert.equal(report.summary.needsAdaptation,1);assert.equal(report.originalDataModified,false);
  const loaded=await manager.loadSkillContext('writing-method',context);assert.match(loaded.text,/使用来源/);assert.deepEqual(fs.readFileSync(path.join(first,'SKILL.md')),original);assert.equal(fs.readFileSync(path.join(first,'notes.txt'),'utf8'),'原有资源，不修改。');
  const second=(await migration.importAll()).report;assert.equal(second.entries.filter(item=>item.status==='already-imported').length,1);assert.equal(second.summary.ready,1);assert.equal(second.summary.needsAdaptation,1);assert.equal(manager.listSkills().length,2);
});

test('native catalog and plugin inventory preserve original installation and omit connection tokens',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-native-')),old=path.join(directory,'wechat'),profile=path.join(directory,'profile'),dataDir=path.join(directory,'product');
  for(const folder of [path.join(old,'config'),path.join(old,'state'),profile,dataDir])fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(old,'config','wechatagent.json'),JSON.stringify({ports:{dshPlugin:11230}}));fs.writeFileSync(path.join(old,'state','social-dsh-token.txt'),'private-existing-connection-token');
  const manifest=JSON.stringify({dependencies:{'existing-plugin':'1.2.3'},dsh:{profile:{bundles:['existing-plugin','native-bundle']}}});fs.writeFileSync(path.join(profile,'package.json'),manifest);
  let endpoint,auth;const migration=createLegacyMigration({dataDir,manager:{listSkills:()=>[]},ownerContext:{},sources:[{id:'wechat',name:'旧项目',kind:'wechatagent',path:old},{id:'dsh',name:'DSH',kind:'dsh-profile',path:profile}],fetchImpl:async(url,options)=>{endpoint=url;auth=options.headers.Authorization;return new Response(JSON.stringify({source:'dsh',skills:[{name:'office-docx',description:'原能力'}],tools:[{name:'contract_read'}]}));}});
  t.after(async()=>{await migration.close();fs.rmSync(directory,{recursive:true,force:true});});
  const state=await migration.refreshCatalog();assert.equal(endpoint,'http://127.0.0.1:11230/dsh-catalog');assert.equal(auth,'Bearer private-existing-connection-token');assert.equal(state.report.nativeCatalog.skills.length,1);assert.equal(state.nativePlugins.length,2);assert.equal(fs.readFileSync(path.join(profile,'package.json'),'utf8'),manifest);
  assert.equal(JSON.stringify(state).includes('private-existing-connection-token'),false);assert.equal(fs.readFileSync(path.join(dataDir,'legacy-migration','report.json'),'utf8').includes('private-existing-connection-token'),false);
});
