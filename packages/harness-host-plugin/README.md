# 小助手 Harness 宿主插件

此插件安装在用户已经登录的 Harness 中，通过正式的 `ctx.agents`、`ctx.agentPresets`、`ctx.sessions` 服务运行。它不读取、复制或导出 Harness 账号凭据，不调用第二套模型 API。小助手拥有自己的原生会话标识、工作区、人格预设和产品会话映射；原微信会话不参与桌面对话。

## 准备与安装

主程序调用 `prepareHostedPluginInstall({productDataRoot, workspacesRoot, installDirectory, port:11234, provider:'deepseek-account', model:'deepseek-flash'})`。默认使用 DSH 已登录账号的 `deepseek-account` 提供方；裸名称 `deepseek` 不是当前 DSH 的已注册提供方。三个路径均为绝对路径，后两者必须经真实路径检查位于产品数据目录内。函数只生成产品文件，不更改 Harness profile。其返回的 `configFile` 可直接传给客户端的 `settings.hostedConfigFile`。

源目录的空补丁不能直接安装。应安装生成的 `installDirectory`：首选 Harness 正式插件管理器的本地 bundle 安装功能；正式 CLI 为 `dsh plugin --profile desktop add file:<installDirectory> --ignore-scripts`。CLI 使用自己的 profile 锁、兼容性检查和原子 manifest 保存，成功后会自动选择新的 bundle。启用 HMR 的 Harness 观察 profile manifest 并重组运行配置；CLI 安装成功本身不能证明已热生效。以本插件 `/health` 可访问、身份正确为准；若宿主报告需要重启，则完整退出托盘后正常重开。替换已加载包可能仍需重启。

本插件使用 DSH 提供的 `@deepseek-ai/dsh-llm`，两个 DSH 包均声明为可选 peer，最低支持 DSH `0.2.1-rc.3`。不在候选源目录安装另一份 DSH 公共包。生成补丁通过 `./entry-<revision>.mjs` 加载，正式安装后由 DSH 将它解析到已安装包内，使公共依赖进入 profile 的运行时解析；入口文件名和内部相对导入均带版本，以保留重载能力。返回的 `dependencySource` 为 `harness-runtime`。从旧版本升级时应通过正式插件管理器重新安装并完整重启，清理旧依赖由包管理器完成。插件管理器、CLI 或安装流程所报告的失败应保留，不用手工覆盖 profile 绕过。最后必须核对 `/health` 的 `pluginVersion`、`revision` 和所需能力，不能只看插件清单。

## HTTP 契约

仅监听 `127.0.0.1`，默认端口 `11234`。每次请求都需要产品令牌的 `Authorization: Bearer …`，精确 Host，且不能带浏览器 Origin 或 Sec-Fetch-Site。令牌保存在产品数据目录，接口不通过查询参数接受它。

- `GET /health`：协议标识 `xiaozhushou-harness-host-v1`、原生 provider/model、产品路径、活动任务数和模型是否完成过回复。健康检查没有模型调用，不能证明账号真实可用。
- `GET /catalog`：直接从原 Harness skills/tools 服务读取元数据，包含技能来源、可授权工具和授权契约。清单本身没有执行权限。
- `POST /tasks`：`{taskId?,prompt,workspace,sessionId?,conversation?,images?,personaPrefix?,authority?,ownerGrants?}`；返回任务回执，不等待模型完成。重复 taskId/相同内容不会重复入队，不同内容会拒绝；图片顺序、名称、大小和摘要也参与冲突检查。
- `GET /tasks/:id`：返回任务状态。只有匹配自身 session 和 turn 的 `turn/end completed`，且会话 flush 成功，才能返回成功文字。
- `DELETE /tasks/:id`：仅取消此产品任务拥有的 native agent。未收到结束确认时返回 `stop_unconfirmed`，保持会话锁，不声称已经停止。

任务只可继续产品 `harness-host/sessions.json` 中登记的 `xzs-<32 hex>` 会话，工作目录必须位于指定产品工作区。同会话仅一轮，宿主默认最多并行 3 轮。输出、请求体、超时和记录数均有上限。当前不会提供 token streaming 或自动收集模型写出的成果。

