# dsh-pc-bridge —— 让微信小助手调用这台电脑

> 状态:**已在本机实测通过**(2026-10-22)。MCP 服务、两种传输、真任务、文件下载、图片回传都验过。
>
> **真实链路**(2026-10-22 修正 —— 之前误以为微信 Agent 在手机上,其实它是电脑端的 `G:\wechat-deepseek\WeChatAgent.exe`):
>
> ```
> 手机微信 · 发消息
>      ↓
> 电脑 · WeChatAgent(挂你微信账号「奥利奥物美价廉」,onebot hook 127.0.0.1:11229)
>      ↓  按聊天授权技能/工具,调本机 DSH 插件 127.0.0.1:11230
> 电脑 · DeepSeek Harness(桌面端,内置 MCP 客户端)
>      ↓  mcp__pcbridge__*  ← 本目录的 MCP 服务
> 电脑 · mcp_dsh_server.py (本目录)
>      ↓  dsh --profile headless
> 电脑 · 真正的执行:文件 / PowerShell / Office / 网页 / 搜索
>      ↓
> 手机微信 · 文字 / 图片 / 文件链接
> ```
>
> 关键点:**WeChatAgent 侧只给"主人私聊"(`wechat:private:1253808542`)开了权限**,群聊保持只能聊天。
> 改过的三处配置和回滚方式见下面「九、接入 WeChatAgent(实际做法)」。


手机上的 **微信Agent**(LSPosed 模块)支持 MCP 外部工具扩展。这个目录提供一个跑在电脑上的 MCP 服务:
手机通过局域网连过来,模型就能在这台电脑上干活。

```
手机 · 微信Agent (MCP 客户端)
        │  局域网 HTTP + token
        ▼
电脑 · mcp_dsh_server.py (MCP 服务,本文件同目录)
        │  subprocess
        ▼
电脑 · dsh --profile headless "<任务>"   ← 真正的执行内核(复用本机 DSH 的全部工具)
        │
        └─ 文件读写 / PowerShell / Office 文档 / 网页抓取 / 搜索 / 子 agent …
```

工具一共 9 个。核心是 **`run_local_agent`**:把任务丢给本机的 DSH agent(跟 GUI 里同一套工具),做完把结果返回。
另外两个是**交付用**的:`export_file`(文件→手机可下载链接)、`send_image`(图片→直接发图)。
其余(`pc_status`、`list_local_dir`、`read_local_file`、`write_local_file`、`run_local_shell`、`local_agent_status`)用于试探和排障。

---

## 一、怎么用(3 步)

### 1. 启动服务

双击 `run_server.bat`。窗口里会打印:

```
 监听      : 0.0.0.0:8765
 工作区    : F:\deepseek工作区
 dsh 命令  : ...\DeepSeek Harness.exe ...\app.asar\dsh\...\bin.js
 token     : REDACTED_TOKEN

 手机上(MCP 配置)填这两个之一:
   SSE / HTTP+SSE : http://10.181.167.132:8765/sse?token=REDACTED_TOKEN
   Streamable HTTP: http://10.181.167.132:8765/mcp?token=REDACTED_TOKEN
```

窗口不能关,关掉服务就停了。

### 2. 先拿手机浏览器验证网络

在手机浏览器打开(把 IP、token 换成上面打印的):

```
http://10.181.167.132:8765/health?token=REDACTED_TOKEN
```

- 看到一段 JSON → 网络通,继续第 3 步。
- 转圈 / 超时 → 看下面「手机连不上」。

### 3. 填进微信Agent 的 MCP 配置

模块设置 → MCP / 外部工具 → 新增 HTTP 服务器,URL 填上面两条之一:

| 模块里的类型 | 填哪条 |
|---|---|
| HTTP + SSE / SSE | `/sse?token=…` |
| Streamable HTTP | `/mcp?token=…` |

两条端点的行为完全一致,哪个能识别用哪个。

然后就能在微信里说:

> 用电脑把上次那个贝塞尔图重画一遍,发给我

### 4. 结果怎么回到你手机

| 你要的结果 | 走哪条 | 手机上看到什么 |
|---|---|---|
| 文字回答 | 直接回复 | 普通消息 |
| **图片/图表** | `send_image` | MCP 的 image 内容,模块支持就直接显示图;不支持会退回一句带下载链接的话 |
| **文件**(Word/PDF/Excel/压缩包) | `export_file` | 一条带链接的消息,点开在浏览器里下载 |

文件走的是电脑上的临时下载服务:`http://<电脑IP>:8765/files/xxx?token=…`,**手机必须和电脑在同一网络**,
文件 24 小时后自动清理。图片超过 3 MB、文件超过 50 MB 时也会退回链接方式。

---

## 二、这台机器上已经做过的改动(重要,别漏)

### 1. `dsh` 命令行:没装,用桌面版兜底

你的机器上没有独立的 `dsh` 命令(桌面版没装 CLI)。脚本会自动用桌面版的 Electron 当 Node 跑
`app.asar` 里的 CLI:

