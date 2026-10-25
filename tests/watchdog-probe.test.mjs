import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
test('watchdog read-only probe verifies runtime hash and tool count without starting or stopping processes',{skip:process.platform!=='win32'},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-watchdog-probe-'));
  const data='synthetic bridge source';fs.writeFileSync(path.join(dir,'mcp_dsh_server.py'),data);
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({token:'synthetic-watchdog-control-token'}));
  const sha=createHash('sha256').update(data).digest('hex');let mismatch=false,requests=0;
  const server=http.createServer((req,res)=>{requests++;assert.equal(req.url,'/health');assert.equal(req.headers.authorization,'Bearer synthetic-watchdog-control-token');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,sourceSha256:mismatch?'wrong':sha,toolCount:16}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  async function probe(){
    const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const args=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../代码/pcbridge/pcbridge_watchdog_loop.ps1',import.meta.url)),'-BridgeDirectory',dir,'-Port',String(server.address().port),'-ProbeOnly'];
    return await new Promise((resolve,reject)=>{const child=spawn(ps,args,{windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{if(code!==0)reject(Error(err));else resolve(JSON.parse(out));});});
  }
  const good=await probe();assert.equal(good.healthy,true);assert.equal(good.sourceSha256,sha);assert.equal(good.processesStarted,0);assert.equal(good.processesStopped,0);
  mismatch=true;assert.equal((await probe()).healthy,false);assert.equal(requests,2);
  assert.equal(fs.existsSync(path.join(dir,'watchdog_pcbridge.log')),false);
});
