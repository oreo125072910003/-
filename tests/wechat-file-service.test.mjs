import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {createAssistantService} from '../apps/service/index.mjs';
import {writeOfficeDocument} from '../packages/documents/index.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const until=async check=>{const end=Date.now()+12000;while(!await check()){assert.ok(Date.now()<end,'File task did not finish');await new Promise(resolve=>setTimeout(resolve,15));}};
async function fixture(t,{unavailable=false,model}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xzs-file-service-')),source=path.join(root,'legacy'),dataDir=path.join(root,'product');
  fs.mkdirSync(path.join(source,'config'),{recursive:true});fs.mkdirSync(path.join(source,'state/hook'),{recursive:true});
  fs.writeFileSync(path.join(source,'config/wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},hook:{expectedVersion:'4.1.10.27',baseUrl:'http://127.0.0.1:30001'},wechat:{whitelist:{private:['101'],groups:[]}}}));
  fs.writeFileSync(path.join(source,'state/wechat-io-config.json'),JSON.stringify({reader_base_url:'http://127.0.0.1:5031',reader_token:'synthetic-file-reader-token'}));
  fs.writeFileSync(path.join(source,'state/hook/native-token.txt'),'a'.repeat(64));
  const bytes=new Map(),requests=[],sends=[],reads=[],history=[];let callbacks;
  const runtime={inspectHostedRuntime:async()=>({available:true,ready:true,capabilities:{}}),readHostedCatalog:async()=>({ok:true,metadataOnly:true,skills:[],tools:[{name:'xiaozhushou_read_document',description:'Read granted input',grantable:true}]}),
    runHostedTask:async input=>{requests.push(input);if(model)await model(input);return{ok:true,finalText:'已依据本轮实际资料完成核对。',sessionId:input.sessionId??'xzs-'+'c'.repeat(32)};}};
  const secrets=new Map();
  const service=await createAssistantService({dataDir,runtime,secretStore:{get:key=>secrets.get(key),set:(key,value)=>secrets.set(key,value),delete:key=>secrets.delete(key)},wechatBridgeFactory:options=>{
    callbacks=options;return{start:async()=>options.onState({state:'ready',selfId:'777',accountVerified:true,readerConnected:true}),stop:async()=>{},
      resolveFile:async({file})=>{reads.push(file);if(unavailable)throw Object.assign(Error('FILE_NOT_CACHED'),{code:'FILE_NOT_CACHED'});const content=bytes.get(file.id);return{id:file.id,name:file.name,size:content.length,sha256:hash(content),b64:content.toString('base64')};},
      getHistory:async({kind,target})=>({kind,target,name:'合成会话',messages:history}),
      sendText:async value=>{sends.push(value);return{receipt:'wechat-server-id',delivered:'database-confirmed',message_id:String(sends.length)};}};}});
  t.after(async()=>{await service.close();fs.rmSync(root,{recursive:true,force:true});});
  await service.importWechatConnection(source,{automatic:true});
  let serial=0;
  const emit=(files=[],text='请读取这些 Word 和 Excel 资料。')=>callbacks.onMessage({self_id:'777',kind:'private',conversation_id:'101',sender_id:'101',sender_name:'合成联系人',text,files,message_id:'file-'+(++serial),time:Math.ceil(Date.now()/1000)});
  const finish=async()=>{await until(()=>service.listTasks().length>0&&service.listTasks().every(task=>['succeeded','failed','cancelled'].includes(task.status)));await until(async()=>(await service.getWechatState()).autoReply.active===0);};
  const reference=(id,name,content)=>{bytes.set(id,Buffer.from(content));return{id,name,size:content.length,index:0,sourceId:'f'.repeat(64)};};
  return{root,service,requests,sends,reads,history,emit,finish,reference};
}

test('live Word and Excel bytes are snapshotted and their actual text reaches the same DSH task',async t=>{
  const f=await fixture(t),docs=await writeOfficeDocument({workspace:f.root,title:'合成合同',blocks:[{type:'paragraph',text:'合同金额合计 318 元。'}],formats:['docx']});
  const docx=fs.readFileSync(docs.artifacts[0].path),xlsx=zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types/>','xl/workbook.xml':'<workbook xmlns:r="x"><sheets><sheet name="明细" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>材料数量</t></is></c><c r="B1"><v>12</v></c></row></sheetData></worksheet>',
  }).map(([name,value])=>[name,strToU8(value)])));
  f.emit([f.reference('a'.repeat(64),'合同.docx',docx),f.reference('b'.repeat(64),'清单.xlsx',xlsx)]);await f.finish();
  assert.equal(f.requests.length,1);assert.match(f.requests[0].prompt,/合同金额合计 318 元/);assert.match(f.requests[0].prompt,/材料数量[\s\S]*B1: 12/);
  const task=f.service.listTasks()[0];assert.equal(task.status,'succeeded');assert.deepEqual(task.attachments.map(item=>item.status),['provided','provided']);
  assert.deepEqual(fs.readFileSync(task.attachments[0].path),docx);assert.deepEqual(fs.readFileSync(task.attachments[1].path),Buffer.from(xlsx));
  assert.equal(f.sends.length,1);assert.ok(f.service.getTask(task.id).artifacts.some(item=>item.name==='微信文件读取记录.json'));
});

