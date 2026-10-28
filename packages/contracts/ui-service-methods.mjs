// Shared service operations exposed by both trusted product interfaces.
// Native file dialogs remain adapter-specific; internal service methods never
// become public merely because the service gained a new function.
export const UI_SERVICE_METHODS = Object.freeze([
  'getBootstrap','listTasks','getTask','getTaskReplyText','createTask','cancelTask','getSettings','saveSettings','getWorkflowsState','exportTaskDocument',
  'getWechatState','saveWechatSettings','connectWechat','disconnectWechat','draftWechatReply','sendWechatReply','searchWechatContacts','refreshWechatProfile',
  'getWechatSessions','getWechatHistory','resolveWechatImage','getWechatStickers','sendWechatMessage','sendWechatSticker','sendWechatAttachment','importLegacyExtensions','refreshDshCatalog',
  'getMailState','saveMailNotifications','importMailAccounts','syncMail','getMailMessage','createMailDraft','sendMailDraft','resolveMailAttachment','draftMailReply',
  'getDshAccessState','refreshDshAccessCatalog','saveDshOwnerGrants','setDesktopComputerAccess','restoreProductFeatures',
  'getWechatDshAccess','saveWechatDshGrants','importWechatDshGrants','saveWechatComputerAccess',
  'getExtensionsState','configureSelfImprovement','proposeSelfImprovement','installBuiltinMcp','enableMcp','disableMcp','testMcp','setMcpTools','importBundledSkill','enableSkill','disableSkill'
]);

export const PORTABLE_WECHAT_METHODS = Object.freeze([
  'getPortableWechatState','preparePortableWechat','openPortableWechat','discoverPortableWechat','bindPortableWechat'
]);
