const fault=(code,attempted=false)=>Object.assign(Error(code),{code,attempted});

/** Authenticated native media calls share the running Hook's send mutex. */
export function createWechatHookMediaRunner({baseUrl,token,fetchImpl=fetch,timeoutMs=20000}) {
  const origin=new URL(baseUrl);
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!/^[a-f0-9]{64}$/.test(token??''))throw fault('WECHAT_ATTACHMENT_HOOK_UNAVAILABLE');
  async function request(route,options,signal) {
    const response=await fetchImpl(origin.origin+route,{...options,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)].filter(Boolean))});
    return {ok:response.ok,status:response.status,data:await response.json()};
  }
  return async (value,{signal,beforeSubmit}={})=>{
    if(typeof beforeSubmit!=='function'||!['image','file'].includes(value?.mediaType))throw fault('WECHAT_ATTACHMENT_ARGUMENT_INVALID');
    const headers={Authorization:'Bearer '+token,'X-WeChatAgent-Account':value.account};
    const health=await request('/WeChatAgent/health',{headers},signal);
    if(!health.ok||health.data?.mediaProtocol!=='xiaozhushou-native-media-v1'||health.data[value.mediaType==='image'?'nativeImageSend':'nativeFileSend']!==true)throw fault('WECHAT_ATTACHMENT_HOOK_UNAVAILABLE');
    signal?.throwIfAborted();
    await beforeSubmit();
    signal?.throwIfAborted();
    let response;
    try {
      response=await request(value.mediaType==='image'?'/SendImgMsg':'/SendFileMsg',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({
        wxidorgid:value.targetWxid,path:value.path,name:value.name,size:value.size,sha256:value.sha256,mime:value.mime,deliveryId:value.deliveryId,
      })},signal);
    }catch{throw fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED',true);}
    const result=response.data;
    if(!response.ok||result?.ret!==0){
      if(result?.ret===1&&result.attempted===false&&/^IMAGE_[A-Z0-9_]+$/.test(result.error??''))throw fault('WECHAT_ATTACHMENT_HOOK_REJECTED');
      throw fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED',true);
    }
    if(result.attempted!==true||result.delivered!==false||result.deliveryId!==value.deliveryId||typeof result.reused!=='boolean')throw fault('WECHAT_ATTACHMENT_DELIVERY_UNCONFIRMED',true);
    return {submitted:true,targetChecked:true,windowChecked:true};
  };
}