test('missing local cache is explicitly reported to DSH without inventing file contents',async t=>{
  const f=await fixture(t,{unavailable:true});f.emit([f.reference('a'.repeat(64),'未下载.docx',Buffer.from('not-read'))]);await f.finish();
  assert.equal(f.requests.length,1);assert.match(f.requests[0].prompt,/FILE_NOT_CACHED/);assert.match(f.requests[0].prompt,/不能仅凭名称猜测内容/);
  assert.equal(f.service.listTasks()[0].attachments[0].status,'unavailable');assert.equal(f.service.listTasks()[0].attachments[0].path,undefined);
});

test('the existing document tool can list and read original chat history files without replaying old messages',async t=>{
  let listed,read,invalid;
  const f=await fixture(t,{model:async input=>{
    const connection=input.settings.hostedProductConnection;assert.ok(connection);
    const call=async location=>{
      const response=await fetch(connection.endpoint,{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({id:randomUUID(),name:'xiaozhushou_read_document',args:{path:location}})});
      return response.json();
    };
    listed=await call('wechat://files');assert.equal(listed.isError,false,listed.content);
    const files=JSON.parse(listed.content).files;assert.equal(files.length,1);
    read=await call(files[0].readPath);invalid=await call('wechat://file/wechat_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/'+'c'.repeat(64));
  }});
  await f.service.saveWechatDshGrants({kind:'private',target:'101',grants:{skills:[],tools:['xiaozhushou_read_document']}});
  const docs=await writeOfficeDocument({workspace:f.root,title:'历史合同',blocks:[{type:'paragraph',text:'历史附件实际正文 907 元。'}],formats:['docx']});
  const file=f.reference('a'.repeat(64),'历史合同.docx',fs.readFileSync(docs.artifacts[0].path));
  f.history.push({message_id:'42',external_id:'e'.repeat(64),server_id:'9001',sender_id:'101',sender_name:'合成联系人',text:'[文件] 历史合同.docx',time:Math.floor(Date.now()/1000)-60,outgoing:false,message_type:'file',files:[file]});
  f.emit([],'请读聊天记录里的历史合同。');await f.finish();
  assert.equal(read.isError,false,read.content);assert.match(JSON.parse(read.content).text,/历史附件实际正文 907 元/);
  assert.equal(invalid.isError,true);assert.equal(f.service.listTasks().length,1);assert.equal(f.sends.length,1);
  const task=f.service.listTasks()[0];assert.ok(task.attachments.some(item=>item.source==='wechat-file'&&item.status==='provided'));
});
