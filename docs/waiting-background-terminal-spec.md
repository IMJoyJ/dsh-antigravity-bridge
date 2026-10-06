# 后台任务运行中不报 done —— 终态修复规范（v1）

> 唯一对齐依据。本规范基于 2026-10-06 对真实 hub 的受控取证（见文末「取证记录」）。
> 所有车道开工前必须先读本文件，再按车道边界施工。

## 0. 一句话目标

settle 只在「明确证实无任何在途工作」时发生；假 done 的根因被消除后，撤回（revert-from-done）机制整体删除。

## 1. 取证结论（与原报告的差异，必读）

1. **`STATE_WAITING_FOR_TASKS` / `STATE_FULLY_IDLE` 在 hub 后端不可达。** 这两个枚举只存在于 `proto/localharness.proto` 的 `TrajectoryStateUpdate`（localharness/SDK 后端的 WebSocket OutputEvent 流）。hub 后端（`exa.language_server_pb.LanguageServerService`，grpc-web，293 个方法）里**没有任何 STATE_\* 枚举**；`GetCascadeTrajectoryResponse` 只有一个顶层 `status: exa.cortex_pb.CascadeRunStatus {UNSPECIFIED=0, IDLE=1, RUNNING=2, CANCELING=3, BUSY=4}`。受控探针实测：一个真实 70 秒后台任务等待期间，hub 全程报 `CASCADE_RUN_STATUS_IDLE`；完全空闲也报 IDLE；连 ERROR 状态也报 IDLE。**IDLE ≠ 完全空闲**，因此原报告「接通 STATE_FULLY_IDLE」在主（hub）车道不可实现，用户已确认改走下列等价路径。
2. **`gemini_coder.TaskDetails` 没有 status 字段**（只有 `id, log_uri, progress, description, requires_input_approval, is_daemon`）。任务自身状态在 hub 轨迹里由**承载 taskDetails 的那个 step 的 status** 表达——受控探针实测该 step 在任务运行的 70 秒里一直是 `CORTEX_STEP_STATUS_RUNNING`，任务完成那一刻才转 DONE（S0 cascade 时间戳交叉验证：task-215 运行 4分51秒，`completedAt` 与完成 SYSTEM_MESSAGE 相差 90ms）。**hub 轨迹的步状态本身是对的。**
3. **真因 = 注册空窗 + 转录启动检测是死代码。** 任务的 RUN_COMMAND step 只在 `WaitMsBeforeAsync` 窗口（实测默认可达 10s）之后才出现在 hub 轨迹里；模型的一句收尾回复通常 2–4 秒落地——**回合在任务对 hub 可见之前就结束了**，三重守卫全部读到空表，两阶段确认通过，报 done。任务完成后 hub 注入完成 SYSTEM_MESSAGE 并唤醒 cascade → step 增长 → 触发 R1 撤回。这就是 WI 车道「done（Active Background Tasks: 0）→ 续作」死循环的精确机制。
4. **转录文件里有缺失的即时真值。** hub 在工具结果里**即时**注入启动模板（GENERIC step content）：
   ```
   Tool is running as a background task with task id: <cascadeId>/task-148 Task Description: dotnet build ... Task logs are available at: file:///C:/Users/.../tasks/task-148.log YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: ...
   ```
   三个真实 cascade 分别出现 17/33/21 处，格式稳定。完成标记同样由 hub 注入（SYSTEM_MESSAGE，`sender=<cascadeId>/task-N`，`Task id "<cascadeId>/task-N" finished with result: ...`）。
   但 `parseTranscript` 的任务启动分支要求 `step.task_details`——实测三个 cascade 的转录文件里该字段**恒为 0 处**（`transcript.jsonl` 与 `transcript_full.jsonl` 皆然），**启动分支从未触发过**，转录任务表在启动时恒为空，注册空窗完全无防护。
