const { contextBridge, ipcRenderer } = require('electron');

const methods = ['getBootstrap','listTasks','getTask','getTaskReplyText','createTask','cancelTask','getSettings','saveSettings','getWorkflowsState','exportTaskDocument',
  'pickAttachments','openArtifact','openWorkspace','openContract',
  'getWechatState','importWechatConnection','saveWechatSettings','connectWechat','disconnectWechat','draftWechatReply','sendWechatReply','searchWechatContacts','refreshWechatProfile',
  'getWechatSessions','getWechatHistory','resolveWechatImage','getWechatStickers','sendWechatMessage','sendWechatSticker','pickWechatAttachments','sendWechatAttachment','importLegacyExtensions','refreshDshCatalog',
  'getMailState','importMailAccounts','importMailAccountsFile','syncMail','getMailMessage','createMailDraft','sendMailDraft','resolveMailAttachment','saveMailAttachment','draftMailReply',
  'getDshAccessState','refreshDshAccessCatalog','saveDshOwnerGrants','setDesktopComputerAccess','restoreProductFeatures',
  'getWechatDshAccess','saveWechatDshGrants','importWechatDshGrants','saveWechatComputerAccess',
  'getExtensionsState','importMcpManifest','installBuiltinMcp','enableMcp','disableMcp','testMcp','setMcpTools',
  'importSkill','importBundledSkill','enableSkill','disableSkill'];
const api = Object.fromEntries(methods.map(name => [name,(...args) => ipcRenderer.invoke(`assistant:${name}`,...args)]));
api.onChange = callback => {
  if(typeof callback !== 'function')throw new TypeError('callback must be a function');
  const listener=()=>callback();ipcRenderer.on('assistant:change',listener);
  return()=>ipcRenderer.removeListener('assistant:change',listener);
};
contextBridge.exposeInMainWorld('assistant',Object.freeze(api));
