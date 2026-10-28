import test from 'node:test';
import assert from 'node:assert/strict';
import {assertInstallerVersions,assertDistributionArchive,renderInstallerFileLists} from '../scripts/installer-manifest.mjs';

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
});

test('installer cannot label an old or changed executable as the new product version',()=>{
  const verified={version:'1.0.6',manifestVersion:'1.0.6',packageVersion:'1.0.6',executableSha256:'a'.repeat(64),manifestSha256:'a'.repeat(64)};
  assert.doesNotThrow(()=>assertInstallerVersions(verified));
  for(const override of [{packageVersion:'1.0.5'},{manifestVersion:'1.0.5'},{executableSha256:'b'.repeat(64)},{version:'1.0.6-beta'}]){
    assert.throws(()=>assertInstallerVersions({...verified,...override}),/does not match/);
  }
});
