import {createHash} from 'node:crypto';
import {DOMParser} from '@xmldom/xmldom';

const children=(node,name)=>Array.from(node?.childNodes??[]).filter(child=>child.nodeType===1&&(!name||child.nodeName===name));
const child=(node,name)=>children(node,name)[0];
const value=(node,name)=>child(node,name)?.textContent?.trim()??'';
function xml(text){
  if(typeof text!=='string'||text.length>512000||/<!\s*(?:DOCTYPE|ENTITY)/i.test(text))throw Error('FILE_XML_INVALID');
  let invalid=false;const doc=new DOMParser({onError:()=>{invalid=true;}}).parseFromString(text,'text/xml');
  if(invalid||!doc.documentElement)throw Error('FILE_XML_INVALID');return doc.documentElement;
}
function record(node){
  if(children(node).length)return node;
  let text=node?.textContent?.trim()??'';
  for(let depth=0;depth<3;depth++){
    if(text.startsWith('<'))return xml(text);
    const decoded=xml('<record_decode>'+text+'</record_decode>').textContent;
    if(decoded===text)break;text=decoded;
  }
  return xml(text);
}
export function fileMetadataFromXml(text){
  try{
    const root=xml(text),app=root.nodeName==='appmsg'?root:root.nodeName==='msg'?child(root,'appmsg'):null;
    if(!app)return[];
    if(value(app,'type')==='6')return[{name:value(app,'title'),size:Number(value(child(app,'appattach'),'totallen'))}];
    if(value(app,'type')!=='19')return[];
    const files=[];let visited=0;
    function collect(node,depth){
      if(depth>3)return;
      const list=node?.nodeName==='datalist'?node:child(node,'datalist')??child(child(node,'recordinfo'),'datalist');
      for(const item of children(list,'dataitem')){
        if(++visited>50||files.length>=20)break;
        const kind=item.getAttribute('datatype')||value(item,'datatype');
        if(kind==='8')files.push({name:value(item,'datatitle')||value(item,'datadesc'),size:Number(value(item,'datasize'))});
        if(kind==='14'){const nested=child(item,'recordxml')??child(item,'recorditem');if(nested)collect(record(nested),depth+1);}
      }
    }
    const outer=child(app,'recorditem');if(outer)collect(record(outer),0);return files;
  }catch{return[];}
}
export function wechatFileReferences({account,talker,sourceId,metadata,coordinates={}}){
  if(!/^[a-f0-9]{64}$/.test(sourceId??''))return[];
  return(metadata??[]).slice(0,20).map((file,index)=>({
    id:createHash('sha256').update(JSON.stringify([account,talker,sourceId,index])).digest('hex'),
    name:file.name,size:file.size,index,sourceId,...coordinates,
  })).filter(file=>typeof file.name==='string'&&file.name.length>0&&file.name.length<=300&&!/[\\/\u0000-\u001f]/.test(file.name)&&Number.isSafeInteger(file.size)&&file.size>=0);
}
export function cleanWechatFiles(files){
  if(!Array.isArray(files))return[];
  return files.slice(0,20).filter(file=>/^[a-f0-9]{64}$/.test(file?.id??'')&&/^[a-f0-9]{64}$/.test(file.sourceId??'')&&Number.isInteger(file.index)&&file.index>=0&&file.index<20&&typeof file.name==='string'&&file.name.length>0&&file.name.length<=300&&!/[\\/\u0000-\u001f]/.test(file.name)&&Number.isSafeInteger(file.size)&&file.size>=0).map(({id,name,size,index,sourceId,localId,serverId,createTime})=>({id,name,size,index,sourceId,...(/^[1-9]\d{0,31}$/.test(String(localId??''))&&/^\d{1,32}$/.test(String(serverId??''))&&Number.isSafeInteger(createTime)?{localId,serverId,createTime}:{})}));
}