5. hub 查询在 `authoritative && outsideGraceWindow` 时**覆盖**转录任务表（index.ts:2693-2703 / 2164-2174 / 3406-3412）。今天该覆盖无害（转录表是空的），但一旦转录表能追踪到任务，覆盖会重新引入缺陷，必须改为并集。
6. 权威性熔断缺失：空兜底返回 `authoritative: false`（index.ts:1872），Round-2 与 classifySnapshot 的 done 分支不校验权威性，`!freshTasks.isCascadeActive` 把 undefined 当「不活跃」——「未知」被当作「没有」。

## 2. 终态设计（用户已确认）

### 2.1 接入转录任务生命周期（根因修复）

**transcript.ts**：新增 hub 注入启动模板的识别（这是 hub 注入的结构化工具结果模板，**不是模型语音正则**），接入现有任务表。

- 新增导出常量（精确锚定 hub 模板，零语音匹配）：
  ```ts
  export const BACKGROUND_TASK_LAUNCH_MARKER_REGEX =
    /running as a background task with task id:\s*([a-zA-Z0-9_-]+)\/(task-\d+)/i;
  export const BACKGROUND_TASK_LOG_URI_REGEX =
    /Task logs are available at:\s*(file:\/\/\/\S+?\.log)/i;
  ```
- 在 `parseTranscript` 的任务扫描循环里新增分支「1b. 文本模板任务启动」：step 类型 ∈ {`GENERIC`, `TOOL_RESULT`, `TOOL_EXECUTION`, `RUN_COMMAND`} 且 `content` 匹配 `BACKGROUND_TASK_LAUNCH_MARKER_REGEX` → 以 `<前缀>/task-N` 注册未完成任务（复用现有级联隔离、taskId 校验、description/logUri 提取逻辑：logUri 取自 `BACKGROUND_TASK_LOG_URI_REGEX`，description 优先取结构化字段，否则取模板内 `Task Description:` 后到下一个 `Task logs` 前的文本，截断 300 字符并过滤换行）。
- 与现有结构化分支（1. Structured Task Launch）共存：结构化分支优先；文本分支仅在 tasksMap 尚无该 taskId 时注册（不覆盖结构化条目）。
- 完成侧不变：SYSTEM_MESSAGE 的 sender/Task id 正则（残余盲区②）+ 前台推进兜底，均已工作。
- **新增第三类完成信号（验收期发现）**：`manage_task Action:list` 的空响应。真实级联（35cb9810 step 198 等 39 个级联）里它以 **GENERIC 步、content 尾部**「No background tasks are currently running.」出现（前面常带 "Created At / Completed At / Task: ... / Status: ..." 结构）。这是 hub 明确声明「无在途任务」的**阳性证据**，应把所有未完成任务标记为完成。
  - 实现位置：完成分支区（SYSTEM_MESSAGE 完成之后、前台推进兜底之前），新增 `MANAGE_TASK_EMPTY_LIST_REGEX`：
    ```ts
    export const MANAGE_TASK_EMPTY_LIST_REGEX = /No background tasks are currently running/i;
    ```
  - 触发条件：`isLaunchStepType`（GENERIC/TOOL_RESULT/TOOL_EXECUTION/RUN_COMMAND）且 content 匹配 → 对 tasksMap 中所有 `!finished` 且**非 schedule/timerCondition** 的任务置 `finished = true`（schedule/timer 类任务与前台推进兜底同一条保护规则，永不被此信号误清）。
  - 排除 schedule/timer 的理由与既有兜底一致：计时器由 IDE 单独通知，空列表不构成其完成证据。
  - **净效果**：从工具结果落地的那一刻起，`snap.activeBackgroundTasks` 就含该任务，直到其完成 SYSTEM_MESSAGE 或 manage_task 空列表到达。注册空窗被完全覆盖。

### 2.2 并集语义，永不覆盖（含阳性终止证据退休规则）

**index.ts** 三处（watcher 2530 附近、classifySnapshot 2091 附近、probe 3230 附近）：把
```ts
if (structuredTasks.authoritative && outsideGraceWindow) {
  snap.activeBackgroundTasks = structuredTasks.activeTasks;
  snap.hasActiveChildren = structuredTasks.hasActiveChildren;
} else if (...) { ... }
```
改为**并集**：转录追踪的未完成任务 ∪ hub 结构化活跃任务（按 taskId 去重，`isTaskIdMatch`）。hub 查询只能**补充**（覆盖转录漏掉启动标记的任务），**绝不能抹掉**转录追踪的任务。`snap.hasActiveChildren` 仍取 structured（转录无子会话信号）。

