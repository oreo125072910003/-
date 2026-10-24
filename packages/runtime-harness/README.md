# 小助手 Harness 适配器

本包是 Harness 的进程与协议适配层，不另写模型推理循环。首个支持组合固定为 **Harness 0.2.1-rc.2 + sdk profile + 本包的仅对话安全补丁**。没有第三方 npm 依赖。

## 已完成的真实验证（2026-10-25）

- 本机安装的正式命令 `F:\deepseek harness\resources\runtime\cli\bin\dsh.cmd`：`--version` 返回 `0.2.1-rc.2`，`--help` 正常。它是 Desktop 安装的公开命令包装器。本包不调用其内部 `app.asar` 模块。
- 用两个全新临时 `DSH_HOME`/重复同一专用 home 启动标准 sdk profile，叠加安全补丁后发送 `initialize`，收到 `deepseek-harness-sdk-runtime / 0.0.1`，再 `shutdown`，正常退出。
- 以上体检没有提交 `session/prompt`，没有调用付费模型，没有读取、复制或修改个人 `.dsh` 凭据及配置。
- 默认配置与本机提供器实现核验：`deepseek-official` / `deepseek-flash` 可在无密钥状态完成初始化；**初始化通过不等于账号可用**。
- 离线协议进程测试覆盖文本归属、会话恢复、异常退出、超时、取消、环境隔离及失败状态。真实模型输出、usage、真实会话跨进程恢复尚未调用付费服务验证。

## 接口

```js
import { inspectRuntime, runTask, probeRuntimeConnection } from './index.mjs';

const settings = {
  executable: '已安装的 dsh 命令绝对路径',
  home: '小助手自己的产品数据目录/harness-home',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  persona: '版本化的助手人格正文',
  // 由宿主的安全存储临时解密；不要将以下对象保存或打印到普通配置文件。
  env: { DEEPSEEK_API_KEY: '用户明确配置的 key' },
};

const detected = await inspectRuntime(settings); // 版本/路径检测，不执行模型。
const probe = await probeRuntimeConnection(settings); // 初始化/关闭，不发送 prompt。
const result = await runTask({
  prompt: '拟一个工作安排草稿',
  workspace: '专用工作目录',
  settings,
  signal: abortController.signal,
  onEvent: ({ type, message }) => {},
});
// 保存 result.sessionId；后续提供相同 home/workspace/sessionId 恢复原会话。
```

宿主字段 `runtimeCommand` / `runtimeHome` / `runtimeProfile` 可分别作为 `executable` / `home` / `profile` 的别名，`personaPrefix` 也可作为 `persona` 的别名。显式 `args` 只允许一个受信任的绝对 JS 启动模块路径（测试可用 Node + 模拟进程脚本），不得包含 profile、模型或任务参数；UI 不应把它作为模型可写参数。

发现顺序为显式 executable、`XIAOZHUSHOU_DSH_COMMAND`、机器本地的 `config/runtime-locations.json` 中 `harnessCommand`、PATH、历史工程配置的公开程序位置及标准安装目录。机器本地位置文件仅含程序路径，可由打包程序写入；不需要携带历史个人配置。历史配置仅用于开发迁移发现，不是产品发布的依赖。

`inspectRuntime()` 的 available 只表示命令和版本可读取；ready/modelVerified 保持 false。credentialsConfigured 仅表明显式 key 或独立 home 中凭据文件存在，不读取凭据内容、不验证有效性。只有任务实际返回有效回答后，应用才能显示“本轮 AI 调用成功”。

`runTask()` 返回 `{ ok, finalText, sessionId?, usage?, artifacts?, error? }`，错误含稳定 code 和可读 message。仅将相同 session 的已提交 `assistant/message` 折叠为最终文本，收到 `session/wait` 完成并验证 `turn/end` 后才算成功。收到的完整回答通过 text 事件通知；当前没有逐 token 渲染。usage 仅汇总 `assistant/message.data.usage` 中的提供器报告，不估算价格；缺少报告时省略。

## 独立 home、账号和工具边界

- 默认 home 为当前用户 LocalAppData 下的 `小助手/harness-home`。宿主应传自己的产品数据目录。拒绝个人 `.dsh` 和它的子目录，包括指向它们的目录链接。
- 不自动复制个人账号、模型配置或已有聊天。由宿主把用户手动输入的 key 加密保管，任务期间以 `settings.env.DEEPSEEK_API_KEY` 注入；本包不会将 key 写入 home、人格补丁或产品设置。
- 可显式传 `DEEPSEEK_BASE_URL`。**该提供器使用 Anthropic Messages 格式**，默认根为 `https://api.deepseek.com/anthropic`，不能将通用 OpenAI `/v1` 地址直接当作可用 endpoint。其他厂商路由需要单独适配和验收。
- 子进程环境只继承必要 OS/路径/代理变量，再合并显式 env；不继承上层 agent 的 API key、Node 注入参数或个人 Harness 环境。强制独立 DSH_HOME、关闭遥测、只读权限模式，最大 token 截断不算成功。
- 本版本 SDK 未提供产品可接管的审批和单 turn cancel，因而关闭 shell、文件工具、web、子 agent、workflow、自动发现全机技能和工作区 AGENTS 注入等执行入口。人格由系统提示配置注入。现阶段不能因程序能聊天就宣称 MCP、Skill、微信、邮件或电脑操作已接通。
- 只允许标准 sdk bundle 组合；非空 home/profile 用户补丁会被拒绝，避免绕过固定工具策略。MCP/Skill 需接入真实执行端的权限控制后再新增受审查 profile。
- 这是应用级能力限制，**不是 OS 文件或网络沙箱**；受信任的 CLI/插件代码本身仍以当前 Windows 用户运行。

每次任务拥有独立运行进程，同一 home/session 同时只允许一项本进程内任务。取消或超时时先结束 stdin，再终止本任务仍存活的进程；Windows 必要时仅按持有的 PID 关闭对应进程树，不按名称结束其他 Harness。清理后无法确认进程退出会返回独立错误，不宣称正常完成。意外工具/子 agent 事件会中止任务，但这不能回滚已经产生的外部副作用。

## 检查命令与参考

在工程根目录使用可用 Node 运行 `node --test tests/runtime-harness.test.mjs tests/runtime-service-integration.test.mjs`。本轮 **25 项通过**：包括适配器协议测试、恢复历史不混入当前回答、打包后的虚拟 app.asar/丢失工作区不会阻断版本检测、Windows cmd 路径及 prompt 字符处理、忽略 EOF 的进程树强制退出，以及本地服务→适配器→成果/存储的完整模拟集成。模拟测试不访问网络。首次真实 AI 调用仍需用户配置账号，后续验收应单列真实文本、恢复、usage 和终止结果。

- [Harness 0.2.1-rc.2 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/apps/cli/README.md)
- [同版本 SDK wire protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/protocol/README.md)
- [同版本 TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/client/README.md)

上游协议版本目前固定 `0.0.1`，不提供兼容协商。本包不把 master 分支的新审批或取消能力当成本机版本已有功能；升级需要复验并调整版本支持表。
