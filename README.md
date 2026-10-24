# 小助手 DSH

> **0.3 开发预览版（2026-10-25）**：XP 风格桌面，按工作、通信和管理分类；支持微信账号昵称、好友与群、会话历史和回复，多账号 IMAP/SMTP 邮件插件，Skill 迁移、MCP 管理、协作流程、Word/PDF 成果与文献检索。当前电脑使用已更新的桌面“小助手预览版”快捷方式，可以继续原有数据；构建后入口为 `dist/releases/0.3.0/小助手-win32-x64/小助手.exe`。详见 [0.3 开发与实际验收](docs/开发记录/20261025_0.3开发与验收.md)。

**小助手的核心始终是 DSH。** 面向主人的名字、人格、对话、任务组织和最终交付均属于小助手 DSH。默认复用现有 Harness 登录，无需重复填写核心 API Key；其他模型和 agent 是辅助能力。额外 API 当前可保存配置，实际调用入口还在开发。

最终自动测试 188 项通过，最终 EXE 桌面流程验收通过；真实 DSH 回复与微信账号、昵称和联系人只读连接已验证。真实邮箱登录、微信外发、长期记忆和主动提醒等仍须继续完成，不把界面入口或替身测试当作全部功能验收。40 项任务的实际状态见 [任务书进度核对](docs/开发记录/20261025_任务书进度核对.md)。

开发：`npm ci`、`npm run check`、`npm test`、`npm start`；Windows 发布：`npm run package`。首次接入 Harness 参照 [宿主插件说明](packages/harness-host-plugin/README.md)。源码仓库不包含账号凭据、聊天、邮件、个人配置或构建产物。

> **产品开发规划（2026-10-25）**：[先读这个](docs/开发规划/2026-10-25/00_先读这个.md)。包含产品目标、系统架构、现有代码审查和 40 项开发任务；实现状态以上面的最新验收记录为准。

> **当前开发入口（2026-10-25）**：本目录 `G:\CodexProjects\小助手` 已被指定为小助手后续开发主工程，已从 `G:\claude\_review_extract_20261024` 整体迁入，主要源码在 `代码\项目`，电脑桥接在 `代码\pcbridge`。开发约定见 [AGENTS.md](AGENTS.md)。下文保留原整理资料，其中 Junction 和外部运行目录的描述属于历史环境，使用前需重新核实。桌面整合新增文件、构建及真机验收状态以本地检查结果为准。

> 整理于 2026-10-24。本文件夹是「总入口」，下面的子项都是**目录链接（Junction）**，指向真实位置，
> 不占额外空间；真实文件仍在原处，移动/删除本文件夹不会影响程序。

## 一、整体链路

```
手机/电脑微信  ⇄  挂载版微信客户端 4.1.10.27（hook 端口 30001）
                    ⇄  OneBot 适配器 hook-onebot.mjs（11229）
                    ⇄  社交桥 social-bridge.js + DSH 插件（11230）
                    ⇄  DSH 桌面端（DeepSeek Harness，跑模型/工具）
                    ⇄  电脑桥接 MCP pcbridge（8765）+ 合同助手 MCP
```

## 二、目录对照（本文件夹 → 真实位置）

| 本文件夹里的名字 | 真实位置 | 说明 |
|---|---|---|
| `01_WeChatAgent主程序` | `G:\wechat-deepseek\app` | WeChatAgent.exe 桌面客户端（1.4 GB） |
| `02_项目与数据` | `G:\wechat-deepseek\data\workspace` | **运行中的项目本体**：config / roles / scripts / state / logs |
| `03_Python运行时` | `G:\wechat-deepseek\data\runtimes` | 项目自带的 Python 3.13 |
| `04_电脑桥接pcbridge` | `F:\deepseek工作区\wechat-pc-bridge` | 电脑桥接 MCP 服务（8765）、微信发送脚本、看门狗 |
| `05_DSH桌面端` | `F:\deepseek harness` | DeepSeek Harness 主程序（跑小助手的大脑） |
| `06_DSH配置与插件` | `C:\Users\ADMIN\.dsh` | DSH 的 profile、会话、插件、技能、表情包 |
| `07_合同助手` | `C:\Users\ADMIN\Documents\电脑管理\contract-helper` | 合同助手 MCP 与桌面版 |
| `08_微信数据` | `F:\wx file` | 微信聊天数据库（10.8 GB，别乱动） |

## 三、必须知道的路径