- 从 transcript.ts 导出并集工具函数 `mergeBackgroundTasks(transcriptTasks, hubTasks): ActiveBackgroundTask[]`（按 taskId 去重，转录条目优先），三处复用，且可单测。
- 下游 `rawActiveTasks` 选择逻辑保持原形状，但读的是并集后的 `snap.activeBackgroundTasks`。

**退休规则（D5 兼容）**：并集语义下，转录追踪的任务在两种情况下退出活跃表，且两种都是「阳性证据」，绝不是「hub 列表里没有」：
1. **转录侧完成标记**：SYSTEM_MESSAGE 完成通知或前台推进兜底（既有逻辑，不变）。
2. **hub 阳性终止证据**：当 `structuredTasks.authoritative === true` 时，若 hub 的 **allTasks** 里该 taskId 对应条目的 `isActive === false`（hub 明确判定该任务步已终态），则该任务从活跃表退休。判据是 hub **明确说它完了**（allTasks 含该 id 且 isActive=false），而不是 hub **没有提到它**（注册空窗期 hub 列表为空时 allTasks 也不含该 id，此时不退休）。

实现方式：`mergeBackgroundTasks` 增加第三参数 `hubAllTasks`（可选，仅 authoritative 时传入）：
```ts
export function mergeBackgroundTasks(
  transcriptTasks: ActiveBackgroundTask[],
  hubActiveTasks: ActiveBackgroundTask[],
  hubAllTasks?: ActiveBackgroundTask[],  // 仅 structuredTasks.authoritative 时传入
): ActiveBackgroundTask[];
```
语义：结果 = 转录任务中未被 hub 阳性终止的任务 ∪ hub 活跃任务（按 taskId 去重，转录优先）。hub 条目带 `isActive` 布尔字段（`ActiveBackgroundTask & { isActive: boolean }` 运行时存在，接口上 `isActive` 可选）。

这条退休规则保住了 D5 场景（任务崩溃未写 SYSTEM_MESSAGE，但 hub 权威查询在 allTasks 里报告 isActive=false → 退休 → 正常 settle），同时不损害注册空窗保护（空窗期 allTasks 不含该 id → 不退休）。

**修正案 v4（审计发现）：`isActive` 必须随 allTasks 一路透传。** 生产链路构造 allTasks 时丢弃了 map 项的 `isActive` 字段（hub 路径 trajectory.ts:301-313、SQLite 兜底 :464-475），导致 `h.isActive === false` 永不成立、退休规则实为死代码——测试因手工注入 `isActive: false` 而全绿，掩盖了缺口。修法：两处 task 对象物化时补 `isActive: item.isActive`；allTasks 的类型标为 `(ActiveBackgroundTask & { isActive?: boolean })[]`。activeTasks（仅活跃任务）不需要该字段。

### 2.3 权威性熔断

- **Round-2（index.ts ~3085 `isConsistent`）**：新增硬门槛 `freshTasks.authoritative === true`。取不到权威答案 ⇒ 不 settle（继续等待）。
- **classifySnapshot（index.ts ~2228）**：自然空闲 done 分支要求 `structuredTasks.authoritative === true`；非权威且快照看似结束时分类为 `running`（继续探测），绝不把「未知」当「没有」。`isExplicitlyStopped` 分支保持不变（其证据可来自转录的 `hasCanceledStep`）。

### 2.4 删除撤回机制

