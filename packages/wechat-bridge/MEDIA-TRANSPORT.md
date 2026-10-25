# 图片与文件发送的产品路径

入口为 `bridge.sendAttachment({kind,target,path,name,sha256,size,mime,deliveryId,mediaType})`。`mediaType` 为 `image` 或 `file`。默认 Hook 支持 PNG/JPEG 图片（8 MiB）及普通文件（50 MiB）。上层先将用户选择的内容保存为产品 `wechat/outgoing/wxatt_<32hex>/` 内的独立快照；桥接与原生层再次核对路径、文件、名称、大小和摘要。路径只留在本机，不进入公共状态。

## 默认 Hook 通道

`createWechatHookMediaRunner` 只接受字面 `http://127.0.0.1:端口` 及本地原生鉴权令牌。先核对 `mediaProtocol=xiaozhushou-native-media-v1` 和对应媒体能力，再通过 `beforeSubmit` 完成当前账号、会话授权、生命周期、目标映射及快照的最后检查。随后向同一微信进程的 `/SendImgMsg` 或 `/SendFileMsg` 提交一次结构化请求，不调用 UI，不要求目标聊天位于前台。

原生层使用本地安装清单指定产品根目录，HTTP 不能指定或改变此根目录。只接受经过核对的客户端版本、核心 DLL 摘要和唯一当前账号；共享原有发送互斥。每类最多保留 128 份快照句柄及原生异步对象引用，直到微信进程退出。超出边界明确拒绝。

原生入口和上层都有持久 deliveryId 防重记录。未知结果、冲突、损坏记录和中断都不会触发自动重放；已确认结果只复用既有回执。HTTP 200 或原生调用返回不代表送达，原生接收始终返回 `delivered:false`。

## 精确回执

桥接只接受目标会话数据库中的唯一新出站行：排除提交前 baseline，核对提交时间、当前身份、媒体类型与非零 serverId。图片要求原文件 MD5 匹配；文件要求 appmsg 类型 6、名称、大小及全部 `md5/filemd5` 值与快照匹配，兼容客户端实际的 `appmsg/md5` 字段。多个候选、缺少摘要或摘要冲突均保持未确认。

成功结果为：

```js
{
  receipt: 'wechat-server-id',
  delivered: 'database-confirmed',
  message_id: '实际 serverId 字符串',
  local_message_id: '本地行 ID 字符串',
  media_type: 'wechat-image' // 文件为 wechat-file
}
```

不使用文件类型或时间变化代替内容证据，也不会改换媒体类型重发。原生已明确证明未提交时，可标为拒绝；网络超时、取消及提交后的未知状态保留防重记录。

## 历史适配与验证范围

`runWechatAttachmentUi` 和固定 UI 脚本保留为历史适配，正常产品不会选择它，也没有自动回退。底层单独创建的 `createWechatMediaTransport` 若未提供 runner，会明确拒绝原生能力未就绪，不会偷偷控制桌面。

离线测试可注入可信 `mediaNativeRunner(request,{signal,beforeSubmit})`，必须调用一次最终授权，并返回已提交与目标核对标志。这是内部适配接口，不能由 MCP 或网页请求注入。

2026-10-25 已通过源码桥接默认 Hook 实发一个 640×360 PNG 与一个 103 字节 TXT，内容摘要及真实服务器回执均匹配，各只发送一次。TXT 的首次核验漏读 `appmsg/md5`，修正后只读核对同一条回执，原始未知账本保留，无重发。179 项相关合成回归与最终安装包关键内容核对通过。用户通过统一入口自行启动后，正式桌面、原数据和微信/DSH 连接均经只读核对；最终包 GUI 全流程、JPEG、大文件、其他格式、群聊及长期稳定性尚未实发验收。详见 [0.3.9 联调记录](../../docs/开发记录/20261025_0.3.9微信Hook附件联调.md)。
