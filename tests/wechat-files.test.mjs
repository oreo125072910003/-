import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {fileMetadataFromXml,wechatFileReferences,cleanWechatFiles} from '../packages/wechat-bridge/file-references.mjs';
import {extractDocument} from '../packages/documents/index.mjs';
import {snapshotWechatFile} from '../apps/service/wechat-file-input.mjs';
import {executionGuidance} from '../apps/service/execution-guidance.mjs';

export function syntheticWorkbook(){return zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml':'<Types/>',
  'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="中文材料" r:id="r2"/><sheet name="核对" r:id="r1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':'<sst><si><r><t>合成</t></r><r><t>物料</t></r></si></sst>',
  'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>125.50</v></c><c r="C1"><f>B1*2</f><v>251</v></c><c r="D1" t="inlineStr"><is><t>规格甲</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="b"><v>1</v></c></row></sheetData></worksheet>',
}).map(([name,text])=>[name,strToU8(text)])));}
const temporary=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-file-input-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;};
const md5='b'.repeat(32);
const forwarded=`<msg><appmsg><type>19</type><recorditem><![CDATA[<recordinfo><datalist><dataitem datatype="8"><datatitle>材料.docx</datatitle><datasize>20</datasize><fullmd5>${md5}</fullmd5></dataitem><dataitem datatype="14"><recordxml>&lt;recordinfo&gt;&lt;datalist&gt;&lt;dataitem datatype="8"&gt;&lt;datatitle&gt;明细.xlsx&lt;/datatitle&gt;&lt;datasize&gt;30&lt;/datasize&gt;&lt;fullmd5&gt;${md5}&lt;/fullmd5&gt;&lt;/dataitem&gt;&lt;/datalist&gt;&lt;/recordinfo&gt;</recordxml></dataitem></datalist></recordinfo>]]></recorditem></appmsg></msg>`;

test('ordinary and nested forwarded file metadata produce bound opaque references without paths',()=>{
  assert.deepEqual(fileMetadataFromXml('<msg><appmsg><type>6</type><title>材料.docx</title><appattach><totallen>20</totallen></appattach></appmsg></msg>'),[{name:'材料.docx',size:20}]);
  const metadata=fileMetadataFromXml(forwarded);assert.deepEqual(metadata,[{name:'材料.docx',size:20},{name:'明细.xlsx',size:30}]);
  const nestedRecord='<recordinfo><datalist><dataitem datatype="8"><datatitle>多层.xlsx</datatitle><datasize>10</datasize></dataitem></datalist></recordinfo>';
  const encoded=nestedRecord.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  assert.deepEqual(fileMetadataFromXml(`<msg><appmsg><type>19</type><recorditem><![CDATA[${encoded}]]></recorditem></appmsg></msg>`),[{name:'多层.xlsx',size:10}]);
  const input={account:'synthetic',talker:'wxid_friend',sourceId:'a'.repeat(64),metadata};
  const refs=wechatFileReferences(input);assert.equal(refs.length,2);assert.notEqual(refs[0].id,refs[1].id);
  assert.notEqual(wechatFileReferences({...input,talker:'wxid_other'})[0].id,refs[0].id);
  assert.equal(cleanWechatFiles([{...refs[0],path:'C:/outside/private.docx'}])[0].path,undefined);
  assert.equal(cleanWechatFiles([{...refs[0],allowIndexedFallback:true}])[0].allowIndexedFallback,undefined);
  assert.deepEqual(fileMetadataFromXml('<!DOCTYPE msg><msg/>'),[]);
  assert.deepEqual(wechatFileReferences({...input,metadata:[{name:'../secret.docx',size:20}]}),[]);
});

test('Excel extraction preserves workbook order, shared strings, coordinates and cached formulas',async t=>{
  const root=temporary(t),file=path.join(root,'合成.xlsx');fs.writeFileSync(file,syntheticWorkbook());
  const result=await extractDocument({path:file,allowedRoot:root});
  assert.match(result.text,/中文材料[\s\S]*A1: 合成物料[\s\S]*B1: 125.50[\s\S]*C1: 251/);
  assert.ok(result.text.indexOf('中文材料')<result.text.indexOf('核对'));assert.match(result.text,/D1: 规格甲/);
  assert.match(result.text,/未重新计算/);assert.ok(result.diagnostics.some(item=>item.code==='FORMULA_CACHED_VALUES_ONLY'));
  const short=await extractDocument({path:file,allowedRoot:root,maxChars:16});assert.equal(short.text.length,16);assert.equal(short.truncated,true);
});