`images` 为最多 4 个 `{id,name?,mime,b64,sha256,bytes}`，每张最多 768 KiB，只接受 PNG/JPEG/WEBP 原始字节，拒绝路径和 URL。共享契约校验标准 Base64、精确长度、格式头和 SHA256；整个请求最多 5 MiB，文字仍独立限制为 256 KiB。安装器把共享校验模块复制进独立插件并更新所有相对导入的 revision。

`health.capabilities.images` 只有实际 `llm.resolveModelInfo(provider,model,signal)` 声明图片输入且原生 attachment 服务可用时才为 true，不根据模型名推断。图片交给原有 `attachments.saveImages/saveImage`，通过原生 image block 进入同一个 DSH agent。客户端遇到旧宿主会明确返回 `HOST_IMAGES_UNSUPPORTED`；产品微信入口据此给出“未提供画面”的文字说明，不假装看图。

宿主只在真实本轮 `turn/end` 后，对本轮可信 `user/message` 的图片位置追加 `image/offload` 并确认保存，然后释放会话。图片待清理标记先持久化；卸载或保存未确认的会话，即使宿主重启也会拒绝续聊。停止未确认时继续占用会话，不提前卸载仍在使用的图片。图片像素从后续模型上下文卸载，任务源图片快照与读取清单保留；这不是删除本机附件或实现全量聊天记忆。

`conversation` 可为 `{channel:'wechat'|'desktop'|'mail',displayName?:string}`，仅用于显示分类和标题，不能指定路径、会话 ID、工具或授权。原生 `workspaceRegistry` 按已经校验的真实 `workspace` 路径查找或创建工作空间，再用 `attachSession` 校验会话 `header.cwd` 后归类。续聊复用已有原生会话和工作空间，保留已有组名及会话标题；归档会话不自动恢复。微信等持续会话应由产品为每个会话保持固定目录，例如 `tasks/conversations/wechat_<hash>`；成果文件仍可保存在独立任务目录。新建标题如“小助手 · 微信 · 测试联系人”，采用 75 字节 Unicode 安全截断；插件不向 stdout 输出联系人名称。最终任务回执可包含原生 `groupId`，映射保存在产品的 `harness-host/sessions.json`。分类不可用或未确认保存时，本轮不会提交模型消息。

## 复用原技能和插件

默认工具清单为空，执行 guard 拒绝全部工具。产品在可信设置中明确指定：

```js
settings.hostedOwnerGrants = {
  skills: ['office-docx'],
  tools: ['准确的原 Harness 插件工具名']
};
```

客户端转换为 `authority:'product-owner'` 和 `ownerGrants`。这是产品与本地桥接之间的能力边界，不能从模型回复、微信消息、邮件正文或检索网页提取授权。令牌属于受信任的产品进程；不能交给外部消息发送者。微信原生 preset 和本产品 owner preset 完全分离。

技能通过 scoped `xiaozhushou_skill` 调用原 `skills.get`，读取原正文和其 references 内的有限文字文件，不复制成假技能，不运行技能脚本。技能的指令不能增加工具授权。工具使用原宿主 schema/实现，仅把本轮指定的名称展示给模型并在执行时再次检查；管理插件、Shell、任意文件、子 agent、run_code 等系统控制工具在此版本仍拒绝。每轮最多 32 次工具执行和 6 次技能正文读取。结束后移除本轮授权和 loader；下一轮必须重新提供授权。旧历史内容不会扩大当前权限。

`settings.personaPrefix`（或 `persona`）通过 owned agent 的正式 `systemPrompt.section` 挂载，作用于当前模型任务，任务结束撤销；它与工具执行 guard 相互独立。

## 验证边界

`tests/runtime-hosted.test.mjs` 使用真实回环 HTTP 和可控的原生服务模拟验证客户端/服务器、原生终态匹配、取消隔离、权限、技能读取、persona section 和 Windows junction 路径。此离线测试不消费模型、不会触及个人 `.dsh` 或旧 WeChatAgent。真实安装、模型完成、原技能文档工作流程、插件可视元数据及每种 MCP 的真实操作必须分别记录，不能从模拟测试推断通过。
