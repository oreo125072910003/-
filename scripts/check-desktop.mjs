import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const roots=['apps','packages','scripts','tests'];
const files=[];
function walk(directory){if(!fs.existsSync(directory))return;for(const item of fs.readdirSync(directory,{withFileTypes:true})){const filename=path.join(directory,item.name);if(item.isDirectory())walk(filename);else if(/\.(mjs|cjs|js)$/.test(filename))files.push(filename);}}
for(const directory of roots)walk(directory);
let failed=0;
for(const filename of files){const result=spawnSync(process.execPath,['--check',filename],{encoding:'utf8'});if(result.status!==0){failed++;console.error(filename+'\n'+result.stderr);}}
console.log(JSON.stringify({checked:files.length,failed}));process.exitCode=failed?1:0;
