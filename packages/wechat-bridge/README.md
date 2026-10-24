# 产品微信通信适配

本模块复用现有 `代码/项目/scripts/hook-onebot.mjs` 的账号/版本校验、消息规范化、白名单和文本发送回执，不调用旧适配器的 `start()`，也不启动它的 HTTP 服务、OneBot WebSocket 或另一个 WeChatAgent 程序。

```js
const bridge = createWechatBridge({ onMessage, onState, onError });
await bridge.start({
  dataDir: absoluteProductWechatDirectory,
  readerBaseUrl: 'http://127.0.0.1:实际端口',
  hookBaseUrl: 'http://127.0.0.1:30001',
  readerToken, nativeToken,
  allowedPrivate: ['数字会话ID'], allowedGroups: [],
  nickname: '小助手', expectedVersion: '4.1.10.27',
});
await bridge.sendText({ kind: 'private', target: '数字会话ID', text, deliveryId: sha256Id });
await bridge.stop();
```

凭据只通过产品凭据存储注入内存，不写 legacy 配置文件。文本发送状态位于产品 `dataDir/state/text-deliveries/`，保存发送内容与原生账号关联，用于收到回执后复用、结果未确认时防止重复提交。它属于私人产品数据，不应提交或打包。

`start` 先完成原生健康和账号检查，返回 connecting；SSE 建立并再次检查账号后，`onState` 发出 ready。读信源和原生发送器必须已经在本机运行，本模块不会下载、注入或自动启动它们。仅接受字面地址 `http://127.0.0.1:端口`。当前发送器支持的匹配微信版本仍是 `4.1.10.27`，不绕过兼容性校验。

消息回调得到 `{self_id, kind, conversation_id, conversation_name, sender_id, text, message_id, sender_name, time}`。ID 均为数字字符串，time 为 Unix 秒数；消息和错误不输出原始账号 wxid。收信仅转交白名单中的新消息，过滤本人发送，并在重连期间保持有界的会话级去重。只有回调持久化成功才进入去重表；回调失败会明显报错并停收，手动重连后同一消息仍有资格保存。应用重启后的去重由产品持久化层继续保证。

`getProfile()` 先读取原组件 native `POST /GetSelfProfile`；用户当前的 `scripts/native-hook` 自建运行实现没有该路由，收到 404 时会用 reader `/api/v1/contacts` 查询精确匹配 ownWxid 的本人记录。返回 `{id,name,wxid,alias,source:'native'|'reader-contact'}`，只保留本人的实际昵称与账号标识，不返回电话、邮箱或地区。其 wxid 必须与已核验 reader 的 ownWxid 一致，查询前后均核对账号。`onState` 和 `getStatus()` 的 `account` 使用同一对象，便于界面显示当前登录者；无法读取时返回 `account:null` 与 `profileError`，不会用“小助手”等配置昵称冒充微信昵称。当前源码没有可验证的头像字段，因此不伪造头像 URL。

`getDirectory({kind:'private'|'group',keyword:'',limit:100})` 使用 reader `/api/v1/contacts` 只读元数据接口，返回 `{kind,contacts:[{id,kind,name,ambiguous,allowed}]}`。包含未授权候选，便于按好友/群名勾选；返回数字会话 ID，不暴露原始好友和群 wxid。重复映射会标记 ambiguous。它不会授予授权，也不读取历史消息；上层应阻止勾选 ambiguous 行。

连接状态为 `offline | connecting | ready | error`，并含 `detail`（稳定错误代码）、`accountVerified`、`readerConnected`，核对成功后带数字 `selfId`。SSE 断开会重连，发送不会自动重试。账号一旦发生变化，连接会锁定至再次手动 start，阻止继续收发。发送每次仍走原生账号复核与微信数据库 serverId 回执；HTTP 接受并不代表成功送达。

SSE、JSON、单条消息和去重集合有大小上限，网络请求有超时。`stop` 取消尚在健康检查中的启动请求及连接，并等待自己的启动、循环与发送结束；取消后的启动不会再变成 ready。错误回调只提供稳定代码，不输出后端地址、令牌或原始账号。回调处理超时不会阻止断开。

## 离线验证

`node --test tests/wechat-transport.test.mjs` 使用真实 localhost HTTP/SSE 替身，覆盖收信、去重、重连、白名单、发送回执、未确认发送防重、断开、换号、发送前账号核对、版本与 URL 限制和事件大小。未向真实微信发送消息，真实客户端联调尚待完成。

## 打包依赖

除本目录外，基础通信使用现有程序中的以下公开代码；扩展的会话/媒体功能依赖见[功能迁移对照](功能迁移对照.md)，不复制整个旧运行目录：

- `代码/项目/package.json`（`.js` 的 ESM 范围声明）
- `代码/项目/scripts/hook-onebot.mjs`
- `代码/项目/scripts/text-delivery-store.mjs`
- `代码/项目/scripts/wechat-account-check.mjs`
- `代码/项目/scripts/reader-account-state.mjs`
- `代码/项目/components/qq-bridge/src/core/wechat-events.js`
- `代码/项目/components/qq-bridge/src/core/sticker-policy.js`
- `代码/项目/components/qq-bridge/src/core/proactive-policy.js`

没有第三方 npm 依赖。旧 `HookOneBot` 的可选 `configuration` 只在产品构造时使用；未传入时保留原有配置文件读取路径和启动行为。

产品控制器现已接入会话目录、实际历史入库、图片手动读取、表情候选/手动发送以及无来信时直接向选定授权会话发送。主动提交使用 `request_` 加 UUID 的稳定 requestId，保存 outbox 后才交给 transport，重复提交会复用记录；原生回执未确认时不自动重发。数据库版本 3 事务迁移保留版本 2 的旧消息与发送记录，并允许直接发送的 outbox 不关联入站消息。不会为直接发送伪造一条入站消息。
