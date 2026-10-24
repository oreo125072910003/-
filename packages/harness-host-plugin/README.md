# 小助手 Harness 宿主插件

此插件安装在用户已经登录的 Harness 中，通过正式的 `ctx.agents`、`ctx.agentPresets`、`ctx.sessions` 服务运行。它不读取、复制或导出 Harness 账号凭据，不调用第二套模型 API。小助手拥有自己的原生会话标识、工作区、人格预设和产品会话映射；原微信会话不参与桌面对话。

## 准备与安装

主程序调用 `prepareHostedPluginInstall({productDataRoot, workspacesRoot, installDirectory, port:11234, provider:'deepseek', model:'deepseek-flash'})`。三个路径均为绝对路径，后两者必须经真实路径检查位于产品数据目录内。函数只生成产品文件，不更改 Harness profile。其返回的 `configFile` 可直接传给客户端的 `settings.hostedConfigFile`。

源目录的空补丁不能直接安装。应安装生成的 `installDirectory`：首选 Harness 正式插件管理器的本地 bundle 安装功能；正式 CLI 为 `dsh plugin --profile desktop add file:<installDirectory> --ignore-scripts`。CLI 使用自己的 profile 锁、兼容性检查和原子 manifest 保存，成功后会自动选择新的 bundle。启用 HMR 的 Harness 观察 profile manifest 并重组运行配置；CLI 安装成功本身不能证明已热生效。以本插件 `/health` 可访问、身份正确为准；若宿主报告需要重启，则完整退出托盘后正常重开。替换已加载包可能仍需重启。

本插件依赖 `@deepseek-ai/dsh-llm@0.2.0-rc.2`。安装器按正常依赖机制解析，不复制旧项目的 node_modules。包无构建脚本。插件管理器、CLI 或安装流程所报告的失败应保留，不用手工覆盖 profile 绕过。

## HTTP 契约

仅监听 `127.0.0.1`，默认端口 `11234`。每次请求都需要产品令牌的 `Authorization: Bearer …`，精确 Host，且不能带浏览器 Origin 或 Sec-Fetch-Site。令牌保存在产品数据目录，接口不通过查询参数接受它。

- `GET /health`：协议标识 `xiaozhushou-harness-host-v1`、原生 provider/model、产品路径、活动任务数和模型是否完成过回复。健康检查没有模型调用，不能证明账号真实可用。
- `GET /catalog`：直接从原 Harness skills/tools 服务读取元数据，包含技能来源、可授权工具和授权契约。清单本身没有执行权限。
- `POST /tasks`：`{taskId?,prompt,workspace,sessionId?,personaPrefix?,authority?,ownerGrants?}`；返回任务回执，不等待模型完成。重复 taskId/相同内容不会重复入队，不同内容会拒绝。
- `GET /tasks/:id`：返回任务状态。只有匹配自身 session 和 turn 的 `turn/end completed`，且会话 flush 成功，才能返回成功文字。
- `DELETE /tasks/:id`：仅取消此产品任务拥有的 native agent。未收到结束确认时返回 `stop_unconfirmed`，保持会话锁，不声称已经停止。

任务只可继续产品 `harness-host/sessions.json` 中登记的 `xzs-<32 hex>` 会话，工作目录必须位于指定产品工作区。同会话仅一轮，宿主默认最多并行 3 轮。输出、请求体、超时和记录数均有上限。当前不会提供 token streaming、图片或自动收集模型写出的成果。

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
