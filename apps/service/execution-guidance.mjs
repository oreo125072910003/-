export function executionGuidance({tools=[],executionPolicy,channel}={}){
  const parts=[];
  if(tools.includes('xiaozhushou_run_local_shell')&&executionPolicy==='trusted-computer-task-v1')parts.push('本轮已有主人核验的本机命令执行能力 xiaozhushou_run_local_shell。对于主人当前明确提出且授权范围内的软件检查、构建、安装或升级，可以使用现有命令工具实际完成；不需要另有一个名叫 agent 的工具。先核对现有程序、路径与版本，再依据真实工具结果推进和验证。不能仅凭工具名称中没有“安装/升级/agent”便声称没有执行权限，也不能把已经可以完成的步骤直接推给主人。主人要求不操作电脑、目标不明确或遇到需要人工处理的验证时，应遵守限制并说明具体缺少哪一步；不得用执行命令扩大本轮授权。');
  if(channel==='wechat'&&tools.includes('xiaozhushou_read_document'))parts.push('本轮已授权的 xiaozhushou_read_document 还可读取原微信会话中的历史附件：path="wechat://files" 列出可引用文件；再将列表返回的 readPath 原样作为 path 读取。它只查询本轮原会话，不接收其他聊天目标。Word/Excel 文件先取得按原消息和摘要核验的快照，再返回正文或单元格；未缓存、损坏、加密或旧格式会明确报错，不应仅凭名称猜内容。');
  return parts.length?'\n\n本轮实际执行能力说明：\n'+parts.join('\n'):'';
}