test('file snapshots require matching identity, size, bytes and digest and discard late cancellation results',async t=>{
  const root=temporary(t);fs.mkdirSync(path.join(root,'资料'));const bytes=Buffer.from('合成资料'),file={id:'a'.repeat(64),name:'合成.docx',size:bytes.length};
  const result={id:file.id,name:file.name,size:bytes.length,b64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
  const args={kind:'private',target:'101',message:{id:'wechat_synthetic'},file,workspace:root,signal:new AbortController().signal};
  for(const patch of [{id:'b'.repeat(64)},{sha256:'0'.repeat(64)},{size:1},{name:'另一份.docx'}])await assert.rejects(snapshotWechatFile({...args,wechat:{resolveFile:async()=>({...result,...patch})}}),{code:'FILE_INTEGRITY_FAILED'});
  assert.equal(fs.readdirSync(path.join(root,'资料')).length,0);
  const snapshot=await snapshotWechatFile({...args,wechat:{resolveFile:async()=>result}});assert.deepEqual(fs.readFileSync(snapshot.path),bytes);
  let release;const gate=new Promise(resolve=>{release=resolve;}),aborter=new AbortController();
  const late=snapshotWechatFile({...args,file:{...file,id:'c'.repeat(64)},signal:aborter.signal,wechat:{resolveFile:async()=>{await gate;return{...result,id:'c'.repeat(64)};}}});
  aborter.abort();await assert.rejects(late);release();await new Promise(resolve=>setTimeout(resolve,15));assert.equal(fs.readdirSync(path.join(root,'资料')).length,1);
});

test('existing command authority is described as autonomous execution without creating an extra grant',()=>{
  const yes=executionGuidance({tools:['xiaozhushou_run_local_shell','xiaozhushou_read_document'],executionPolicy:'trusted-computer-task-v1',channel:'wechat'});
  assert.match(yes,/安装或升级/);assert.match(yes,/不需要另有一个名叫 agent/);assert.match(yes,/wechat:\/\/files/);
  assert.doesNotMatch(executionGuidance({tools:['xiaozhushou_read_document'],channel:'wechat'}),/已有主人核验的本机命令/);
  assert.equal(executionGuidance({tools:['xiaozhushou_run_local_shell']}),'');
});

test('digest-less indexed file reads require existing computer-read scope and recheck revocation before saving',async t=>{
  const root=temporary(t);fs.mkdirSync(path.join(root,'资料'));const bytes=Buffer.from('scoped-file'),file={id:'a'.repeat(64),name:'合成.docx',size:bytes.length};
  const result={id:file.id,name:file.name,size:bytes.length,b64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),verification:'owner-authorized-cache-index'};
  const requests=[],args={kind:'private',target:'101',message:{id:'wechat_synthetic'},file,workspace:root,signal:new AbortController().signal,wechat:{resolveFile:async input=>{requests.push(input);return result;}}};
  await assert.rejects(snapshotWechatFile(args),{code:'FILE_SCOPE_CHANGED'});assert.equal(requests[0].allowIndexedFallback,false);
  let checks=0;await assert.rejects(snapshotWechatFile({...args,allowIndexedFallback:true,verifyIndexedScope:async()=>++checks===1}),{code:'FILE_SCOPE_CHANGED'});
  assert.equal(fs.readdirSync(path.join(root,'资料')).length,0);
  const saved=await snapshotWechatFile({...args,allowIndexedFallback:true,verifyIndexedScope:async()=>true});assert.equal(saved.verification,'owner-authorized-cache-index');assert.deepEqual(fs.readFileSync(saved.path),bytes);
});

test('Python cache resolver requires exact source digest and rejects absent cache, name traversal and changed bytes',()=>{
  const script=String.raw`import importlib.util,pathlib,tempfile,hashlib,json,sys,sqlite3,types
spec=importlib.util.spec_from_file_location('files',r'${path.resolve('packages/wechat-bridge/wechat-file-worker.py')}')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
items=m.file_items(json.loads(sys.stdin.read()));assert [item['size'] for item in items]==[20,30];assert all(item['hashes']==['${md5}'] for item in items)
with tempfile.TemporaryDirectory(prefix='xzs-python-files-') as temp:
 root=pathlib.Path(temp);folder=root/'msg'/'file'/'2026-10';folder.mkdir(parents=True)
 data=b'synthetic-content';(folder/'same.docx').write_bytes(data)
 info={'name':'same.docx','size':len(data),'hashes':[hashlib.md5(data).hexdigest()]}
 assert m.cached_bytes(root,info)==data
 results=[]
 for patch in ({'hashes':[]},{'hashes':['b'*32]},{'name':'../private.docx'}):
  try:m.cached_bytes(root,{**info,**patch});raise AssertionError('unexpected bytes')
  except RuntimeError as error:results.append(str(error))
 database=root/'db_storage/hardlink/hardlink.db';database.parent.mkdir(parents=True)
 con=sqlite3.connect(database);con.execute('CREATE TABLE file_hardlink_info_v4(md5 TEXT,file_name TEXT,file_size INTEGER)');con.execute('INSERT INTO file_hardlink_info_v4 VALUES(?,?,?)',(info['hashes'][0],info['name'],info['size']));con.commit();con.close()
 def connect(file,*args):
  con=sqlite3.connect(file);return con,con.cursor()
 module=types.SimpleNamespace(local_secret=lambda value:value,nt=types.SimpleNamespace(derive_database_key=lambda *args:('',b''),connect_nt_db=connect))
 assert m.indexed_digest(module,{'decryptKey':'synthetic'},root,info)==info['hashes']
 con=sqlite3.connect(database);con.execute('INSERT INTO file_hardlink_info_v4 VALUES(?,?,?)',('c'*32,info['name'],info['size']));con.commit();con.close()
 try:m.indexed_digest(module,{'decryptKey':'synthetic'},root,info);raise AssertionError('ambiguous cache allowed')
 except RuntimeError as error:assert str(error)=='FILE_CACHE_AMBIGUOUS'
 print(json.dumps(results))`;
  const result=JSON.parse(execFileSync(process.env.XZS_TEST_PYTHON??'python',['-B','-c',script],{encoding:'utf8',windowsHide:true,input:JSON.stringify(forwarded)}));
  assert.deepEqual(result,['FILE_DIGEST_UNAVAILABLE','FILE_NOT_CACHED','FILE_NAME_INVALID']);
});
