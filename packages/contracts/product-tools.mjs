const string = (maxLength = 2000) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, parameters, computer = false) => ({ name: 'xiaozhushou_' + name, description, parameters, computer });

// These are product operations. Their implementation runs in the product service,
// under a short-lived task capability; incoming text never supplies the target.
export const PRODUCT_TOOLS = Object.freeze([
  { ...tool('improve', '主人专用的记忆、技能与插件自我完善。先 action=state 查看现有内容，再 action=propose 提出修改。operation 支持 memory.set/delete、skill.save/enable/disable/rollback、plugin.install/upgrade/enable/disable/tools/rollback。payload：记忆用 {text}；技能用 {content}，须是带 name、description、metadata.version 的完整 SKILL.md；插件安装/升级用现有本机固定版本配置，工具选择用 {allowedTools}。本工具只创建提案并在绑定微信私聊征求批准，没有批准或执行入口，不能把口头同意当批准。', object({ action: { enum: ['state', 'propose'] }, operation: string(40), target: string(64), reason: string(350), payload: object({ text: string(1200), content: string(2200), name: string(128), version: string(80), source: string(1024), transport: { enum: ['stdio'] }, command: string(4096), args: { type: 'array', items: string(4096) }, allowedTools: { type: 'array', items: string(128) }, permissions: { type: 'array', items: string(128) }, envRefsJson: string(4096), timeoutMs: { type: 'integer' } }) }, ['action'])), ownerOnly: true },
  tool('document', '生成真正可打开的 Word / PDF 文档并登记到本轮成果。提供标题和段落；生成后用 attachment 选择随回复交付的文件。', object({ title: string(160), blocks: { type: 'array', minItems: 1, maxItems: 1000, items: object({ type: { enum: ['heading', 'paragraph', 'bullet'] }, text: string(20000), level: { type: 'integer', minimum: 1, maximum: 3 } }, ['type', 'text']) }, formats: { type: 'array', items: { enum: ['docx', 'pdf'] }, minItems: 1, maxItems: 2 } }, ['title', 'blocks'])),
  tool('save_text', '保存本轮创作的文字、CSV 表格或引用文件，返回真实成果编号。只写本任务目录，不覆盖已有文件。', object({ name: string(100), text: string(200000) }, ['name', 'text'])),
  tool('read_document', '读取本任务资料目录中的文字、DOCX、XLSX 或带文字层的 PDF。微信任务也可用 path=wechat://files 列出原会话的历史附件，再用列表返回的 readPath 读取文件；不能指定其他聊天或未授权电脑路径。', object({ path: string(1000) }, ['path'])),
  tool('draw', '把你绘制的 SVG 插画、卡通、图表或示意图渲染为真实 PNG 图片。不使用付费图片接口。svg 仅含独立矢量图形和文字，不含脚本、外部资源或图片。返回成果编号，可用 attachment 发回本轮原会话。', object({ title: string(100), svg: string(200000) }, ['title', 'svg'])),
  tool('attachment', '选择本轮成果作为附件，随文字说明交付原微信会话。artifactId 选择一份，或 artifactIds 一次选择多份（最多 12 份），两者只填一个。只登记待交付文件，不能指定收件人；最终仍须输出简明正文，未取得发送回执前不能声称已送达。', object({ artifactId: string(100), artifactIds: { type: 'array', minItems: 1, maxItems: 12, items: string(100) }, mediaType: { enum: ['image', 'file'] } }, ['mediaType'])),
  tool('sticker', '列出当前原会话可用的微信原生表情，或选择其中一个随回复发送；不能自造表情编号或指定其他联系人。', object({ action: { enum: ['list', 'select'] }, id: string(64) }, ['action'])),
  tool('mail', '读取已连接的邮箱、收件列表或正文，或保存待主人核对的邮件草稿。没有直接发送接口。邮箱尚未连接时明确说明。', object({ action: { enum: ['accounts', 'inbox', 'read', 'draft'] }, accountId: string(100), messageId: string(100), to: { type: 'array', maxItems: 50, items: string(320) }, subject: string(500), text: string(100000) }, ['action'])),
  tool('screenshot', '截取当前电脑桌面并保存本轮 PNG 成果。只在主人已经为当前桌面任务或此私聊启用电脑权限时可用。需要发回时再调用 attachment。', object({} ), true),
  tool('desktop', '操作本机 Windows 客户端窗口。先 action=windows 列出窗口，使用返回的 windowId 执行 observe，读取截图与控件；再用最新 snapshotId 执行一次 click/type/key/scroll，并检查返回的新截图。坐标相对截图。窗口移动、状态过期或结果不明时重新 observe，不能重放旧操作。键支持 Ctrl+A、Tab、Enter、Escape、方向键等。type 只输入普通文字，凭据由主人手动填写；不用于系统安全设置、终端或 ChatGPT。', object({ action:{enum:['windows','observe','click','type','key','scroll']},windowId:string(100),snapshotId:string(100),x:{type:'number'},y:{type:'number'},button:{enum:['left','right']},count:{type:'integer',minimum:1,maximum:2},text:string(2000),key:string(60),delta:{type:'integer',minimum:-1200,maximum:1200} },['action']),true),
  tool('browser', '操作主人通过 Playwright 扩展允许的现有 Edge/Chrome 标签页，可使用已登录的 ChatGPT 网页聊天或生成图片，无需 API Key。先 action=tools 读取真实参数，再 tabs/snapshot 查看页面，按当前 ref 点击或输入。遇扩展未安装、连接确认或登录验证时明确请主人处理，不能声称已接通。下载的图片会登记为本轮成果；生成完成并拿到真实图片后才可称成功，再用 attachment 交付。', object({ action: { enum: ['tools','tabs','snapshot','navigate','click','type','press_key','wait_for','fill_form','select_option','hover','take_screenshot'] }, args: { type: 'object' } }, ['action']), true),
  tool('list_local_dir', '列出主人授权电脑上的一个目录。只返回名称、类型和大小，不递归。', object({ path: string(1000) }, ['path']), true),
  tool('read_local_file', '读取主人授权电脑上的文本、DOCX、XLSX 或 PDF 文件，有大小及文字上限。', object({ path: string(1000) }, ['path']), true),
  tool('write_local_file', '在主人授权电脑的已存在目录中新建文本文件；不会覆盖已有文件。', object({ path: string(1000), text: string(200000) }, ['path', 'text']), true),
  tool('run_local_shell', '在主人授权的本机运行一次 PowerShell 命令，可完成当前明确要求的软件检查、构建、安装或升级等任务，无需另有名为 agent 的工具。有时间、输出和取消限制，不得扩大授权或向无关联系人发送信息。', object({ command: string(12000), timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } }, ['command']), true),
  tool('export_file', '将主人授权的普通本地文件复制为本轮不可变成果，供 attachment 交付；仅已启用电脑能力的桌面任务或私聊可用。', object({ path: string(1000) }, ['path']), true),
]);
export const productTool = name => PRODUCT_TOOLS.find(tool => tool.name === name);
export const LEGACY_COMPUTER_TOOLS = Object.freeze({
  list_local_dir: 'xiaozhushou_list_local_dir', read_local_file: 'xiaozhushou_read_local_file',
  write_local_file: 'xiaozhushou_write_local_file', run_local_shell: 'xiaozhushou_run_local_shell',
  export_file: 'xiaozhushou_export_file', send_image: 'xiaozhushou_attachment',
});
