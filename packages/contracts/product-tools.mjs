const string = (maxLength = 2000) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, parameters, computer = false) => ({ name: 'xiaozhushou_' + name, description, parameters, computer });

// These are product operations. Their implementation runs in the product service,
// under a short-lived task capability; incoming text never supplies the target.
export const PRODUCT_TOOLS = Object.freeze([
  tool('document', '生成真正可打开的 Word / PDF 文档并登记到本轮成果。提供标题和段落；生成后用 attachment 选择随回复交付的文件。', object({ title: string(160), blocks: { type: 'array', minItems: 1, maxItems: 1000, items: object({ type: { enum: ['heading', 'paragraph', 'bullet'] }, text: string(20000), level: { type: 'integer', minimum: 1, maximum: 3 } }, ['type', 'text']) }, formats: { type: 'array', items: { enum: ['docx', 'pdf'] }, minItems: 1, maxItems: 2 } }, ['title', 'blocks'])),
  tool('save_text', '保存本轮创作的文字、CSV 表格或引用文件，返回真实成果编号。只写本任务目录，不覆盖已有文件。', object({ name: string(100), text: string(200000) }, ['name', 'text'])),
  tool('read_document', '读取本任务资料目录中的文字、Word 或带文字层的 PDF；不能读取未授权的电脑路径。', object({ path: string(1000) }, ['path'])),
  tool('draw', '把你绘制的 SVG 插画、卡通、图表或示意图渲染为真实 PNG 图片。不使用付费图片接口。svg 仅含独立矢量图形和文字，不含脚本、外部资源或图片。返回成果编号，可用 attachment 发回本轮原会话。', object({ title: string(100), svg: string(200000) }, ['title', 'svg'])),
  tool('attachment', '选择本轮成果作为附件，随本轮成功回复交付原微信会话。此工具只登记待交付文件，不能指定收件人；未取得发送回执前不能声称已送达。', object({ artifactId: string(100), mediaType: { enum: ['image', 'file'] } }, ['artifactId', 'mediaType'])),
  tool('sticker', '列出当前原会话可用的微信原生表情，或选择其中一个随回复发送；不能自造表情编号或指定其他联系人。', object({ action: { enum: ['list', 'select'] }, id: string(64) }, ['action'])),
  tool('mail', '读取已连接的邮箱、收件列表或正文，或保存待主人核对的邮件草稿。没有直接发送接口。邮箱尚未连接时明确说明。', object({ action: { enum: ['accounts', 'inbox', 'read', 'draft'] }, accountId: string(100), messageId: string(100), to: { type: 'array', maxItems: 50, items: string(320) }, subject: string(500), text: string(100000) }, ['action'])),
  tool('screenshot', '截取当前电脑桌面并保存本轮 PNG 成果。只在主人已经为此私聊启用电脑权限时可用。需要发回时再调用 attachment。', object({} ), true),
  tool('list_local_dir', '列出主人授权电脑上的一个目录。只返回名称、类型和大小，不递归。', object({ path: string(1000) }, ['path']), true),
  tool('read_local_file', '读取主人授权电脑上的文本、Word 或 PDF 文件，有大小及文字上限。', object({ path: string(1000) }, ['path']), true),
  tool('write_local_file', '在主人授权电脑的已存在目录中新建文本文件；不会覆盖已有文件。', object({ path: string(1000), text: string(200000) }, ['path', 'text']), true),
  tool('run_local_shell', '在主人授权的本机运行一次 PowerShell 命令，有时间、输出和取消限制。仅处理当前用户要求的电脑任务，不得借此改变权限或向无关联系人发送信息。', object({ command: string(12000), timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 } }, ['command']), true),
  tool('export_file', '将主人授权的普通本地文件复制为本轮不可变成果，供 attachment 交付；仅电脑授权私聊可用。', object({ path: string(1000) }, ['path']), true),
]);
export const productTool = name => PRODUCT_TOOLS.find(tool => tool.name === name);
export const LEGACY_COMPUTER_TOOLS = Object.freeze({
  list_local_dir: 'xiaozhushou_list_local_dir', read_local_file: 'xiaozhushou_read_local_file',
  write_local_file: 'xiaozhushou_write_local_file', run_local_shell: 'xiaozhushou_run_local_shell',
  export_file: 'xiaozhushou_export_file', send_image: 'xiaozhushou_attachment',
});
