# 06 · 交接给 Claude（只做计划，执行交给 DeepSeek Harness）

> 分工：**Claude = 技术负责人**，只做评审、方案、任务拆分、验收标准；
> **DeepSeek Harness（本机 DSH）= 执行工程师**，负责读代码、写补丁、跑测试、真机验证。
> Claude 不直接改代码、不输出整份文件重写；它输出的必须是可执行的「任务单」。

---

## 一、粘贴给 Claude 的 prompt（计划专用版，推荐）

```
你是这个项目的技术负责人（Tech Lead），只做规划和评审，不直接写代码、不改文件。
执行由另一台机器上的 DeepSeek Harness 工程代理完成，所以你的产出必须是
「可直接排期和验收的实施计划 + 任务单」，而不是代码。

项目：已上线的微信 AI 助手（Node + Python，Windows 单机）。
链路：挂载版微信 hook(4.1.10.27) → 社交桥 → DSH 桌面端(deepseek-flash)
→ 电脑桥接 MCP(16 工具) → 合同助手 MCP。
材料在压缩包/目录里：docs/00~05（总览/清单/运维/功能/优化/变更）、
代码/项目（运行中源码）、代码/项目-安装包副本（升级校验用的双副本）、
代码/pcbridge（电脑桥接）、代码/合同助手。

第一步：只读评审（不要改代码）。先读 docs/00、docs/02、docs/03、docs/05，
再精读这几个文件建立结构认识：
- components/qq-bridge/src/core/social-engine.js（对话调度/发送纪律/10 分钟规则）
- scripts/reader-api.py（读微信数据库）、scripts/hook-onebot.mjs（发送适配）
- packages/dsh-social-bridge-plugin/*.mjs（DSH 侧插件）
- pcbridge/mcp_dsh_server.py（16 个工具的桥接服务，130KB 单文件）

然后输出：
A. 《架构评审》：架构图、关键模块职责、数据流、风险热区（带文件/行号）。
B. 《问题清单》：按 P0/P1/P2 分级；每条写「现状→问题→影响→修复方向→风险/代价」。
C. 《实施计划》：把问题拆成批次（每批 1 个主题、可独立验收），给出依赖顺序与预估工作量。
D. 《任务单》：每个任务按下面的模板写（见「任务单模板」），要具体到文件、函数、改法、
   验收命令和回滚方式；复杂改动给伪代码或接口契约，不要贴整份文件。
E. 《待人工确认项》：凡是涉及产品决策、外部依赖、真机验证才能定的，列出来让我拍板。

硬约束（写进每个任务单里）：
- 不碰：微信数据库、workspace/state 运行时数据、凭据/token 文件。
- 改代码必须同步两份副本（代码/项目 与 代码/项目-安装包副本），
  并更新 app 副本 deployment.json 的 sourceHashes。
- 不引入新依赖、不改数据格式；确需引入必须单独列一条并给回滚方案。
- 行为规则不可改：无工具成功回执不许说"已发送"；群消息超过 10 分钟不回复；
  合同工具只给主人私聊；生成合同不能改固定条款。
- 每批改动保留 .bak、小步可回滚；单批尽量不要跨 3 个以上文件。
- 真机验证（微信收发/白屏/发文件）由执行方在本机做，你的验收标准要能离线判定
  （语法检查、单测、dry-run、日志断言）。

输出格式：Markdown，任务单用表格或编号列表，每项可勾选。先不要给代码补丁。
```

---

## 二、任务单模板（Claude 输出的每一项必须长这样）

```
### 任务 T-01：给 pcbridge 加统一进程监督器
- 优先级：P0
- 目标：DSH 重启不再导致 pcbridge 服务丢失；异常后 30 秒内自动恢复。
- 现状：pcbridge 由 DSH 应用进程树启动，DSH 退出即被结束（见 docs/02 故障 4）。
- 涉及文件：F:\deepseek工作区\wechat-pc-bridge\start_hidden.vbs、
  pcbridge_watchdog_loop.ps1、C:\Users\ADMIN\.dsh\local-fixes\（新增脚本）
- 改法（伪代码/契约）：
  1) 新增 supervisor.ps1：独立进程（非 DSH 子进程）持有 pythonw mcp_dsh_server.py；
  2) 每 20s GET /health?token=...，连续 2 次失败才重启；
  3) 日志写 watchdog_pcbridge.log，单实例锁。
- 不变项：mcp_dsh_server.py 的工具行为不变；config.json token 机制不变。
- 验收标准：
  1) 手动 kill pythonw 后 ≤30s health 恢复 ok:true；
  2) 重启 DSH 应用后 pcbridge 仍存活；
  3) 日志出现 restarted 记录；4) DSH 工具目录重启应用后仍有 16 个 pcbridge 工具。
- 回滚：停止计划任务 + 恢复旧 vbs/ps1 备份（.bak）。
- 风险：与现有 dsh-pcbridge-watchdog 计划任务重复 → 需先删旧任务。
- 依赖：无 / 需先完成 T-00
```