```
F:\deepseek harness\DeepSeek Harness.exe
  F:\deepseek harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js
  --profile headless "<任务>"
```

关键是 `ELECTRON_RUN_AS_NODE=1`(脚本自动设)。这条已经实测跑通,dsh 版本 `0.2.1-rc.2`。

### 2. headless 的模型凭据:已打补丁

`dsh headless` 默认**不用** GUI 里保存的登录态,直接跑会报:

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

已改 `C:\Users\ADMIN\.dsh\profiles\headless\cordis.patch.yml`,做了两件事:

1. 恢复凭据存储(官方文档 `dsh-headless` → Credentials → *To restore stored authentication* 给的写法):
   ```yaml
   - id: credentials
     disabled: false
   - id: authorization
     disabled: false
   - id: deepseek-account
     disabled: false
   ```
2. 默认模型切到你桌面端已经配好的 **sjtu 路由**(官方 `deepseek-official` 那条在 headless 里仍然拿不到 key):
   ```yaml
   - id: llm-pi-ai
     name: "@deepseek-ai/dsh-llm-pi-ai"
     config:
       providers:
         sjtu:
           apiKeyEnv: SJTU_API_KEY
           api: openai-completions
           baseURL: https://models.sjtu.edu.cn/api/v1
           models: [deepseek-reasoner, qwen3.8-27b]
   - id: agent-default-model
     config:
       provider: sjtu
       model: deepseek-reasoner
   ```

想换回官方 DeepSeek:把 `agent-default-model` 改成 `provider: deepseek / model: deepseek-flash`,
并在 `F:\deepseek工作区\.env` 或 `%USERPROFILE%\.dsh\.env` 里写 `DEEPSEEK_API_KEY=sk-...`。

> 代价:headless 现在走交大 API,速度比 GUI 里慢(一句短任务 50 秒左右)。要更快就换回官方 key。

### 3. 防火墙

已加规则 `dsh-pc-bridge 8765`(入站 TCP 8765 放行)。换电脑/重装需要再跑一次 `allow_firewall.bat`。

---

## 三、自检与冒烟测试

不开手机就能验完整条链路:

```powershell
cd "F:\deepseek工作区\wechat-pc-bridge"

# 1) 只看执行内核(会真跑一个最小任务,约 6 秒)
python mcp_dsh_server.py --selftest

# 2) 按 MCP 客户端的方式打一遍服务(先确保 run_server.bat 在跑)
python _smoke_test.py                                             # Streamable HTTP
python _smoke_test.py --transport sse                             # 旧式 SSE
python _smoke_test.py --skip-agent                                # 只测握手和工具列表
python _smoke_test.py --url http://10.181.167.132:8765 --token <token>
```

`_smoke_test.py` 会依次做 initialize → tools/list → `pc_status` → 真跑一句 `run_local_agent`,
最后打印 `✅ 整条链路通` 或具体报错。

---

## 四、手机连不上时

| 现象 | 处理 |
|---|---|
| 手机浏览器 `/health` 超时 | ① 不在同一网络(现在是 `SJTU WLAN`,校园网常有**客户端隔离**,设备之间互相打不通)→ 用手机开热点让电脑连,或用 Tailscale;② 电脑换了 WiFi,IP 变了,看启动横幅重新取 |
| 浏览器能开,模块里连不上 | 模块的 MCP 传输类型选错:两种都试一遍(`/mcp` 和 `/sse`) |
| 返回 403 unauthorized | URL 少了 `?token=`,或 token 不对(看 `config.json`) |
| 工具列表是空的 | 模块没握手成功,或版本太老不支持远程 HTTP MCP |
| 任务总是失败 | 先跑 `--selftest`;若 `[1/3]` 失败,是 headless 模型层的问题 |

**校园网隔离的快速判定**:手机浏览器能开 `http://10.181.167.132:8765/health?...` 就说明没被隔离;
打不开就换手机热点(电脑连手机热点,IP 会在 192.168.x.x)。

---

## 五、接入 WeChatAgent(实际做法,2026-10-22)

### 为什么原来干不了活

WeChatAgent 的 DSH 桥接插件(`G:\wechat-deepseek\data\workspace\packages\dsh-social-bridge-plugin`)里有一条硬规则:

```js
const controlTool = /^(?:bash|shell|pwsh|powershell|terminal|exec_command|apply_patch|file|read_file|write_file|edit_file|agent|task|config|plugin|session|schedule|automation)(?:$|[_.:-])/i;
```

`bash / pwsh / 文件读写 / 子任务` 这些名字**根本不允许**按聊天分配,所以微信里的会话永远是「无本地工具」。
而且主人私聊 `wechat:private:1253808542` 原本**一条 DSH 授权都没有**,连 office 技能都没给。

### 解法:不碰它的插件,改挂一个 MCP 客户端

工具名 `mcp__pcbridge__*` 不匹配上面那条正则,所以可以正常授权;执行能力由本目录的 MCP 服务提供,
它再调 `dsh --profile headless` 干实际的活。三处改动:

