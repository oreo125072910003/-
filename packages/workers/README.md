# 受限文字协作器

本包为小助手提供确定性的多 worker 工作计划和协调，不包含自己的模型推理循环。每一步由宿主注入的 `runWorker` 执行；`createHarnessWorkerAdapter` 可以将工作包接到现有 Harness `runTask`。写作、分析和审查是不同角色的独立执行，默认使用同一已配置模型，**不代表两个不同供应商或独立外部 agent 已接通**。

## 当前流程

- `writing-review`：writer → reviewer。`revise:true` 时再运行 reviser，共三次调用。
- `research-compare`：analyst-a 与 analyst-b 受限并行，完成后 reviewer 对照两个原始输出审查。它只分析提供的文字资料，没有浏览器、实时文献搜索或自动下载。

计划是纯数据，不支持 eval、shell 或模型生成的新步骤。角色的输出、建议和返回字段不能更改权限、预算或创建新任务。`ok:true` 只表示所有预定义步骤实际返回有效文字成果；审查是模型意见，不等于事实、合同或引文已被独立证实。

## 接口

```js
import { createWorkerCoordinator, createHarnessWorkerAdapter } from './packages/workers/index.mjs';

const coordinator = createWorkerCoordinator({
  runWorker: createHarnessWorkerAdapter({
    runtime,
    settingsProvider: async ({ role, parentTaskId, workspace }) => ({
      ...await trustedRuntimeSettings(parentTaskId),
      // 为每次独立执行使用专用 home，不继承个人 .dsh。
      home: path.join(workspace, 'harness-home'),
    }),
  }),
  authorize: async (trustedContext, request) => policyAllows(trustedContext, request),
  onEvent: async event => saveProgress(event),
  concurrency: 2,
  // 可选持久化接口；由产品服务保存到自己的数据库。
  store: { savePlan, saveStep, saveEvent, saveResult },
});

const plan = await coordinator.createPlan({
  parentTaskId: 'task_当前父任务',
  workflow: 'writing-review',
  goal: '依据给定资料起草工作安排，并检查遗漏。',
  inputs: [{ id: 'facts', name: '用户选定资料', text: '已确认的任务事实。' }],
  revise: false,
  budget: { maxCalls: 3, maxDepth: 1, concurrency: 2, deadlineMs: 180000 },
}, trustedContext);

const result = await coordinator.run(plan, {
  workspace: '当前父任务自己的完整工作目录',
  signal: parentAbortController.signal,
  context: trustedContext,
});
```

`authorize` 默认拒绝，必须严格返回 `true`。服务按真实发起人、父任务与权限决定是否允许 `worker.plan/run/execute/cancel`，不能把模型或 renderer 传入的“我是主人”字段当身份。工作包权限固定为 `text.generate`，执行器必须继续使用受信任的仅对话 Harness profile。

`runWorker` 收到：

```js
{
  workerId, role, prompt, workspace, signal,
  allowedActions: ['text.generate'],
  inputs: [{id, name, text, sha256}],
  dependencies: [{id, role, text, sha256}],
  task: {parentTaskId, planId, stepId, depth},
  budget: {deadline, maxOutputBytes},
  onEvent
}
```

它应返回 Harness 形式 `{ok, finalText, usage?, error?}`，并响应自己的 signal。凭据和模型设置在可信适配闭包中取得，不出现在上述包里。`artifacts` 若非空会被拒绝；现阶段只允许协调器把实际返回的文字保存为 Markdown，不接受任意外部文件路径或“已生成文件”的声明。

其他接口：`listWorkers()`、`listWorkflows()`、`cancel(planId, context)`、`cancelWorker(planId, stepId, context)`、`close()`。取消请求立即生效，但 `cancel` 返回 `confirmed:false`；真实停止结果在最终 `cancellation` 字段表示。取消一个子 worker 不取消其他独立 worker 或其他计划。

## 结果

```js
{
  ok, status, planId, parentTaskId, workflow, finalText,
  steps: [{id, role, name, status, outputText, sha256, error, reviewOf, usage?}],
  artifacts: [{stepId, role, path, sha256, bytes, mime, reviewOf}],
  budget: { /* 配置及 callsUsed, outputsUsed, inputBytes, outputBytes */ },
  review: {assurance: 'model-opinion-only', originalOutputs: [{stepId,sha256}]},
  cancellation: {requested, stopped},
  limitations
}
```

状态区分 `succeeded`、`partial`、`failed`、`cancelled`、`deadline_exceeded`。只要存在失败、跳过或停止不明就不会 `ok:true`。父任务应保留 `partial` 的已完成成果，不能只凭 `finalText` 非空就显示全成功。审查关联被审输出的实际文件哈希，不能冒充原稿本身。返回的 usage 只接受执行器报告的非负 token 数；没有可验证价格时费用保持 `null`，不记零。

## 预算、资料与生命周期

默认总调用 3 次、委托深度 1、全局并发 2、输出最多 3 份、总输出 128 KiB、每步输入含资料和前序成果最多 256 KiB、截止 180 秒。最大硬上限为 8 次调用、3 层、4 并发、8 份输出、输入/输出 1 MiB 和 30 分钟。预算只由创建方案时的可信服务设置，模型返回不能修改。

每份资料必须显式提供 `id/name/text`，不能附带任意账号、凭据、环境变量或文件路径字段。只将这些资料和本流程依赖输出送给当前步骤；不会读取其他任务。已知密钥模式会被移除，但这不是完整的秘密识别系统，服务仍须控制选定资料范围。

每次运行和每个步骤创建独立目录，文字产物以排他写入创建，核对真实路径、文件类型、大小和 SHA-256。父任务目录必须由宿主创建和选择；模型无权指定。

执行器若忽略取消，默认等待 2 秒后标记 `stop_unconfirmed`，保留其全局并发槽直到真正结束，防止超时后不断启动新任务。协调器无法代替执行器杀进程；Harness 适配器负责只停止自己持有的进程。这里没有 OS 沙箱，也不允许任意外部命令适配。

未结束的计划和活动状态在本进程内保存，最多 512 份。注入 store 可持久记录，但尚不提供重启自动恢复或重放；新进程不能重新运行上一进程的旧 plan。涉及副作用的未来流程需要另行恢复与回执规则。

## 验证与剩余验收

`node --test tests/workers.test.mjs`：16 项离线测试通过，包括真实异步并行、独立目录、审查哈希、权限、计划防篡改与重复、预算、资料/凭据隔离、部分完成、单 worker/单计划取消、截止时间、停止不明及 Harness 适配契约。没有调用真实付费模型。

T28 尚缺独立外部 worker 与真实账号联调；T29 尚缺 OS 执行隔离与真实费用额度；T30 现仅实现受限文字成果，不含任意 Office/科研文件的完整导入与校验。不能据此把三个任务整体标为完成。
