# 小助手扩展核心

本包提供产品自己的 MCP 注册、诊断、桌面工具调用及 Skill 导入管理，使用 `yaml@2.9.1` 解析标准元数据。它没有替换 Harness 推理循环，也没有声称当前 sdk-only Harness 已获得 MCP 原生工具执行能力。

## 已可用的内容

- 本地已安装程序的 stdio JSON-RPC：initialize → initialized → tools/list → tools/call。固定接受 `2025-11-25`、`2025-06-18`、`2025-03-26` 三个协议版本。当前真实离线夹具验证了 `2025-11-25`；另外两个保留相同受限工具子集，尚无第三方产品实测。
- 单连接的请求编号、分页去重、32 项并发上限、超时、取消通知、断线失败和自有进程停止。返回上限 1 MiB，请求上限 256 KiB，工具最多 256 个。stderr 只计有界字节数，不留正文。
- 业务 `isError:true`、协议错误和格式不正确的结果均不会变成成功。取消、超时、断连不能证明外部动作撤回，结果显示 unknown；不自动重试。
- 注册后默认停用；启用不立即执行代码，测试或调用才启动。重启后保留启用设置但不自动启动插件。停用使后续步骤被拒绝并停止当前连接。升级和回退保留三份配置历史，结果均回到停用状态。
- 固定版本、可执行文件和入口脚本 SHA-256，启动前校验变更。只启动绝对路径的现有程序，不运行动态 npx 安装；`.cmd/.bat/.ps1/.sh` 包装器暂不作为可执行入口。
- 环境允许清单与安全凭据引用；不自动继承宿主 API key、NODE_OPTIONS、个人 Harness home。凭据由宿主安全存储在启动时解密，不写扩展注册表。
- Skill YAML、名称与目录一致、来源版本、依赖能力、权限和执行器清单。导入复制到产品目录，默认停用；加载正文与资源时重新校验内容哈希。
- 越界资源、符号链接、宿主专有 API、机器绝对路径、缺失引用及工具依赖有诊断。脚本只作为资料导入，本包没有脚本执行入口。
- 八个内置工作方法：材料写作、合同资料、邮件分类、文献检索、文献综述、项目跟进、文件整理、成果检查。缺少依赖的工作方法保持不可用，不以数量冒充已接通的能力。

## 服务集成

```js
import { createExtensionManager } from './packages/extensions/index.mjs';

const extensions = await createExtensionManager({
  dataDir: '产品数据目录/extensions 的完整路径',
  authorize: async (trustedContext, request) => {
    // 服务按真实桌面身份、账号、资源范围和已存在授权判断。
    // 不能让模型或 renderer 传 source:'owner' 就获得授权。
    return policyAllows(trustedContext, request);
  },
  secretResolver: async (secretRef, { pluginId, environmentKey }) => vault.get(secretRef),
  availableCapabilities: () => ['agent.text', 'files.organize'],
});
```

授权回调必须严格返回 `true`；默认拒绝所有需要授权的动作。只读元数据 `listMcp/listSkills/listBundledSkills` 不启动代码。

MCP 接口为 `installMcp(config, context)`、`enableMcp(id, context)`、`testMcp(id, context)`、`callMcp(id, tool, args, context, {signal, timeoutMs})`、`setMcpTools(id, tools, context)`、`disableMcp`、`upgradeMcp(id, replacement, context)`、`rollbackMcp`、`close()`。

配置示例：

```json
{
  "id": "contract",
  "name": "合同工具",
  "version": "2.3.0",
  "source": "xiaozhushou-reviewed-build",
  "transport": "stdio",
  "command": "C:\\Program Files\\XiaoZhuShou\\合同助手MCP.exe",
  "args": ["--data-dir", "C:\\Users\\Example\\AppData\\Roaming\\XiaoZhuShou\\contract"],
  "allowedTools": ["contract_schema", "contract_preview"],
  "permissions": ["artifact.create"],
  "envRefs": {}
}
```

具体工具名以真实握手为准。`allowedTools` 默认空清单；列出工具不自动授权。`permissions` 是需求声明，执行前再次由真实策略回调检查。账号、路径和出站收件人还必须由对应执行端校验。

Skill 接口为 `inspectSkill(directory, context)`、`importSkill(directory, {version,source}, context)`、`importBundledSkill(id, context)`、`enableSkill/disableSkill`、`loadSkillContext(id, context)`、`readSkillResource(id, relative, context)`、`removeSkill`。`loadSkillContext` 返回 `{text, id, version, digest, requiredCapabilities, requestedPermissions, authority:'none-data-only'}`；可以作为当前 Harness 文本任务的工作方法资料，不得用它扩大运行 profile 的权限。

技能标准 `metadata` 仍是字符串映射。产品专用依赖写在同目录 `assistant.json`：

```json
{"requiredCapabilities":["agent.text"],"permissions":[],"executors":["harness-text"]}
```

## 明确的边界与待办

当前不开放 HTTP/SSE、OAuth、resources/prompts/sampling/elicitation、自动重连重放、自动下载或插件内脚本执行。服务器 ping 请求按协议回复，其余未知服务器请求回复 Method not found；服务器 instructions 不进入模型上下文。JSON Schema 使用有界子集；尚不支持 `$ref`、组合与 pattern 等规则的工具显示不可调用，不能跳过校验。

这里是**受信任插件的应用级管理**，不是 Windows OS 沙箱。已安装插件以当前用户运行，可能拥有当前用户的文件和网络权限；allowedTools 不能限制恶意程序在启动时的行为。Windows 停止使用持有的 PID 和 taskkill 自有进程树，普通程序应按 stdio EOF 清理自己的子进程；父进程退出后自行脱离的后台程序仍需后续 Job Object/受限账号支持。未完成这一层前不得宣称不受信任插件隔离已完成。

任务书 T13 的鉴权 HTTP 验收尚未完成，T16 的通用脚本执行与宿主工具移植尚未完成。本包不把这些任务整体标为完成。

## 验证与协议来源

`node --test tests/extensions.test.mjs`：18 项离线测试，实际启动 Node stdio 服务器夹具，无真实外部账号、消息或付费模型调用。

2026-10-25 对照官方原文核查：

- [MCP 2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP Tools / Error handling](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Agent Skills specification](https://agentskills.io/specification)

普通模型工具执行未来应继续复用 Harness 的 MCP 客户端，并由产品网关提供当前任务的精确权限；本包的连接与桌面诊断结果不能当作 Harness 已实测接入的证据。
