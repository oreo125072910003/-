import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const {createSecretStore}=createRequire(import.meta.url)('../apps/desktop/secret-store.cjs');

test('async Electron decryption returns the actual string and rotates protected values',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-vault-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let encrypted=0;
  const protection={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async value=>{encrypted++;return Buffer.from('cipher:'+Buffer.from(value).toString('base64'));},
    decryptStringAsync:async bytes=>({result:Buffer.from(bytes.toString().slice(7),'base64').toString(),shouldReEncrypt:true})};
  const vault=createSecretStore({dataDir:directory,safeStorage:protection});
  const value=JSON.stringify({readerToken:'synthetic-private-value'});
  await vault.set('wechat',value);assert.equal(await vault.get('wechat'),value);assert.equal(encrypted,2);
  assert.equal(fs.readFileSync(path.join(directory,'secrets.protected.json'),'utf8').includes('synthetic-private-value'),false);
  await vault.delete('wechat');assert.equal(await vault.get('wechat'),null);
});

test('unavailable system protection fails without persisting plaintext',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-vault-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const vault=createSecretStore({dataDir:directory,safeStorage:{isAsyncEncryptionAvailable:async()=>false}});
  await assert.rejects(vault.set('key','synthetic-value'),/未保存密钥/);
  assert.equal(fs.existsSync(path.join(directory,'secrets.protected.json')),false);
});