---

## 三、交给 Claude 的材料

| 材料 | 位置 |
|---|---|
| 完整包（含全部代码与文档） | `G:\小助手\发布\小助手_完整资料_20261024.zip`（10 MB，838 条目；已脱敏、无聊天截图） |
| 轻量包（只评架构够用） | `G:\小助手\发布\小助手_项目资料_20261024.zip`（0.2 MB） |
| 真实路径（本机 Claude Code） | 项目 `G:\wechat-deepseek\data\workspace`；副本 `G:\wechat-deepseek\app\resources\project`；桥接 `F:\deepseek工作区\wechat-pc-bridge` |
| 已知问题/优先级 | `docs/04_优化方向.md`、`docs/05_变更记录.md`（末尾待办）、`docs/03`（已知限制） |

---

## 四、拿到任务单后，丢给 DSH 时这么说

```
这是 Claude 给出的实施计划（粘贴计划/任务单）。
请按任务单执行，一次只做一批：
1) 先只读核对任务单里的文件路径、函数名、现状描述是否与实际代码一致，
   不一致立即指出并停下；
2) 按任务单改代码（双副本同步 + 更新 deployment.json 哈希）；
3) 跑语法检查与你写的离线测试；
4) 输出：改了哪些文件（diff 摘要）、验证结果、回滚方法、剩余风险；
5) 需要真机验证的（微信收发/发文件/白屏）留给我确认。
不要擅自扩大改动范围；任务单里没有的事不动。
```

> 这样 Claude 负责"想清楚 + 拆任务 + 定验收"，DSH 负责"落地 + 验证 + 报告"。

---

## 五、Claude 必须知道的 8 个坑

1. **双副本**：`data\workspace` 是运行中的真项目；`app\resources\project` 是安装包内副本，
   只改一份会导致升级/校验不一致。
2. **deployment.json**：app 副本记录每个源码文件的 SHA256，改文件要同步更新。
3. **MCP 工具目录**：新增/改 MCP 工具或描述，必须重启 **DSH 桌面应用**才生效（不是「重启并应用」）。
4. **重启语义**：`manage.ps1 -Action restart` 只重启微信侧服务（8~12 秒）。
5. **微信客户端**：必须是挂载版 4.1.10.27；登录必须是机器人号「奥利奥物美价廉」，
   登错号会 `HOOK_ACCOUNT_MISMATCH`。
6. **白屏**：Qt 渲染问题；发文件/切会话/截图依赖窗口画面，hook 收发文本/图片不受影响。
7. **token**：资料包里全部替换为 `REDACTED_SEE_REAL_CONFIG`；真实凭证在
   `docs/02` 第八节所列位置，改代码不需要它们。
8. **隐私**：包里没有微信数据库/聊天记录/凭据；不要建议让执行方去读
   `F:\wx file`、`.dsh\.credentials.yaml`。

---

## 六、验收命令（任务单里的验收标准尽量用这些离线可判定的方式）

```powershell
# JS 语法
node --check "G:\wechat-deepseek\data\workspace\components\qq-bridge\src\core\social-engine.js"
node --check "G:\wechat-deepseek\data\workspace\scripts\hook-onebot.mjs"
# Python 语法
& "G:\wechat-deepseek\data\runtimes\0.3.9-db3bce768f85\python\python.exe" -m py_compile "G:\wechat-deepseek\data\workspace\scripts\reader-api.py"
& "G:\wechat-deepseek\data\runtimes\0.3.9-db3bce768f85\python\python.exe" -m py_compile "F:\deepseek工作区\wechat-pc-bridge\mcp_dsh_server.py"
# 双副本一致性
Get-FileHash "G:\wechat-deepseek\data\workspace\components\qq-bridge\src\core\social-engine.js","G:\wechat-deepseek\app\resources\project\components\qq-bridge\src\core\social-engine.js" | Select-Object Hash,Path
# 服务状态
powershell -ExecutionPolicy Bypass -File "G:\wechat-deepseek\data\workspace\scripts\manage.ps1" -Action status
```

---

## 七、建议的协作节奏

1. Claude 出《评审 + 问题清单 + 实施计划 + 任务单》（一轮，可能来回 2~3 次澄清）。
2. 你挑 1~2 个 P0 任务，把任务单丢给 DSH 执行。
3. DSH 执行完给「diff 摘要 + 验证结果 + 回滚方法」；你决定是否让 Claude review。
4. Claude 只 review 计划与结果，不碰代码 → 减少"AI 改坏又说不清"的风险。
5. 每批验收后更新 `docs/05_变更记录.md` 与资料包。