- 主程序：`G:\wechat-deepseek\app\WeChatAgent.exe`
- 项目工作区：`G:\wechat-deepseek\data\workspace`
  - 主配置：`config\wechatagent.json`（账号、白名单、工具授权、人格）
  - 人格：`roles\小助手.md`
  - 状态与日志：`state\`（日志在 `state\logs\`）
  - 脚本：`scripts\manage.ps1`（启停）、`reader-api.py`（读数据库）、`hook-onebot.mjs`（发消息）、`console-server.mjs`（控制台）
- 挂载版微信：`G:\wechat-deepseek\data\workspace\state\hook\wechat-4.1.10.27\Weixin.exe`
- 电脑桥接：`F:\deepseek工作区\wechat-pc-bridge\mcp_dsh_server.py`，配置 `config.json`，日志 `bridge.log`
- DSH：`F:\deepseek harness\DeepSeek Harness.exe`，profile 在 `C:\Users\ADMIN\.dsh\profiles\desktop`

## 四、账号

- 账号名称以当前微信登录及小助手界面的核验结果为准，仓库不记录个人昵称、微信号或授权名单。
- 消息读取账号与发送接口账号必须一致；不一致时提示 `HOOK_ACCOUNT_MISMATCH` 并暂停收发。

## 五、常用操作

| 操作 | 怎么做 |
|---|---|
| 启动 | 双击 `启动小助手.bat` |
| 停止 | 双击 `停止小助手.bat` |
| 重启并应用（配置/代码改完必做） | 双击 `重启并应用.bat` |
| 看状态 | 双击 `查看状态.bat` |
| 备份配置 | 双击 `备份配置.bat`（生成到 `G:\小助手\备份\`） |

> 代码或配置改完，必须「重启并应用」才会生效；新增 MCP 工具（电脑桥接）还要**重启整个 DSH 应用**。

## 六、两套项目文件（改代码要同步）

- `data\workspace`：**运行中的真项目**
- `app\resources\project`：安装包内的项目副本（升级/校验用，`deployment.json` 记录源码哈希）

两个位置同名文件要保持一致，否则升级或校验会覆盖/报错。

## 七、常见问题

1. **插件/电脑桥接工具消失**：pcbridge 进程没了（它可能随 DSH 退出被带走）。看门狗计划任务 `dsh-pcbridge-watchdog` 会自动拉起；也可以重启 DSH 应用让工具重新注册。
2. **微信窗口白屏**：客户端渲染坏了，只能重启挂载版微信（需手机确认一次登录）。脚本：`F:\deepseek工作区\wechat-pc-bridge\restart_wx_software.ps1`。
3. **消息发不出去**：看 `state\logs\bridge.log`；`HOOK_NOT_LISTENING` = 微信没开或不是挂载版。
4. **群消息超过 10 分钟不回复**：代码里已限制（social-engine.js，`staleGroupMs=600000`）。
5. **端口**：hook 30001 / 适配器 11229 / DSH 插件 11230 / 读库 reader 5031 / 电脑桥接 8765；WeChatAgent 控制台端口每次启动随机。

## 八、文档索引

| 文件 | 内容 |
|---|---|
| [docs/00_项目总览.md](docs/00_项目总览.md) | 架构图、账号、端口、技术栈、关键概念、依赖 |
| [docs/01_目录与文件清单.md](docs/01_目录与文件清单.md) | 所有重要文件/目录的位置、大小、用途；改哪里速查 |
| [docs/02_运行与运维手册.md](docs/02_运行与运维手册.md) | 启停、自检、日志地图、12 类故障处理、备份恢复、改代码同步流程 |
| [docs/03_功能清单与状态.md](docs/03_功能清单与状态.md) | 现有能力 + 状态（已上线/待验证/受限）+ 工具清单 |
| [docs/04_优化方向.md](docs/04_优化方向.md) | P0~P3 路线图（稳定性/功能/工程/产品） |
| [docs/05_变更记录.md](docs/05_变更记录.md) | 10-22 ~ 10-24 改动明细与待办 |
| [docs/06_交接给Claude.md](docs/06_交接给Claude.md) | **分工：Claude 只出评审/计划/任务单，执行交给 DSH**；含计划专用 prompt、任务单模板、8 个坑、验收命令 |
| [清单/文件清单.csv](清单/文件清单.csv) | 55 项：类别、路径、类型、大小、说明 |

## 九、当前状态（2026-10-24）

- ⚠️ **待恢复**：挂载版微信当前登录成了主人账号（`wxid_h0t6y5w6yke022`），需切换回「奥利奥物美价廉」；后台等待脚本 `_wait_login_and_restart.py` 已武装，正确账号一登录会自动「重启并应用」。
- ✅ 已修：群消息超 10 分钟不回复、任务自然语言播报、链接/引用卡片解析、表情包画面、合并转发文件路径、网页读取 `read_web_page`、发文件到群逻辑（待真机验收）。
- ✅ 已恢复：电脑桥接 16 个工具重新注册；pcbridge 看门狗计划任务已配置（隐藏常驻）。
- 📦 资料包（两版）：
  - `发布\小助手_完整资料_20261024.zip`（22 MB，885 个条目）——**含全部代码**：项目源码、安装包内副本、pcbridge 全部脚本、合同助手 MCP 源码、配置快照、文档、清单；不含大二进制/微信数据/日志/凭据。
  - `发布\小助手_项目资料_20261024.zip`（0.16 MB）——轻量版，只有文档+配置+桥接核心脚本，方便发给别人看。

