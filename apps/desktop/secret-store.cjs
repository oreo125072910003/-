const fs=require('node:fs');
const path=require('node:path');

exports.createSecretStore=function({dataDir,safeStorage}){
  const filename=path.join(dataDir,'secrets.protected.json');
  let pending=Promise.resolve();
  function read(){
    if(!fs.existsSync(filename))return Object.create(null);
    if(fs.statSync(filename).size>65536)throw Error('凭据文件异常，请检查数据目录。');
    const value=JSON.parse(fs.readFileSync(filename,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(item=>typeof item!=='string'))throw Error('凭据文件格式异常，原文件保留。');
    return Object.assign(Object.create(null),value);
  }
  async function available(){return typeof safeStorage.isAsyncEncryptionAvailable==='function'?await safeStorage.isAsyncEncryptionAvailable():safeStorage.isEncryptionAvailable();}
  function save(data){const temporary=filename+'.tmp';const fd=fs.openSync(temporary,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);}
  const serialize=fn=>{const operation=pending.then(fn);pending=operation.catch(()=>{});return operation;};
  const encrypt=async value=>Buffer.from(typeof safeStorage.encryptStringAsync==='function'?await safeStorage.encryptStringAsync(value):safeStorage.encryptString(value)).toString('base64');
  return{
    get:name=>serialize(async()=>{
      const data=read(),value=data[name];if(!value)return null;
      if(!await available())throw Error('Windows 凭据保护暂不可用，密钥没有解密。');
      if(typeof safeStorage.decryptStringAsync!=='function')return safeStorage.decryptString(Buffer.from(value,'base64'));
      // Electron's async API returns { result, shouldReEncrypt }, not a string.
      const decrypted=await safeStorage.decryptStringAsync(Buffer.from(value,'base64'));
      if(!decrypted||typeof decrypted.result!=='string')throw Error('系统没有返回有效的解密结果。');
      if(decrypted.shouldReEncrypt){data[name]=await encrypt(decrypted.result);save(data);}
      return decrypted.result;
    }),
    set:(name,value)=>serialize(async()=>{
      if(typeof value!=='string')throw Error('凭据必须是文本。');
      if(!await available())throw Error('系统凭据保护不可用，未保存密钥。');
      const data=read();data[name]=await encrypt(value);save(data);
    }),
    delete:name=>serialize(async()=>{const data=read();delete data[name];save(data);})
  };
};
