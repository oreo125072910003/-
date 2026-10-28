# 小助手与微信 DSH 插件 1.1.4

这是原“小助手 Harness 宿主插件”的完整形态，同一个插件里运行小助手服务、DSH 会话连接和工作台界面。微信、任务、邮箱、能力中心和人格设置复用主工程代码。它不会启动另一个小助手 EXE 或 WeChatAgent 自动回复程序。

完整版还包含专用微信 **4.1.10.27**、匹配的连接组件、Python 3.13 与读取依赖，可复制到新 Windows x64 电脑安装。DSH 核心仍由用户在新电脑安装并登录；首次装插件需要联网，由 DSH 安装 JavaScript 依赖。插件包不含原电脑的微信账号、令牌、密钥或聊天数据。

DSH 会话标题栏新增“小助手 · 微信”，设置中也有“小助手与微信”。打开后在 DSH 内使用原工作台；“返回 DSH”收起面板，已开启的微信连接继续工作。完整退出 DSH 会关闭插件服务。

## 安装

在 DSH 的正式插件管理器里安装本地 `xiaozhushou-harness-host-1.1.4.tgz` 或其解压后的包目录。完整版位于 `dist/dsh-plugin/1.1.4-full`；轻量包位于 `dist/dsh-plugin/1.1.4`。插件沿用原宿主插件包名，更新它即可，不需要同时安装两份。正式命令为：

```powershell
dsh plugin --profile desktop add file:<插件包绝对路径> --ignore-scripts
```

缺少正式 CLI 时使用 DSH 插件管理器，不手改 profile。插件是否生效以小助手入口、插件状态和 `/health` 的 1.1.4 / `native-assistant-1.1.4` 为准；宿主要求重启时，从托盘完整退出后重开 DSH。

默认查找当前 Windows 用户已有的小助手数据库（包括原启动器造成的目录重定向），只有没有原数据时才使用 `AppData/Roaming/XiaoZhuShou`。发现多份数据会要求明确原路径，不合并或覆盖。也可在包的 `cordis.patch.yml` 第一项 `config` 中指定：

```yaml
productDataRoot: '现有小助手数据目录的绝对路径'
wechatSourceDirectory: '现有微信环境目录的绝对路径'
port: 11234
provider: deepseek-account
model: deepseek-flash
```

这台电脑的原数据目录须以 `config/desktop-install.local.json` 为准，不能因为启动环境重定向而新建空白数据。切换前通过托盘正常退出旧小助手。插件遇到原软件持有的数据锁会保留数据并提示，下一次打开操作会重试；不会强制夺取数据锁或结束进程。

已有连接继续沿用原来准备好的专用微信。新电脑首次打开小助手时，点击右下角“新电脑 · 连接微信”，依次：

1. **准备专用微信**：校验每个组件的摘要，将可写运行环境放在新电脑的小助手数据目录；生成新的本机令牌，保留空的会话授权名单。
2. **打开微信**：打开包内的匹配版本，由用户扫码或手机确认登录，等待聊天同步。存在另一版微信时提示用户正常退出，不强制结束。
3. **识别已登录账号**：选择当前专用微信登录的账号。
4. **验证并连接**：实时核对账号，再使用原有连接验证流程；若提示等待密钥，需要在专用微信退出账号再登录。凭据使用新电脑当前 Windows 用户加密保存。
5. 到微信页选择允许回复的聊天，再手动开启自动回复。首次连接只自动恢复连接，不自动授权聊天或开启回复。

组件安装在产品自己的 `wechat-environment` 中，插件更新不会覆盖已生成的本机令牌或账号状态。此向导用于首次连接；已有连接通过原微信页维护。

## 保留的能力

- 微信账号核验、联系人、会话、历史、图片、文件、表情与允许会话内的自动回复。
- DSH 持续会话、任务与成果、资料整理、文献检索、DOCX/PDF 导出和分步骤协作。
- 多账号 IMAP/SMTP 邮箱、原 Skill/MCP 管理和合同工具。
- 任务资料及微信附件选择、导入文件/文件夹、打开成果、附件另存等 Windows 本机操作。
- 原 Windows 加密凭据可读取；不导出 DSH 账户，不要求重填核心 API Key。

自动回复仍受原会话授权与人工接管规则约束，加载面板不会主动发送测试微信。新插件不能恢复尚未迁入主工程的旧功能；具体范围见 `packages/wechat-bridge/功能迁移对照.md`。

## 构建与验证

在主工程运行 `npm run package:dsh:full` 生成可供新电脑安装的完整版；`npm run package:dsh` 生成复用已有微信环境的轻量包。两种产物都包含可安装 TGZ、可审查目录、包清单与 SHA256。构建采用源码和组件白名单，检查分发文件不含个人配置、凭据或运行数据；完整版专用微信只取不可变的程序及版本资源目录，排除相邻账号令牌和媒体路径配置。合同 EXE 复用现有已构建产物；JavaScript 依赖由 DSH 正式包管理器安装。

运行 `node --test tests/dsh-plugin.test.mjs tests/portable-wechat.test.mjs` 与原工程检查。`node scripts/check-portable-wechat.mjs` 验证完整包在空目录初始化、Python 模块和原生连接组件加载；`node scripts/smoke-dsh-plugin.mjs --full` 验证打包后的向导与原产品页面；`node scripts/verify-dsh-plugin.mjs --full` 用官方 CLI 在隔离 profile 中实际安装、启动并从真实 DSH 入口打开嵌入面板。

全新目录初始化与真实新电脑微信登录是不同的验收。离线服务、界面、真实 DSH 安装、账号连接、真实外发分别记录，不能用模拟通过代替真实收发验收。

插件接入使用 DSH 官方的 [Web Server 路由](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)及本机已安装版本的客户端插槽契约。
