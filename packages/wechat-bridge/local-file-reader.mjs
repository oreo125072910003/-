import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const fail=code=>Object.assign(Error(code),{code});
const script=fileURLToPath(new URL('./wechat-file-worker.py',import.meta.url)).replace(/([\\/])app\.asar([\\/])/,'$1app.asar.unpacked$2');
function selectedSource(sources,readerBaseUrl,hookBaseUrl){
  for(const source of sources??[]){try{
    const root=fs.realpathSync.native(source);
    const read=relative=>{const file=path.join(root,relative),inside=path.relative(root,fs.realpathSync.native(file));const stat=fs.lstatSync(file);if(inside==='..'||inside.startsWith('..'+path.sep)||path.isAbsolute(inside)||!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)throw Error();return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));};
    const config=read('config/wechatagent.json'),io=read('state/wechat-io-config.json');
    if(new URL(io.reader_base_url).origin!==readerBaseUrl||new URL(config.hook.baseUrl).origin!==hookBaseUrl||!path.isAbsolute(config.runtime.python)||!fs.statSync(config.runtime.python).isFile())continue;
    return{root,python:config.runtime.python};
  }catch{}}
  throw fail('FILE_READER_UNAVAILABLE');
}
export function createLocalWechatFileReader({sources,readerBaseUrl,hookBaseUrl}){
  return async(request,{signal}={})=>{
    signal?.throwIfAborted();const source=selectedSource(sources,readerBaseUrl,hookBaseUrl);
    return new Promise((resolve,reject)=>{
      const child=spawn(source.python,['-B',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
      let chunks=[],size=0,finished=false,failure;
      const stop=code=>{failure??=fail(code);if(child.exitCode===null&&child.signalCode===null)child.kill();};
      const abort=()=>stop('FILE_READ_CANCELLED'),timer=setTimeout(()=>stop('FILE_READ_TIMEOUT'),20000);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>24*1024*1024)stop('FILE_TOO_LARGE');else chunks.push(chunk);});
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
      const end=error=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      child.once('error',()=>end(fail('FILE_READER_UNAVAILABLE')));
      child.once('close',()=>{
        if(finished)return;
        try{if(failure)throw failure;signal?.throwIfAborted();const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result.ok)throw fail(/^FILE_[A-Z_]+$/.test(result.error??'')?result.error:'FILE_READ_FAILED');finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result);}
        catch(error){end(error);}
      });
      child.stdin.end(JSON.stringify({...request,root:source.root}));
    });
  };
}
