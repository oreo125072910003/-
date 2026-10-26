// Synthetic localhost backend, instantiated only by the explicit desktop smoke run.
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

exports.createWechatSmoke=async function(directory){
  const source=path.join(directory,'synthetic-wechat-source');
  const clients=new Set(),rows=[];
  const readerToken='desktop-smoke-reader-not-real',nativeToken='c'.repeat(64);
  let sends=0;
  const server=http.createServer(async(request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    const native=['/WeChatAgent/health','/SendTextMsg','/GetSelfProfile'].includes(url.pathname);
    const json=(value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    if(request.headers.authorization!=='Bearer '+(native?nativeToken:readerToken))return json({},401);
    if(url.pathname==='/api/v1/reader/status')return json({success:true,backend:'weflow-cli-nt',selfEvents:'account-conversation-v1',ownWxid:'wxid_synthetic_desktop_self',accountDirectory:'wxid_synthetic_desktop_self'});
    if(url.pathname==='/WeChatAgent/health')return json({integration:'WeChatAgent-1',backend:'wechat-hook',version:'4.1.10.27',startupState:'ready',databaseAccounts:['wxid_synthetic_desktop_self'],nativeStickerSend:true});
    // The actual reviewed scripts/native-hook build has no GetSelfProfile route.
    // Exercise the exact-self contact fallback rather than an invented endpoint.
    if(url.pathname==='/api/v1/contacts'){
      const keyword=url.searchParams.get('keyword')??'';
      const contacts=[{username:'wxid_synthetic_desktop_self',displayName:'离线验收登录用户'},
        {username:'wxid_synthetic_desktop_friend',displayName:'离线验收联系人',conversationId:101}];
      return json({success:true,contacts:contacts.filter(item=>(item.username+item.displayName).includes(keyword))});
    }
    if(url.pathname==='/api/v1/sessions')return json({sessions:[{username:'wxid_synthetic_desktop_friend',displayName:'离线验收联系人',conversationId:101}]});
    if(url.pathname==='/api/v1/messages')return json({messages:rows});
    if(url.pathname==='/api/v1/stickers')return json({stickers:[]});
    if(url.pathname==='/api/v1/push/messages'){
      response.writeHead(200,{'content-type':'text/event-stream'});response.write(': synthetic stream\n\n');clients.add(response);request.on('close',()=>clients.delete(response));return;
    }
    if(url.pathname==='/SendTextMsg'){
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw);sends++;
      rows.push({localId:sends,serverId:String(90000+sends),localType:1,isSend:true,createTime:Math.floor(Date.now()/1000),fullText:body.msg,senderUsername:'wxid_synthetic_desktop_self',senderDisplay:'离线验收登录用户'});
      return json({ret:0});
    }
    json({},404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  fs.mkdirSync(path.join(source,'config'),{recursive:true});fs.mkdirSync(path.join(source,'state','hook'),{recursive:true});
  fs.writeFileSync(path.join(source,'config','wechatagent.json'),JSON.stringify({runtime:{sender:'wechat-hook',weflowMode:'nt'},ports:{weflow:server.address().port},hook:{baseUrl:base,expectedVersion:'4.1.10.27'},wechat:{whitelist:{private:['101'],groups:[]}}}));
  fs.writeFileSync(path.join(source,'state','wechat-io-config.json'),JSON.stringify({reader_base_url:base,reader_token:readerToken}));
  fs.writeFileSync(path.join(source,'state','hook','native-token.txt'),nativeToken);
  return{source,get sends(){return sends;},emit(){
    const row={localId:7000001,serverId:'97000001',localType:1,isSend:false,createTime:Math.floor(Date.now()/1000),senderUsername:'wxid_synthetic_desktop_friend',senderDisplay:'离线验收联系人',fullText:'这是一条本机离线验收消息，请确认材料已收到。'};
    if(!rows.some(item=>item.localId===row.localId))rows.push(row);
    const rawid=crypto.createHash('sha256').update(JSON.stringify(['wxid_synthetic_desktop_friend',row.serverId,row.localId,row.createTime])).digest('hex');
    const value={event:'message.new',type:1,content:row.fullText,sessionId:'wxid_synthetic_desktop_friend',talkerId:'wxid_synthetic_desktop_friend',conversationId:101,rawid,sourceName:'离线验收联系人',timestamp:row.createTime};
    for(const client of clients){client.write('data: '+JSON.stringify(value)+'\n\n');client.write('data: '+JSON.stringify(value)+'\n\n');}
  },async close(){for(const client of clients)client.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
};
