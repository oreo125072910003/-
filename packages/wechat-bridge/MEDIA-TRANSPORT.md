# 图片与文件发送的产品路径

入口为 `bridge.sendAttachment({kind,target,path,name,sha256,size,mime,deliveryId,mediaType})`。
`mediaType` 是 `image` 或 `file`；图片上限 8 MiB，文件上限 50 MiB。
上层必须先把用户选择的内容保存为产品 staging 中的不可变副本，传入真实绝对路径；桥接会再次核对普通文件、真实路径、名称、大小和 SHA256。路径只进入本机子进程，不进入公共状态或发送账本。

本实现不调用当前运行环境中返回 404 的普通图片 Hook 路由，不修改旧微信运行目录，不启动另一个微信服务。产品自有 `send-attachment-ui.ps1` 参考了 `代码/pcbridge/send_wechat_native.ps1` 的文件剪贴板流程，移除了重试、标题检查旁路、裸坐标点击和额外回车发送。

默认路径需要用户先打开目标微信聊天，微信 UIAutomation 能读取准确标题、空白输入区、新附件预览名称和发送按钮。目标名称还必须在 reader 当前映射及不限定私聊/群聊的全局联系人结果中唯一；已知备注、昵称、历史群名别名也参与查重，最多 100 条的搜索结果触顶时拒绝。私聊与群同名不能按会话类型过滤后放行 UI。相同检查在最终粘贴授权前再次执行。不能读取或无法唯一核验时明确报错；不会把“找到一个窗口”作为目标证据，也不会清空已有草稿。UI 操作期间窗口会临时置顶，结束后恢复；进程级全局发送闸门与 Windows 命名 mutex 防止附件 UI 并发。

发送前先保存一次性 deliveryId 账本。UI 子进程准备好后，通过标准输入请求 Node 的最后一次账号、授权、生命周期、目标映射和文件完整性核验，得到一次授权才粘贴一次、调用发送按钮一次。取消会终止子进程并等待其退出。账本已存在时，只复用已确认结果；其他状态均不自动重新提交。

子进程退出成功或界面显示发送不等于送达。桥接只接受目标会话数据库中的新出站行，排除提交前 baseline，核对提交时间、当前账号、媒体类型与非零 serverId。图片还需原文件 MD5 精确匹配；文件需 MD5、名称、大小全部匹配。多个候选不归因给这次发送。成功返回：

```js
{
  receipt: 'wechat-server-id',
  delivered: 'database-confirmed',
  message_id: '实际 serverId 字符串',
  local_message_id: '本地行 ID 字符串',
  media_type: 'wechat-image' // 文件为 wechat-file
}
```

UI 不可读取、同名歧义、客户端重编码图片使 MD5 改变，或者 reader 没有完整媒体 XML/MD5，都会拒绝或保持“待核对”。不会用文件类型、时间变化或旧截图代替内容证据；也不会悄悄改换媒体类型重发。原图选项、UI 缩放、微信窗口内容及各图片格式的实际客户端行为尚未真实验收。

离线测试使用注入的 `mediaNativeRunner(request,{signal,beforeSubmit})`；该回调必须调用一次 `beforeSubmit()`，并返回 `{submitted:true,targetChecked:true,windowChecked:true}`。它是内部可信适配接口，不是 MCP 或网页可传入的代码。正常产品使用固定脚本。

`tests/wechat-media-transport.test.mjs` 覆盖内容证据、摘要损坏、上限、重复提交、重启抑制、账号与目标变化、撤销授权、全局互斥、最终回执账号核验和 bridge 接线，并覆盖真实本人昵称的群 @ 唤醒。全部是合成替身，不向真实联系人发送。
