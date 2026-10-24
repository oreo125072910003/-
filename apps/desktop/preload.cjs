const { contextBridge, ipcRenderer } = require('electron');

const methods = ['getBootstrap','listTasks','getTask','createTask','cancelTask','getSettings','saveSettings',
  'pickAttachments','openArtifact','openWorkspace','openContract'];
const api = Object.fromEntries(methods.map(name => [name,(...args) => ipcRenderer.invoke(`assistant:${name}`,...args)]));
api.onChange = callback => {
  if(typeof callback !== 'function')throw new TypeError('callback must be a function');
  const listener=()=>callback();ipcRenderer.on('assistant:change',listener);
  return()=>ipcRenderer.removeListener('assistant:change',listener);
};
contextBridge.exposeInMainWorld('assistant',Object.freeze(api));