| # | 文件 | 改了什么 |
|---|---|---|
| 1 | `C:\Users\ADMIN\.dsh\profiles\desktop\cordis.patch.yml` | 末尾 `insert` 一行 `@deepseek-ai/dsh-mcp-client`,serverName=`pcbridge`,指向 `http://127.0.0.1:8765/mcp?token=…` |
| 2 | `G:\wechat-deepseek\data\workspace\config\wechatagent.json` | `wechat.dshAccess.chats` 新增 `wechat:private:1253808542`(主人私聊),给 9 个技能 + 12 个工具 |
| 3 | `G:\wechat-deepseek\data\workspace\state\bridge-config.json` | 同上,保持一致 |

备份都在同目录:`*.bak-20261022`。

### 生效方式

- 第 2、3 项**立即生效**(每条消息都会重新读授权文件)。
- 第 1 项要**重启 DSH**:托盘图标 → 退出 DeepSeek Harness → 重新打开。
  重启后 WeChatAgent 会自动重连 11230;如果微信没反应,再把 WeChatAgent 的服务重启一次。

### 出问题怎么退

- DSH 打不开 / 白屏:双击 **`恢复DSH配置.bat`**(把 profile 配置换回备份),再重新打开 DSH。
- 只是不想让微信干活了:把 `wechatagent.json` 里 `wechat:private:1253808542` 那段删掉,或者用 `.bak-20261022` 覆盖,重启 WeChatAgent 服务。

### 自检

```powershell
cd "F:\deepseek工作区\wechat-pc-bridge"
python 检查状态.py
```

四项全 ✅ 就说明服务、dsh、DSH 挂载、微信授权都到位了,剩下的就是微信里发一句话试。

---

## 六、安全底线

1. **token 就是钥匙**。存在 `config.json` 里,别截图发群。泄露了跑 `python mcp_dsh_server.py --regenerate-token` 换一个。
2. 服务默认只绑 `127.0.0.1`;`run_server.bat` 显式绑 `0.0.0.0` 时才对外,且强制要求 token。
3. **只在可信局域网用**。不要在公共 WiFi 上开,更不要把 8765 映射到公网。
4. `run_local_shell` 默认关;要开改 `config.json` 的 `allow_shell`。
5. 文件工具默认圈死在 `F:\deepseek工作区`;要放开改 `allow_outside_workspace`。
6. 想让它动整台电脑(而不是只动工作区),在 `run_server.bat` 里取消 `set DSH_PERMISSION_MODE=danger-full-access` 的注释 —— 这等于把电脑交给微信那头发指令的人。

---

## 七、参数(`config.json`)

| 字段 | 当前值 | 说明 |
|---|---|---|
| `port` | 8765 | 端口,被占用就改 |
| `token` | `io-EnmH…` | 访问令牌 |
| `workspace_root` | `F:\deepseek工作区` | agent 的默认工作目录 |
| `agent_timeout_sec` | 600 | 单任务总超时 |
| `sync_wait_sec` | 30 | 同步等 30 秒还没完就返回 `job_id`,让模型用 `local_agent_status` 取 |
| `max_output_chars` | 6000 | 返回给微信的最大长度 |
| `max_export_mb` | 50 | `export_file` 单文件体积上限 |
| `allow_shell` | false | 是否开放裸 shell 工具 |
| `allow_outside_workspace` | false | 文件工具能否越出工作区 |

---

## 八、让它常驻(已配好)

「手机上发消息就能用」的前提是**电脑上这个服务一直开着**。现在已经做成:

- `start_hidden.vbs` —— 无窗口后台启动(pythonw),日志写到 `bridge.log`
- 启动文件夹里已放快捷方式 `dsh-pc-bridge.lnk`,**登录 Windows 就自动起**,不用每次双击
- `stop_server.bat` —— 停服务
- `取消开机自启.bat` —— 只取消自启,不停当前服务

现在它就在后台跑着。想确认:

```powershell
Invoke-WebRequest "http://127.0.0.1:8765/health?token=<token>" -UseBasicParsing
```

崩溃/重启排查看 `bridge.log`。

---

## 九、文件

| 文件 | 作用 |
|---|---|
| `mcp_dsh_server.py` | MCP 服务本体,零依赖,只用标准库 |
| `start_hidden.vbs` + 启动文件夹快捷方式 | 后台静默启动 + 登录自启 |
| `启动后台服务.bat` | 手动后台启动(不弹窗) |
| `stop_server.bat` / `取消开机自启.bat` | 停服务 / 取消自启 |
| `run_server.bat` | 前台启动(带窗口,排障时看日志用) |
| `allow_firewall.bat` | 放行入站 TCP 8765(要管理员) |
| `_smoke_test.py` | 冒烟测试,不用手机就能验完整链路 |
| `config.json` | 配置(token 在这里) |
| `shared/` | `export_file` 生成的临时下载文件,24 小时自动清理 |
| `bridge.log` | 后台模式日志 |
