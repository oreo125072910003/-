# 受控原生图片路由：离线协议验证

本次只增加主工程自有的 `/SendImgMsg` 路由和离线探针，不修改上游源码、原运行目录、桌面服务或已发布包，不安装 DLL、不启动微信、不实际外发。

**生产能力仍不可用。** `/WeChatAgent/health` 固定返回 `nativeImageSend:false` 和 `imageSendStatus:"IMAGE_NATIVE_ABI_UNVERIFIED"`。通过鉴权的图片请求返回 HTTP 503、`IMAGE_NATIVE_ABI_UNVERIFIED`；这条生产路径在读取图片、创建目录和写投递记录之前结束。没有环境变量、请求字段或运行配置可以启用合成发送器。

## 为什么不能直接调用上游 SendImage

已审读的上游为 `components/WeChat-Hook/UPSTREAM.json` 记录的提交 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6`，本次未修改该来源代码。

- `src/wx_send.cpp:268` 用 `SetWeixinStringU` 设置 UTF-16 路径，接着第 269—270 行又以 UTF-8 `imgPath.size()` 覆盖长度和容量。中文和补充平面字符的长度不同，不能作为安全的中文路径实现直接复用。
- `src/wx_send.cpp:384` 的 `SendImage` 返回 `void`，构造中存在未核验的图片 vtable、结构偏移及分配/所有权假设。可执行地址与版本号都不能证明布局、异步对象生命周期或投递完成。
- 上游 `src/SendImageMsg.cpp` 的路由没有本产品要求的鉴权/账号检查，调用后直接报告 `ret:0`。现有构建仅注册 `RegisterWeChatAgentRoutes`，本次没有启用上游路由。

因此生产代码没有调用 `WeixinSend::SendImage`，也没有把编译成功当作原生 ABI 验收。

## 已验证的受控请求边界

路由复用现有 token 鉴权与全局 `sendMutex`，与文字、表情发送共用互斥。支持的请求形状为：

```json
{
  "wxidorgid": "wxid_synthetic",
  "path": "C:\\product-data\\wechat\\outgoing\\wxatt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\image.png",
  "name": "image.png",
  "size": 16,
  "sha256": "64位小写十六进制摘要",
  "mime": "image/png",
  "deliveryId": "64位小写十六进制投递标识"
}
```

示例仅说明字段，不是可发送的真实图片或有效摘要。账号来自 `X-WeChatAgent-Account`，不能放进请求体自行声明。

在合成驱动中，公共 C++ 路由执行以下真实检查：

1. token、精确 `4.1.10.27` 版本、唯一且匹配的当前账号；取得互斥锁后及读取快照后再核验账号。
2. 固定字段、目标标识、投递 ID 和 SHA256 格式，不接受额外字段或客户端能力开关。
3. 驱动预先指定的绝对产品目录；图片只能位于 `wechat/outgoing/wxatt_<32 hex>/<name>`。生产驱动没有可用根目录或发送实现；未来必须通过受信任的安装流程指定，不能由 HTTP 请求选择。
4. 严格 UTF-8 转 UTF-16，拒绝 NUL、相对/UNC/设备路径、路径穿越、替代数据流、路径组件末尾点和空格。逐级打开并锁定目录，拒绝 reparse point、junction 和非普通文件。
5. 最多 8 MiB、确切长度、SHA256、文件名、扩展名及 PNG/JPEG 签名相符。此版本只验证格式签名，未执行真实解码，不能据此声明任意 PNG/JPEG 均可由微信接受。
6. 文件句柄禁止写入、删除和替换；合成提交后保留完整路径句柄链至 Hook 进程结束，防止异步读取期间快照变化。每个进程最多保留 128 份。

PNG/JPEG 是本次协议测试的最小格式集合。GIF、WebP、BMP 的原生输入语义未验证，不扩充声明。

## 原生边界的一次投递记录

投递记录位于驱动产品根目录的 `wechat/native-image-deliveries/`，键由当前账号与 `deliveryId` 的 SHA256 构成。记录只保存版本、投递 ID、请求指纹和状态，不保存图片路径或目标名称。

该记录的独立用途是：**在未来原生提交边界阻止 HTTP 超时、Hook 进程重启或调用方重放引起的第二次提交**。上层服务记录不能证明原生函数是否已进入；因此必须在实际原生调用之前，以 `CREATE_NEW`、`FlushFileBuffers` 写入 `unknown` 预留。不会通过删除损坏或未知记录来恢复重试。当前生产能力关闭，此目录不会被生产图片请求创建。

- 相同 ID、相同请求且原记录为 `accepted`：仅返回之前的接收状态，`reused:true`，不再次调用驱动。
- 相同 ID、不同请求：`IMAGE_DELIVERY_CONFLICT`，不提交。
- 已有 `unknown`、损坏或无法读取的记录：保守拒绝，`attempted:true`，`retryable:false`，不提交。
- 驱动返回不确定或进程在预留之后崩溃：保留 `unknown`，重启后也拒绝重放。
- 驱动接收：原子更新为 `accepted`。若更新失败，之前的 `unknown` 仍阻止重放。

`ret:0/retmsg:accepted` 只表示驱动已接收，响应始终包含 `delivered:false`，不会提供伪造的服务器 ID。未来图片客户端必须理解这些状态，不能套用旧文字通道把 HTTP 400/409 一概解释为“确认未发送”；结果不确定时禁止自动重试、换 ID 或切换 UI 通道重发。真正送达仍须用新增、目标相符、媒体摘要相符且含非零服务器 ID 的数据库记录确认。

## 构建与测试证据（2026-10-25）

在 Windows、Visual Studio 2022 v143 工具链执行：

```powershell
node --test tests/native-hook-image.test.mjs
```

实际结果：9 项通过，0 项失败，0 项跳过，约 18 秒。

测试在系统临时目录 `xzs-native-image-*` 中分别编译：

- 不定义 `WECHATAGENT_IMAGE_PROBE` 的生产条件源码，链接至无微信调用的已有 probe；核验能力关闭、503 拒绝和零持久写入。
- 定义 `WECHATAGENT_IMAGE_PROBE` 的专用探针；真实路由、Win32 文件锁、BCrypt SHA256、持久文件和回环 HTTP 均参与测试，提交回调仅记录合成审计行。未知结果和崩溃由合成回调制造。

覆盖鉴权、版本/多账号、字段校验、中文及 emoji 路径、文件被锁、摘要/大小/签名/名称不符、越界路径、junction、投递冲突、并发一次提交、已接收重用、未知及崩溃后重启、最终账号变化、损坏记录。临时 EXE、图片、控制文件、审计行及账本在结束后清理。

未覆盖：真实微信 ABI、图片构造器/对象所有权/线程约束、中文路径的真实客户端读取、图片解码与重编码、服务器回执、真实安装/升级/降级，以及掉电条件下的磁盘持久性。没有生成或部署生产 DLL；生产条件源码能链接探针不等于整个微信 DLL 或真实发送通过验收。

## 下一步允许启用前必须补齐

先在产品自有实现中修正 Unicode 字符串构造并验证原生图片布局、分配/生命周期和提交返回语义；在本机受控验收中检查中文路径、实际媒体和数据库回执。之后再设计受信任的产品根目录安装配置、实现真实驱动和客户端状态处理，完成独立评审后才能将 `nativeImageSend` 改为可用。原生文件发送尚无已核验 ABI，本次不增加 `/SendFileMsg`。
