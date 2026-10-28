import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertInstallerVersions,assertDistributionArchive,renderInstallerFileLists,verifyWechatCompanions} from '../scripts/installer-manifest.mjs';

test('uninstall ledger cannot escape the product folder or interpolate a user filename',()=>{
  for(const name of ['../personal-data.txt','resources/../../secrets','C:\\Users\\owner\\notes.txt','\\\\server\\share\\x','file:stream','a\r\nDelete C:\\*','resources//x']){
    assert.throws(()=>renderInstallerFileLists([{path:name}],'C:\\build\\app'),/unsafe relative path/);
  }
  const result=renderInstallerFileLists([{path:'小助手.exe'},{path:'resources/app.asar'},{path:'resources/$INSTDIR.txt'}],'C:\\build\\app');
  assert.match(result.uninstall,/Delete "\$INSTDIR\\resources\\\$\$INSTDIR\.txt"/);
  assert.equal(result.uninstall.split('\r\n').filter(line=>line.startsWith('Delete ')).length,3);
  assert.match(result.uninstall,/RMDir "\$INSTDIR\\resources"/);
  assert.doesNotMatch(result.uninstall,/\/r\b|\/REBOOTOK|\*|\\\.\.\\|XiaoZhuShou\\db/);
  assert.throws(()=>renderInstallerFileLists([{path:'Resources/a'},{path:'resources/A'}],'C:\\build\\app'),/duplicate Windows paths/);
});

test('distribution archive rejects machine settings and persistent user data',()=>{
  for(const name of ['/config/runtime-locations.json','config/wechat-locations.json','\\config\\desktop-install.local.json','/secrets.protected.json','/state/account.json','/logs/debug.log','/.assistant-data/db/assistant.sqlite']){
    assert.throws(()=>assertDistributionArchive([name]),/machine-specific settings/);
  }
  assert.doesNotThrow(()=>assertDistributionArchive(['/package.json','/config/example.json','/apps/service/index.mjs','/node_modules/debug/src/index.js']));
  assert.throws(()=>assertDistributionArchive(['/companions/wechat-client/Weixin.exe']),/external resources/);
});

function companionFixture(t){
  const application=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-installer-companions-')),directory=path.join(application,'resources/companions');
  t.after(()=>fs.rmSync(application,{recursive:true,force:true}));
  const files=['wechat-client/Weixin.exe','wechat-client/version.dll','python/python.exe','python/python313.zip','reader/scripts/reader-api.py','reader/scripts/reader_setup.py','reader/scripts/wechat_image_normalize.py','reader/components/weflow-cli/resources/key/win32/x64/wx_key.dll'].map(name=>{
    const bytes=Buffer.from('MZ synthetic '+name),filename=path.join(directory,...name.split('/'));fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes);
    return {path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  });
  const manifest={schemaVersion:1,clientVersion:'4.1.10.27',platform:'win32',arch:'x64',files,hookSha256:files.find(file=>file.path==='wechat-client/version.dll').sha256,accountDataIncluded:false,existingTokensIncluded:false,credentialsIncluded:false};
  const release={wechatClientBundled:true,readerRuntimeBundled:true,clientVersion:'4.1.10.27',companions:{files:files.length,bytes:files.reduce((sum,item)=>sum+item.bytes,0),hookSha256:manifest.hookSha256}};
  function save(){const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'manifest.json'),bytes);release.companions.manifestSha256=createHash('sha256').update(bytes).digest('hex');}
  save();return {application,directory,manifest,release,save};
}

test('full installer refuses a missing runtime even if its release flags claim one',t=>{
  const f=companionFixture(t);
  assert.equal(verifyWechatCompanions(f.application,f.release).allFileDigestsVerified,true);
  fs.unlinkSync(path.join(f.directory,'wechat-client/Weixin.exe'));
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/count or size differs/);
  fs.rmSync(f.directory,{recursive:true});
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/requires the bundled WeChat/);
  assert.deepEqual(verifyWechatCompanions(f.application,{}, {required:false}),{included:false});
});

test('installed companion verification detects byte tampering and undeclared files',t=>{
  const f=companionFixture(t),python=path.join(f.directory,'python/python.exe'),original=fs.readFileSync(python);
  fs.writeFileSync(python,Buffer.alloc(original.length,65));
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/changed/);
  fs.writeFileSync(python,original);fs.writeFileSync(path.join(f.directory,'personal.token'),'must never ship');
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/unlisted/);
});

test('component manifests cannot substitute an incomplete or private runtime',t=>{
  const f=companionFixture(t);
  assert.throws(()=>verifyWechatCompanions(f.application,{...f.release,readerRuntimeBundled:false}),/complete WeChat runtime/);
  f.manifest.files=f.manifest.files.filter(file=>file.path!=='reader/scripts/reader-api.py');f.save();
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/Required WeChat runtime component/);
  f.manifest.credentialsIncluded=true;f.save();
  assert.throws(()=>verifyWechatCompanions(f.application,f.release),/private-data-bearing/);
});

test('installer cannot label an old or changed executable as the new product version',()=>{
  const verified={version:'1.0.6',manifestVersion:'1.0.6',packageVersion:'1.0.6',executableSha256:'a'.repeat(64),manifestSha256:'a'.repeat(64)};
  assert.doesNotThrow(()=>assertInstallerVersions(verified));
  for(const override of [{packageVersion:'1.0.5'},{manifestVersion:'1.0.5'},{executableSha256:'b'.repeat(64)},{version:'1.0.6-beta'}]){
    assert.throws(()=>assertInstallerVersions({...verified,...override}),/does not match/);
  }
});
