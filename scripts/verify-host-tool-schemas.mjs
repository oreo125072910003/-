import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const executable=process.argv[2];if(!executable||!path.isAbsolute(executable)||!fs.existsSync(executable))throw Error('请传入已安装的 DeepSeek Harness.exe 完整路径。');
const root=fileURLToPath(new URL('../',import.meta.url)),folder=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-native-schema-')),script=path.join(folder,'check.mjs');
try{
 const native=pathToFileURL(path.join(path.dirname(executable),'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js')).href;
 const source=pathToFileURL(path.join(root,'packages/harness-host-plugin/product-access.mjs')).href,contracts=pathToFileURL(path.join(root,'packages/contracts/product-tools.mjs')).href;
 fs.writeFileSync(script,`const native=await import(${JSON.stringify(native)});const {registerProductTools}=await import(${JSON.stringify(source)});const {PRODUCT_TOOLS}=await import(${JSON.stringify(contracts)});let checked=0;registerProductTools({tools:{register(tool){native.assertSupportedJsonSchema(tool.output.schema);checked++;return()=>{};}}},{names:PRODUCT_TOOLS.map(t=>t.name),connection:{endpoint:'http://127.0.0.1:12345/tools',token:'a'.repeat(43)},policy:{allows:()=>true},signal:new AbortController().signal});console.log(JSON.stringify({ok:true,actualDshOutputSchemaValidator:true,checked}));`);
 const result=spawnSync(executable,['--expose-internals',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true,timeout:15000});
 if(result.status!==0)throw Error(result.stderr||result.error?.message||'DSH 工具定义检查失败。');console.log(result.stdout.trim());
}finally{if(path.dirname(folder)!==os.tmpdir()||!path.basename(folder).startsWith('xzs-native-schema-'))throw Error('Unexpected temporary directory');fs.rmSync(folder,{recursive:true,force:true});}
