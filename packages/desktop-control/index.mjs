import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const binary = fileURLToPath(new URL('./bin/xiaozhushou-desktop.exe', import.meta.url)).replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
export function runDesktopHelper(request, { signal, executable = binary } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe','pipe','pipe'], signal });
    let bytes=0, output='', settled=false;
    const timer=setTimeout(()=>{child.kill();finish(Error('读取窗口超时，操作结果未知。请重新观察，不要重复提交。'));},15000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    child.on('error',error=>finish(Error(error.name==='AbortError'?'客户端操作已取消，请重新观察。':'客户端控制组件无法启动，请检查安装包。')));
    child.stderr.on('data',()=>{});
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>12*1024*1024){child.kill();finish(Error('客户端状态过大，请缩小窗口。'));}else output+=chunk;});
    child.on('close',()=>{if(settled)return;try{const result=JSON.parse(output);if(result.ok!==true)throw Error(result.error||'客户端操作失败，请重新观察。');finish(null,result.result);}catch(error){finish(error);}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
  });
}
const KEYS={CTRL:17,CONTROL:17,SHIFT:16,ALT:18,ENTER:13,RETURN:13,TAB:9,ESCAPE:27,ESC:27,SPACE:32,BACKSPACE:8,DELETE:46,HOME:36,END:35,PAGEUP:33,PAGEDOWN:34,LEFT:37,UP:38,RIGHT:39,DOWN:40};
export function desktopKeys(value){
  if(typeof value!=='string'||value.length>60)throw Error('按键无效。');
  const parts=value.toUpperCase().split('+');if(parts.length>4||new Set(parts).size!==parts.length)throw Error('按键组合无效。');
  const keys=parts.map(part=>KEYS[part]??(/^[A-Z0-9]$/.test(part)?part.charCodeAt(0):/^F(?:[1-9]|1[0-2])$/.test(part)?111+Number(part.slice(1)):undefined));
  if(keys.some(key=>key===undefined)||parts.includes('ALT')&&parts.includes('TAB')||parts.includes('CTRL')&&parts.includes('ALT')&&parts.includes('DELETE'))throw Error('不支持此系统按键组合。');
  return keys;
}
/** Per live task: immutable observed window identities, single-use short-lived snapshots. */
export function createDesktopController({ run=runDesktopHelper, now=Date.now }={}){
  const windows=new Map(),snapshots=new Map();let closed=false;
  async function execute(args,{signal,authorize=async()=>false}={}){
    if(closed||!await authorize())throw Error('本轮客户端权限已撤销。');signal?.throwIfAborted();
    if(args.action==='windows'){
      const result=await run({operation:'list'},{signal});windows.clear();snapshots.clear();
      return {windows:result.windows.map(window=>{const id=randomUUID();windows.set(id,window);return {windowId:id,title:window.title,app:window.process};})};
    }
    let request,previous;
    if(args.action==='observe'){
      previous=windows.get(args.windowId);if(!previous)throw Error('请先列出窗口，再使用实际返回的 windowId。');
      request={...previous,operation:'observe'};
    }else{
      const snapshot=snapshots.get(args.snapshotId);snapshots.delete(args.snapshotId);
      if(!snapshot||now()-snapshot.at>60000)throw Error('窗口观察已过期或已使用，请重新观察。');
      previous=snapshot.window;request={...previous,rect:snapshot.rect,operation:args.action};
      if(['click','scroll'].includes(args.action)){
        if(![args.x,args.y].every(Number.isFinite)||args.x<0||args.y<0||args.x>=snapshot.width||args.y>=snapshot.height)throw Error('坐标必须位于最近截图内。');
        request.screenX=snapshot.origin[0]+Math.round(args.x/snapshot.scale);request.screenY=snapshot.origin[1]+Math.round(args.y/snapshot.scale);
        if(args.action==='click'){request.button=args.button??'left';request.count=args.count??1;if(!['left','right'].includes(request.button)||![1,2].includes(request.count))throw Error('点击参数无效。');}
        else{if(!Number.isInteger(args.delta)||Math.abs(args.delta)>1200||args.delta===0)throw Error('滚动量应在 -1200 到 1200 之间。');request.delta=args.delta;}
      }else if(args.action==='type'){
        if(typeof args.text!=='string'||!args.text.length||args.text.length>2000||/[\x00-\x1f]/.test(args.text))throw Error('一次输入 1 至 2000 个普通字符；控制键请单独按。');request.text=args.text;
      }else if(args.action==='key')request.keys=desktopKeys(args.key);
      else throw Error('未知客户端操作。');
    }
    if(!await authorize())throw Error('本轮客户端权限已撤销。');
    const result=await run(request,{signal});signal?.throwIfAborted();if(!await authorize())throw Error('本轮客户端权限已撤销。');
    const snapshotId=randomUUID();snapshots.clear();snapshots.set(snapshotId,{...result,at:now()});
    // UIA bounds use physical pixels; present the same coordinate space as the image.
    const elements=(result.elements??[]).map(e=>({...e,x:Math.round(e.x*result.scale),y:Math.round(e.y*result.scale),width:Math.round(e.width*result.scale),height:Math.round(e.height*result.scale)}));
    return {snapshotId,title:result.window.title,width:result.width,height:result.height,elements,image:result.image,mime:result.mime,notice:'坐标相对当前截图；操作后检查新截图。输入结果不明时重新观察，不自动重试。'};
  }
  return {execute,close(){closed=true;windows.clear();snapshots.clear();}};
}