- 删除 watcher 内的 R1 假 done 驻留检测块（index.ts 2534-2624，`if (run.status === 'done') {...}` 整块）。
- 删除 `notifyRevertedFromDoneToDsh`（index.ts 1482-1528）、`antigravity/reverted-from-done` 事件 emit、消息 source 里的 `revertedFromDone` / `oldSettledStep` / `currentStep` 字段。
- 删除 `settledContentHash`（接口字段 + 全部赋值点：659/761/817/1997/2591/3120、重启路径 902）。
- **保留 `settledStepIndex` 作为纯审计字段**（用户已确认）：只在结算时记录，用途仅限结算通知展示行与桥接重启恢复检查；删除其一切驻留检测用途。
- watcher 在 settle 成功后改为 `break` 退出循环（不再 `continue` 轮询到 watchMaxMs）。显式停止结算（2766-2991 的 `continue`）同样改为 `break`。错误分支本来就是 `break`。
- 重启恢复路径（index.ts 884-914）保留「停机期间 transcript 增长 ⇒ 恢复 running 并重挂 watcher」，但删除 `settledContentHash` 相关行；无增长的分支不再重挂 watcher（R1 已删，done 后无事可看）。
- 清理引用 R1 的注释（如 index.ts:3138、index.ts:2269 的 isWaitingSpeech 注释、transcript.ts:908 的同类注释）。

### 2.5 删除 isWaitingSpeech 死代码

- 删除 `transcript.ts` 的 `isWaitingSpeech` 函数（173-248）及其导出。

## 3. 文件车道归属表

| 文件 | 车道 | 范围 |
| :--- | :--- | :--- |
| `src/hub/transcript.ts` | 车道 A | 2.1 启动模板识别 + manage_task 空列表完成信号 + 2.5 删 isWaitingSpeech + 导出 `mergeBackgroundTasks`（并集工具函数，放本文件因其操作 ActiveBackgroundTask 且与任务表同源）+ 清理 908 行注释 |
| `src/index.ts` | 车道 B | 2.2 三处并集（调 `mergeBackgroundTasks`）+ 2.3 权威性熔断 + 2.4 撤回机制删除 + settle 后 break + 重启路径清理 |
| `test/tail-guard.test.ts` | 车道 C | 删 isWaitingSpeech 测试段；R1 撤回测试改写为反向断言；新增「注册空窗不 settle」回归测试；现有涉及 settledContentHash / revertSpy 的测试按新行为修正 |
| `test/trajectory.test.ts` | 车道 C | 新增启动模板解析测试（用真实 hub 模板文本）、并集工具函数测试 |

车道 A、B 文件不重叠，可并行。车道 C 依赖 A、B 落地后的最终行为，在 A、B 验收后启动。

## 4. 冻结接口（跨车道契约）

- `transcript.ts` 导出：`BACKGROUND_TASK_LAUNCH_MARKER_REGEX`、`BACKGROUND_TASK_LOG_URI_REGEX`、`MANAGE_TASK_EMPTY_LIST_REGEX`、`mergeBackgroundTasks(transcriptTasks: ActiveBackgroundTask[], hubActiveTasks: ActiveBackgroundTask[], hubAllTasks?: ActiveBackgroundTask[]): ActiveBackgroundTask[]`（第三参数仅 hub 权威时传入；内部用 hubAllTasks 条目的 `isActive === false` 作阳性终止证据，见 §2.2）。
- `parseTranscript` 行为变更（对现有测试的影响必须由车道 C 一并修正）：转录文本模板里的任务现在会进入 `activeBackgroundTasks`。
- `HubRun` 接口：删除 `settledContentHash`；保留 `settledStepIndex`（语义：结算时记录的审计快照）。
- `AntigravityService`：删除 `notifyRevertedFromDoneToDsh` 方法及其 emit 的事件名 `antigravity/reverted-from-done`。
- 结算消息 source 不再含 `revertedFromDone` 等字段。

## 5. 验收标准

1. `pnpm typecheck`（tsc --noEmit）零错误。
2. `pnpm test`（vitest run）全绿；新增/改写的测试必须覆盖：
   - 启动模板解析：一段真实格式的 GENERIC step content → parseTranscript 输出该任务为 active；追加对应完成 SYSTEM_MESSAGE → 任务消失。
   - **manage_task 空列表完成**（规范 §2.1 新增）：GENERIC content 尾部 "No background tasks are currently running." → 所有非 schedule/timer 活跃任务完成；一个 schedule/timer 任务保持不变（保护规则）。
   - 注册空窗回归：watcher 场景下，转录任务表含一个未完成任务、hub 查询返回空（authoritative）时，跨过确认窗口也**不 settle**；补上完成 SYSTEM_MESSAGE 后才 settle。
   - 权威性熔断：Round-2 / classifySnapshot 在 `authoritative: false` 时不产出 done。
   - 并集：转录任务与 hub 任务按 taskId 去重，hub 不能抹掉转录任务。
3. 反向断言（原 R1 测试的改写）：settle 之后不再有「假 done 复活」路径——因为根本不会提前 settle；`notifyRevertedFromDoneToDsh` 已不存在。
4. 交付物抽查：grep 全仓确认 `isWaitingSpeech`、`settledContentHash`、`notifyRevertedFromDoneToDsh`、`reverted-from-done`、`revertedFromDone` 零命中（含测试文件）。

## 6. 红线

- 禁止重新引入任何对模型输出文本的语音正则门（isWaitingSpeech 类）。
- 禁止让 hub 结构化查询抹掉转录追踪的任务（覆盖回退）。
- 禁止把 `authoritative: false` 的空结果当作「没有任务」。
- 禁止修改 `proto/` 目录与 `src/hub/descriptors.gen.ts`。
- 禁止改动与本规范无关的结算/通知/状态序列化逻辑。
- 仓库根目录有一批 `tmp-*.mjs` / `tmp-*.ts` / `test/tmp-*.test.ts` 调查文件（协调者取证产物，untracked）——**不得提交、不得删除、不得引用**，由协调者在验收后统一清理。

## 7. 已知纵深缺口（审计验收，低风险，可不修）

Round-2 二阶段确认的 `freshActiveTasks`（index.ts:2918-2924）只取 hub 的 `freshTasks.activeTasks`，未并入 `freshSnap.activeBackgroundTasks`（转录任务表）。当前由两道间接闸门保护：Round-1 阻塞门已含转录任务（watcher 3.5 阻塞门 index.ts:2740），且 Round-2 要求 step/hash 稳定（转录任务状态变化必然改 step 序列或 hash，会被 :2932-2933 拒绝）。因此「转录有任务 + Round-2 却判定无任务」的组合在当前实现下不可达。若未来改动放松了 step/hash 稳定性要求，需在 :2918 处先 `union(freshSnap.activeBackgroundTasks, freshTasks.activeTasks)` 再判定。

## 8. 取证记录（可复核）

- 受控探针：直接经 hub StartCascade + SendUserCascadeMessage 启一个 `run_command`（`WaitMsBeforeAsync=3000`，`Start-Sleep -Seconds 70`）的真实 cascade，每 2 秒轮询 `GetCascadeTrajectory`：
  - t≈7s 起 task-2 step 以 `CORTEX_STEP_STATUS_RUNNING` 出现；t≈11s 回合结束（status=IDLE, execTerms=NO_TOOL_CALL）但 task-2 保持 RUNNING 直到 t≈75s；完成时 status 短暂回 RUNNING、step 4→6（完成 SYSTEM_MESSAGE + planner 响应），随后 IDLE。
  - 结论：hub 轨迹能正确反映任务活性；假 done 只发生在任务步出现之前的注册空窗。
- S0 cascade（`1b909a29`）全量 dump：17 个 taskDetails 步全是 RUN_COMMAND，`createdAt`/`completedAt` 覆盖各自任务的真实运行周期（task-215: 09:05:29→09:10:20），与 17 条完成 SYSTEM_MESSAGE 一一对应。
- 三 cascade 转录文件统计：`task_details` 字段出现次数 0/721、0/571、0/405；启动模板标记 17/33/21 处。
- 枚举排查：hub packed descriptors 里无 `STATE_WAITING_FOR_TASKS` / `STATE_FULLY_IDLE`；`ExecutorTerminationReason` 无 waiting-for-tasks 值；`exa.cortex_pb.TaskStatus` 是 todo-list 语义且轨迹响应中从不出现。
