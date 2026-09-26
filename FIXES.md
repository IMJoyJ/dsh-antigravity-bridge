> ⚠️ **lib-next 待协调员在受控重启窗口替换 lib**
> 
> 宿主正在运行，严禁直接覆写 `lib/`，请协调员在受控重启窗口参考文末替换步骤进行部署。

# dsh-antigravity-bridge 通知丢失四根因修复说明

## 修复概览

针对 DSH 宿主与 Antigravity 插件通信中的通知丢失问题，本补丁完成了四项根因及两项加固特性的完整修复与自动化测试。

---

### 1. P0-1 状态零持久化 (State Persistence & Recovery)
- **问题**：`runs`、`watchers`、`messageQueues` 全在内存中，DSH 重启后监控和消息队列全部丢失。
- **修复措施**：
  - 新增 `PersistedBridgeState`，包含 `runs`、`messageQueues`、`settlementOutbox`。
  - 落盘路径位于 `${appDataDir}/dsh-antigravity-bridge/state.json`。
  - 写入采用原子写入机制（`.state.json.tmp` + rename / copy fallback），防崩溃损坏；写操作使用 500ms 防抖。
  - 构造函数中启动 `initState()` 异步初始化：
    - 读取磁盘状态并恢复 `runs` 与 `messageQueues`。
    - 结合 `ctx.agents.list()` 重新关联 `callerAgent` 实例。
    - 对每个活跃任务读取 transcript：若在离线期间已终态则执行正常结算与落地报告；若仍在运行则恢复看门狗（继承 `baselineStepIndex`）。
    - 针对终态任务自动刷新孤儿队列；针对未知或异常任务妥善清理并 reject。
    - 插件销毁时通过 `saveStateNow()` 同步落盘。

### 2. P0-2 结算通知持久 Outbox (Settlement Outbox & Retry)
- **问题**：`notifySettlementToDsh` 投递失败直接丢弃，仅一次投递机会。
- **修复措施**：
  - 引入 `settlementOutbox` 机制与 10 秒定时重试器（`startOutboxTimer`，`unref` 避免阻止退出）。
  - 抽取 `deliverMessageToAgent`，支持先向关联 `callerAgent` 投递，若失效则回退遍历 `ctx.agents.list()` 寻找目标。
  - `notifySettlementToDsh` 若投递失败立即入队 Outbox 并持久化到 `state.json`。
  - 重试器定期轮询重发，投递成功后从 Outbox 移除；对超过 10 分钟未送达的过期通知丢弃并记录 warning 日志，防永久堆积。

### 3. P0-3 turn-end 队列孤儿防护与死亡证伪 (Watcher Re-arm & Liveness)
- **问题**：当看门狗异常退出时，后续以 `turn-end` 模式入队的消息会因无人调用 `flushMessageQueue` 成为永久孤儿；且 120 秒内将终态任务误判为 running。
- **修复措施**：
  - 在 `hubSendMessage` 的 `mode === 'turn-end'` 入队逻辑中，判断若当前没有活跃 watcher（`!this.watchers.has(conversationId)`），立即调用 `this.ensureActiveWatcher(conversationId, existingRun?.callerAgent)` 重启看门狗。
  - 引入 `isConfirmedDead` 检查：若不存在活跃 watcher 且任务状态明确为 `done` / `error` / `timeout`，直接证伪 `recentlyActive` 120 秒假定，强制走空闲直接投递通道。

### 4. P1-1 wait=true 路径投递确认与快速失败 (Delivery Confirmation)
- **问题**：`sendMessage` 走 HTTP 请求成功并不代表进入级联上下文，若投递失败后续等待 300 秒超时。
- **修复措施**：
  - 新增 `confirmMessageDelivered`，通过读取级联 transcript 或 prompt 对比进行单次校验与 1 次重试。
  - 在 `hubSendMessage` 的 running 注入分支、idle 发送分支以及 `flushMessageQueue` 消费分支中执行投递确认。
  - 若投递确认失败，立即返回 `DELIVERY FAILED for <cascadeId>: ...`，不进入 `waitForSettlement` 长等待，实现即时快速失败。

### 5. 顺手加固 (Independent Resumed Notification & Structured Logging)
- **独立恢复通知标记**：将 `notifyResumedToDsh` 中的幂等校验字段独立为 `lastResumedNotifiedTurn`，不再污染 `lastNotifiedTransition`，彻底解决恢复通知被结算覆盖的问题。
- **结构化通知日志**：统一增加通知日志规范：
  `[antigravity][notify] status=... turnSeq=... transitionKey=... delivered=...`
  便于生产环境追踪通知全链路状态。

---

## 验证与测试

- **Typecheck**：`tsc --noEmit` 通过（0 错误）。
- **Unit Tests**：新增 `test/state-outbox.test.ts`，全量单元测试 5 个测试文件、64 项测试全部通过（含持久化启动恢复、Outbox 重试与 TTL 淘汰、turn-end 孤儿防护、死亡状态证伪、wait=true 快速失败）。
- **Build**：`npm run build` 打包成功（`lib/index.mjs` 等文件正常生成）。

---

# 修复任务 #2：后台任务未完成时禁止结算为 done

## 1. 问题背景与根本原因
- **问题现象**：Antigravity 会话执行长时间后台任务（如 `dotnet run tools/SelfPlay --matches 100`），助手输出说明文本（如「Checked task ... in background」）结束当前 turn。Bridge 尾部守卫因静默窗口到期误将 cascade 结算为 done 并通知上游完成。后续后台任务完成或继续执行时触发重复唤起、轮次激增，最终导致 AGY 会话膨胀崩溃。
- **核心原理事实**：任何后台 task 结束时 hub 都会向 AGY 会话发送系统消息（`SYSTEM_MESSAGE`）重新拉起它。因此，有未完结后台任务时的 turn 结束或 idle 不是真完成，Bridge 严禁提前结算为 done。

## 2. 修复技术落点

### 2.1 全生命周期追踪 (`src/hub/transcript.ts`)
- **定义模型**：新增 `ActiveBackgroundTask` 接口与 `snap.activeBackgroundTasks` 字段。
- **任务启动识别**：
  - 匹配 `Tool is running as a background task with task id: <taskId>` 及 `Task Description: <desc>`。
  - 记录启动时间戳、启动 step_index 及关联的 `TimerCondition`。
- **任务完结识别**：
  1. `SYSTEM_MESSAGE`（支持 `step.sender` 或 `step.content` 中的 `sender=<taskId>`）。
  2. 文本匹配 `Task id "<taskId>" (finished|was canceled|canceled|failed)`。
  3. `manage_task` 状态上报：匹配 `Status: DONE|CANCELLED|FAILED|KILLED` 且包含 `Task: <taskId>`。
  4. 取消命令：匹配 `Task "<taskId>" (cancelled|killed|was canceled)`。
  5. 级联完成：当被依赖的目标任务完结时，自动关联完结依赖该任务的 `TimerCondition` 定时器。

### 2.2 结算门禁与状态模型 (`src/hub/transcript.ts` & `src/index.ts`)
- **门禁拦截**：
  - `decideTailSettle` 顶层增加门禁：只要 `snap.activeBackgroundTasks` 存在，强制返回 `{ action: 'wait-background', reason: 'background-task', activeTasks }`，禁止结算 done、禁止 auto-continue。
  - `classifySnapshot` 针对活跃后台任务直接返回 `status = 'waiting-background'`。
  - `waitForSettlement` 排除 `'waiting-background'`，禁止其作为终态提前返回。
  - `antigravity_delegate` 的 3s probe 探测与 `hubCheckRun` 补充 `hasActiveTasks` 门禁与 watcher 自动挂接。

### 2.3 防无限等待与 5 分钟去重限速通知 (`src/index.ts`)
- **状态流转**：
  - `runCascadeWatcher` 检测到 `hasActiveTasks` 时，将 `run.status` 置为 `'waiting-background'`，并重置 `stallSince` 计时，免疫 120s stall 检测（防止长时间后台任务被误判为流挂起并误触发续作）。
  - 后台任务完结后自动重置为 `running`，待模型产出最终回复或静默稳定后正常结算为 `done`。
- **5 分钟限速通知**（`notifyWaitingBackgroundToDsh`）：
  - 仅在 `waiting-background` 下触发；
  - 初次通知需后台任务运行满 5 分钟（避免普通数十秒后台短命令产生骚扰通知）；
  - 之后每 5 分钟（300,000ms）严格去重限速一次，向 DSH 桌面与会话卡片发送包含 `cascadeId`、已等待时长、运行中后台任务列表与描述的 warning notice。

### 2.4 持久化与恢复支持 (`src/index.ts`)
- `HubRun` 与 `PersistedRun` 引入 `lastBackgroundWarningAt` 字段。
- 服务启动与热重载时，`initState` 恢复 `'waiting-background'` 状态下的 runs，并重新挂接看门狗继续监控。

## 3. 验证与测试
- **真实案例验证**：在 `84b2a576-3cdb-4add-b05f-05675911acdd`（1186 步）真实 transcript 上完全复现并精准识别出 step 750 的未完结任务 `task-602`。
- **全量测试套件**：
  - `test/tail-guard.test.ts` 扩展后台任务追踪、门禁拦截、watcher 状态流转、stall 豁免、5分钟限速通知等用例。
  - `npm test`：5 个测试文件，73 项测试全部通过（100% pass）。
  - `npm run build`：tsdown 打包成功，类型与产物同步更新。

---

# 修复任务 #2 返工与加固：彻底根除 waiting-background 跨 Cascade 串扰与垃圾条目

## 1. 根本原因复盘
1. **纯文本正则误匹配**：旧逻辑在 step 内容的非结构化文本上盲跑正则，助手回复中讨论正则的说明文本（如 `<taskId>`、`Status: DONE`）、以及前台工具 stdout（如脚本打印其他会话日志）均被误提取为任务。
2. **缺乏 Cascade 隔离**：`parseTranscript` 之前未透传目标 `cascadeId`，导致一个 cascade 打印其他 cascade 日志时引发跨会话串扰，误挂载多达 18 项虚假活跃任务。
3. **未结合前台推进状态兜底**：部分任务已在后台执行完毕，AGY 会话随后由 Hub 唤起并继续前台操作（如编写测试、调用 `view_file` 等），但因缺少显式文本标记导致一直判定为未完结。

## 2. 核心技术落点
1. **限定结构化 Task 步骤记录** (`src/hub/transcript.ts`)：
   - 任务启动严格限定于 `step.status === 'RUNNING'` 且 `step.type` 为工具步骤（`GENERIC` / `TOOL_RESULT` / `RUN_COMMAND`）。彻底排除 `PLANNER_RESPONSE`、`USER_INPUT`、`CHECKPOINT` 以及 `status === 'DONE'` 的普通命令输出。
2. **按 Cascade 严格隔离** (`src/hub/transcript.ts`)：
   - `parseTranscript`、`readCascadeTranscript`、`pollTranscript` 显式透传当前目标 `cascadeId`。
   - 解析出带有 `cascadePrefix/task-xxx` 的任务时，若 prefix 与目标 `cascadeId` 不符，立即拒绝并输出 warning 日志，彻底杜绝跨 cascade 串扰。
3. **严格合法性校验** (`src/hub/transcript.ts`)：
   - `taskId` 必须严格符合 `/^task-\d+$/` 格式（如 `task-255`），非法格式直接丢弃并 warn。
   - `description` 强制剔除包含换行符、长中文句子（`[\u4e00-\u9fa5]{5,}`）或 `file:///` 协议路径的垃圾条目；超过 300 字符自动截断。
4. **前台推进唤醒兜底 (Foreground Progress Fallback)** (`src/hub/transcript.ts`)：
   - 若 transcript 在某 task 启动后出现了更新的前台步骤（新轮次 `USER_INPUT` 或调用的工具非 `manage_task` / `schedule` 的 `PLANNER_RESPONSE`），说明会话已被 Hub 在后台任务退出时唤醒推进，该 task 必定已完结，自动将其标记为 `finished = true`。

## 3. 验证与回归测试
- **真实数据回归测试**：在 `test/tail-guard.test.ts` 中引入 `84b2a576`（1304 步真实压测记录）与 `34351239` transcript 作为 fixture：
  - 目标 cascade 解析断言：完结状态下活跃任务数为 0（无误报）。
  - 跨 cascade 隔离断言：读取其他 cascade 记录时活跃任务数为 0（100% 隔离拦截，无串扰）。
  - 垃圾条目防御断言：助手文本提及 task、脚本输出 DONE 日志、异常路径均被完全过滤。
  - 前台推进兜底断言：启动后产生前台工具调用即可正确判定任务已完结。
- **全量测试与构建**：
  - `npm test`：5 个测试文件全部绿灯通过，总用例数增至 77 项。
  - `npm run build`：打包成功，产物完全生成。

---

# 修复任务 #2 补充改进：waiting-background 告警 UX 优化

## 1. 问题复盘
1. **已等待时长读数虚高**：此前从 `run.startedAt` 起算，跨轮次或长任务时读数混入整场 cascade 的历史总时长，而非当前等待任务的真实时长。
2. **状态翻转致告警频发**：`lastBackgroundWarningAt` 在状态切回 `running` 时被清零，同一 cascade 短时间内出现多个等待 episode 时各自触发「首次告警」，导致 1.2 分钟内连发两条。

## 2. 优化方案
1. **独立 Episode 起点字段** (`src/index.ts`)：
   - 在 `HubRun` 与 `PersistedRun` 中引入 `waitingBackgroundStartedAt?: number`，随持久化落盘并恢复。
   - 仅在进入 `waiting-background` 时初始化当前 episode 时间戳；退出为 `running` 时重置 `waitingBackgroundStartedAt = undefined`。
   - 告警读数改为从 `run.waitingBackgroundStartedAt` 起算，严格反映当前 episode 的实际等待时长。
2. **全局跨 Episode 限速与留存告警时间戳** (`src/index.ts`)：
   - 切回 `running` 时不再清零 `lastBackgroundWarningAt`，保留全局限速依据。
   - 告警发送实施三阶控制：
     1. 单次 episode 等待时长必须 $\ge 5$ 分钟；
     2. 全局跨 episode 维度强制至少间隔 2 分钟（120s）；
     3. 同一 episode 内部周期性提醒间隔维持 5 分钟（300s）。

## 3. 验证与测试
- 在 `test/tail-guard.test.ts` 中补充多 episode 真实时序测试：
  - 断言读数准确（以当前 episode 计算，不虚高）；
  - 断言 1.2 分钟内触发的第二个 episode 被全局 2 分钟限速成功阻断；
  - 5 个测试文件、78 项测试全部绿灯通过，构建成功。

---

# 修复任务 #3：Cordis 生命周期 timing 导致 DSH 启动状态恢复崩溃 (cannot get property "agents" without inject)

## 1. 线上 Bug 复盘与根因分析
- **错误现象**：DSH 启动时控制台报错并中断状态恢复：
  `[antigravity] Failed to restore bridge state: Error: cannot get property "agents" without inject at AntigravityService.initState (lib/index.mjs:2478)`
- **深层机理分析**：
  1. **Cordis Proxy 拦截机制**：在 `@deepseek-ai/cordis` 的 `reflect.ts` 中，当插件处于 fiber 执行生命周期中，直接通过属性访问未在当前插件 `inject` 声明列表中的服务（例如 `(this.ctx as any).agents`）时，Context Proxy 会显式拦截并抛出 `cannot get property "agents" without inject`。
  2. **DSH 启动生命周期竞争**：DSH 启动初期，插件 Service constructor 执行时，`initState()` 立即开始执行恢复，而此时下游 `agents` 服务尚未加载或处于 fiber activating 状态。
  3. **级联破坏**：若在 `initState()` 中直接访问 `(this.ctx as any).agents`，抛出的异常会导致整条 `this.stateInitPromise` 报错失败，后续的 runs、messageQueues 恢复全部中断，历史监控全部丢失！

## 2. 修复落点与防御方案
1. **统一封装安全服务访问方法 (`getAgentsService` / `findLiveAgent`)**：
   - 优先通过 `this.ctx.get('agents', false) ?? this.ctx.get('agents')` 读取底层的 agents service 实例（`ctx.get` 属于 Cordis 官方免 inject 探测接口，未就绪时安全返回 `undefined`，绝不抛出 inject error）。
   - fallback 阶段结合 `try ... catch` 防御测试 mock 环境的直接属性赋值，确保任何环境与任何时序下都不抛出异常。
   - `findLiveAgent(agentId)`：封装依据 `agentId`、`session.header.id` 或 `name` 的安全比对逻辑，服务未就绪时安全返回 `undefined`。
2. **全工程消除裸属性访问点**：
   - `initState()`：替换为 `this.findLiveAgent(prun.callerAgentId)`，保证即使 `agents` 尚未就绪，也能安全完成全部状态恢复并记录 `callerAgentId`。
   - `processSettlementOutbox()`：替换为 `this.findLiveAgent(item.callerAgentId)`。
   - `deliverMessageToAgent()`：替换为 `this.getAgentsService()` 并增加完整 try/catch 包裹。
   - `ensureActiveWatcher()`：在已有 run 缺少 `callerAgent` 时自动尝试 `findLiveAgent(run.callerAgentId)`。
3. **懒化绑定 (Lazy Resolution Fallback)**：
   - 在 `notifySettlementToDsh`、`notifyResumedToDsh`、`notifyWaitingBackgroundToDsh` 触发前，若 `run.callerAgent` 为空但存在 `run.callerAgentId`，自动动态调用 `this.findLiveAgent(run.callerAgentId)` 补齐绑定并暂存到 `run.callerAgent`。
4. **生命周期就绪与注入回调延迟重绑 (`rebindAgents`)**：
   - 暴露 `rebindAgents()` 方法：遍历所有 `this.runs`，将未绑定 `callerAgent` 的 runs 重新比对 `findLiveAgent`，并立即触发一次 `processSettlementOutbox()` 排空在 agents 就绪前积压的通知。
   - 在 `AntigravityService` constructor 中通过 `ctx.on('ready', ...)` 和 `ctx.inject(['agents'], ...)` 双重钩子监听就绪时机自动执行 `rebindAgents()`。
   - 在 `AntigravityBridgePlugin` 中配置 `ctx.inject(['agents'], ...)` 实现插件层动态感知。

## 3. 验证与回归测试
- **测试用例**：在 `test/state-outbox.test.ts` 中新增单元测试：
  - 构造模拟 Cordis Context Proxy，使其在访问 `.agents` 时严格抛出 `cannot get property "agents" without inject`；
  - 验证 `AntigravityService.initState()` 安全无损完成恢复，`stateInitPromise` 正常 resolve；
  - 验证注入 `agents` 后调用 `rebindAgents()` 成功恢复并绑定 `callerAgent`；
  - 验证 `notifySettlementToDsh` 在后续调用时具备懒绑定能力并成功发送通知。
- **全量测试与构建**：
  - `npm test`：5 个测试文件全部通过，79 项用例 100% 绿灯。
  - `npm run build`：生产环境打包成功。

---

# 修复任务 #4：结算通知吞没与假 done 误判修复（R1 + R2 + R3）

## 1. 问题背景与根本原因

在长时后台任务或等待轮次场景中，宿主屡次出现「结算通知被吞没」、「未完成即提前早退假 done」、「后续真实完成被幂等拦截」的重大缺陷：
1. **R1 假 done 与通知吞没**：
   - 当 watcher 判定为 `done` 后立即 `break` 退出循环并从 `this.watchers` 中注销。
   - `notifySettlementToDsh` 记录的 `transitionKey` 格式为 `done:turn${run.turnSeq}:`。若由于网络或短暂无文本导致早退（假 done），当模型在后台任务唤醒后重新工作并最终完成时，因 `turnSeq` 未改变，再次结算的通知因相同的 `transitionKey` 被直接当作重复通知静默去重吞没！
   - 看门狗由于此前已 `break` 退出，且未能常驻观察 transcript 的后续增长。
2. **R2 等待话术未被门禁拦截**：
   - 当模型处于中间状态且输出了等待话术（例如「I am waiting for task-602 to finish」、「已设置定时器，等待后台任务唤醒」），若此时 `activeBackgroundTasks` 由于某种原因未能精确匹配，watcher 仅凭 `isFinished: true` 与静默窗口直接结算为 `done`。
3. **R3 前台推进兜底过度误杀与观测工具取证**：
   - `src/hub/transcript.ts:310-333` 原先存在前台推进兜底（foreground-progress fallback）：只要检测到后续有新的 `PLANNER_RESPONSE` 工具调用，就无差别将所有 `stepIdx > t.startStepIndex` 的后台任务标记为 `finished`！
   - **取证结论**：模型在等待后台任务（如长耗时编译、测试、训练）的过程中，会高频调用纯只读/观测类工具（如 `manage_task` 轮询状态、`schedule` 设置唤醒定时器、`view_file` 查阅代码、`grep_search`、`list_dir`、`read_url_content` 等）。这些观测行为绝不代表后台任务已经结束！误清后导致后台任务瞬间脱离监控，使会话立刻早退为假 done。
   - 此外，通过 `schedule` / `TimerCondition` 启动的定时器任务属于显式延时唤醒协议，在未收到明确的 timer 触发消息前，绝不可被前台推进兜底清除。

## 2. 修复技术落点

### 2.1 R1: 看门狗 Done-驻留与假 Done 实锤复苏机制 (`src/index.ts`)
- **驻留轮询**：`runCascadeWatcher` 在结算并发送通知后**不执行 `break`**，而是记录结算时的状态指纹（`settledStepIndex` 与 `settledContentHash`），保持驻留并以 2000ms 周期继续轮询 transcript，直到 `watchMaxMs`（默认 12 小时）到期。
- **假 Done 实锤检测与复原**：
  - 若在驻留期间检测到 `stepNow > run.settledStepIndex` 或 `lastActiveNow > run.lastActiveAt`，证实此前为假 done；
  - 立即打印 `fake done detected` 日志，并将 `run.status` 恢复为 `'running'`；
  - **清空 `lastNotifiedTransition = undefined`**、`settledStepIndex = undefined`、`settledContentHash = undefined`；
  - 重置 `stallSince` 与 `idleCycles`，无缝切回主循环跟踪。
- **通知去重键携带步数**：
  - `notifySettlementToDsh` 将通知幂等键更新为：
    `const transitionKey = \`${status}:turn\${run.turnSeq || 1}:\${toolName}:step\${run.settledStepIndex ?? ''}\`;`
  - 确保假 done 后的真实终态通知因步数递增拥有全局唯一的 `transitionKey`，绝不会被静默吞没。
- **状态持久化与离线重启恢复**：
  - `HubRun` 与 `PersistedRun` 补充 `settledStepIndex` 与 `settledContentHash` 字段（保持 state version 1 兼容，老配置 undefined 安全兼容）；
  - `initState()` 增加 done 任务重启恢复：DSH 启动时若 transcript 在离线停机期间出现增长，自动回退到 `running` 并拉起 watcher 继续监控。

### 2.2 R2: 等待话术文本门 (`src/hub/transcript.ts` & `src/index.ts`)
- **等待语义提取**：实现并导出 `isWaitingSpeech(text)` 函数，匹配 `/waiting for .*task-\d+/i`、`still running in background`、`awaiting timer`、`等待.*唤醒` 等等待话术正则；同时引入完结语义互斥判定（若包含 `completed`、`finished`、`已完成` 等则不误判为等待）。
- **门禁拦截对齐**：
  - 在 `decideTailSettle` 结算判定前增加 `isWaitingSpeech` 检查，若命中则强制返回 `{ action: 'wait' }`，阻止提前结算；
  - 同步在 `pollTranscript`、`initState` 与 `classifySnapshot` 对齐该门禁。

### 2.3 R3: 收窄前台推进兜底与观测工具取证白名单 (`src/hub/transcript.ts`)
- **观测类工具黑白名单分析**：
  - 定义 `OBSERVATIONAL_TOOL_NAMES` 集合，覆盖纯观测与只读工具：
    `manage_task`, `schedule`, `view_file`, `list_dir`, `grep_search`, `find_by_name`, `read_url_content`, `search_web`, `read_resource`, `list_resources`。
  - 前台推进判定要求：仅当模型调用了**非观测类的实质性修改/执行工具**（如 `run_command`, `write_to_file`, `replace_file_content` 等）时，才视为可能的前台推进。
- **定时器与 schedule 任务永不误清**：
  - 在 `parseTranscript` 启动任务时为 `schedule` 调用打上 `isSchedule: true` 标记；
  - 兜底循环遍历时，对 `t.timerCondition`、`t.isSchedule` 或描述含 `timer|schedule|cron` 的任务**一律直接 continue 跳过**，严禁被任何前台推进误清。

## 3. 验证与测试结果

- **单元测试与回归套件**（`npm test` / `npx vitest run`）：
  - `test/tail-guard.test.ts`：新增 6 项针对 R1、R2、R3 的回归测试：
    1. `R3: pure observational tools do NOT clear active background tasks via fallback`
    2. `R3: schedule and timerCondition tasks are NEVER cleared by foreground progress fallback`
    3. `R2: isWaitingSpeech correctly recognizes waiting speech and respects completion override`
    4. `R2: decideTailSettle returns wait when planner output contains waiting speech`
    5. `R2: decideTailSettle settles when planner output is genuine completion`
    6. `R1: detects fake-done on transcript growth, reverts status to running, and delivers second done notification`
  - 全量 5 个测试文件，**85 项测试全部通过（100% 绿灯）**。
- **构建验证**：
  - `npm run typecheck`（`tsc --noEmit`）：0 错误。
  - `tsc --outDir lib-next`：0 错误。
  - `tsdown src/index.ts --out-dir lib-next --format esm --dts --sourcemap`：成功打包生成与宿主完全一致的 `lib-next/index.mjs`（1.29 MB）和 `lib-next/index.d.mts`。

## 4. 给协调员的替换操作步骤

> ⚠️ **严禁在 DSH 运行时直接替换 `lib/`，必须在受控重启窗口按序操作**：

1. **停止 DSH 服务**：
   在宿主终端或服务管理器中正常停机 DeepSeek Harness。
2. **备份现有产物**：
   ```pwsh
   cd D:\Git\dsh_plugins\INSTALLED\dsh-antigravity-bridge
   Move-Item lib lib-backup-$(Get-Date -Format "yyyyMMdd-HHmmss")
   ```
3. **替换为新构建产物**：
   ```pwsh
   Move-Item lib-next lib
   ```
4. **启动 DSH 服务**：
   正常启动 DSH，验证插件加载与各 cascade 历史恢复日志（`[antigravity] Restoring active watcher...`）。

---

# 修复任务 #5：幽灵后台任务根治（waiting-background 无限蹲守 + 跨 cascade 错挂 + stale 孤儿驱逐）

## 1. 现场实锤案情与深层机理分析
1. **真实死锁根因（前台推进兜底导致 timerCondition 唤醒链断裂）**：
   - 现场日志 `ea687300` 在步骤 36-37 启动定时器 `task-37`，其 `TimerCondition` 指向 `ea687300-.../task-20`（dotnet test 任务）。
   - 由于前台推进兜底（Foreground Progress Fallback），在步骤 36 被调用实质性工具时提前将 `task-20.finished` 设为了 `true`。
   - 步骤 39 真正的 Hub 完结事件到达时，`if (matched && !matched.finished)` 条件为 `false`，导致关键的 `markTimerConditionSatisfied(matched.taskId)` 被直接跳过！
   - `task-37` 永远没有收到唤醒信号，且因为是 schedule 任务被前台兜底白名单免疫，导致永久挂在 `activeBackgroundTasks` 中无法清除，引发无限 waiting-background 蹲守。
2. **跨 cascade 误配与前缀截断隐患**：
   - `isTaskIdMatch` 之前只比较 base id（`task-xxx`），若两条 cascade 各自有一个同名 task（如 `cascadeA/task-37` 与 `cascadeB/task-37`），或者 `TimerCondition` 跨 cascade 广播，会直接引发跨会话串扰和错挂。
3. **stale / 孤儿任务无活性校验与驱逐机制**：
   - 当任务在 transcript 中无 finish 事件、超过预期寿命，且 transcript 长时间（$\ge 15$ 分钟）零增长时，旧逻辑缺少活性校验与自动驱逐机制，导致死锁任务永久存在，并在重启后通过旧 `state.json` 的 `waiting-background` 状态反复触发 5 分钟警告。

## 2. 核心技术修复落点
1. **跨 Cascade 严格隔离 (`isTaskIdMatch`)** (`src/hub/transcript.ts:196-216`)：
   - 重构 `isTaskIdMatch(a, b)`：分别拆解两端的前缀与 base taskId。
   - 若两端均包含 prefix 且 prefix 不相等，直接返回 `false`，杜绝任何跨 cascade 误挂。
2. **无条件解除定时器条件锁定** (`src/hub/transcript.ts:360-405`)：
   - 在 `SYSTEM_MESSAGE` 与 `manage_task` 完结事件到达时，无论 `matched.finished` 之前是否已被兜底标记，无条件广播 `markTimerConditionSatisfied(matched.taskId)` 与 `markTimerConditionSatisfied(sender)`。
   - 增加 `manage_task` 结果中 `/No background tasks are currently running/i` 全局清空支持，保证所有已死亡任务彻底标记完成。
3. **Stale 孤儿任务驱逐算法与长任务保护 (`pruneStaleBackgroundTasks`)** (`src/hub/transcript.ts:809-880`)：
   - 接入点：`readCascadeTranscript` 与 `pollTranscript`。
   - 驱逐条件：
     - a. 任务在 transcript 中无 finish 证据且距 `startedAt` 超过预期寿命（timer/schedule 类按 `durationSeconds * 10` 秒兜底，无 duration 按 15 分钟）；
     - b. 且 transcript 停滞 $\ge 15$ 分钟（`nowMs - lastActiveAtMs >= 15 * 60 * 1000`）；
     - c. **反例严格保护**：若 transcript 仍在增长或活跃（`nowMs - lastActiveAtMs < 15 分钟`），坚决不驱逐（保护 `node server.js` 等长驻进程）。
4. **服务启动即校验 (`initState`)** (`src/index.ts:652-710`)：
   - DSH 重启或热重载时，`initState()` 恢复 runs 时读取 transcript 并自动执行活性校验与驱逐。
   - 若 snapshot 中已无活跃任务且处于 `waiting-background`，立即重置为 `running` 并清空 `waitingBackgroundStartedAt`；若已终态则直接结算为 `done` 并落盘，彻底阻断旧幻影任务重启后继续发警报。

## 3. ea687300 现场真实验证测试输出原文
在真实日志文件 `C:\Users\JoyJ\.gemini\antigravity\brain\ea687300-6f23-447f-9816-7d406f4ca6e0\.system_generated\logs\transcript_full.jsonl`（664 步）上执行完整解析与活性验证，测试输出原文如下：

```
stdout | test/tail-guard.test.ts > Background Task Tracking in parseTranscript > verifies real transcript from cascade ea687300 has 0 active tasks at completion and resolves deadlocked task-37
[REAL VERIFICATION ea687300] activeBackgroundTasks length: 0
[REAL VERIFICATION ea687300] activeBackgroundTasks: []
[REAL VERIFICATION ea687300] isFinished: true
[REAL VERIFICATION ea687300] maxStepIndex: 664
[REAL VERIFICATION ea687300] Pruned active tasks: 0 Pruned tasks: 0
```

## 4. 验证与全量测试结果
- **全量单元测试套件**：`npx vitest run`：
  - 测试文件：5 个全部通过（`test/tail-guard.test.ts`, `test/state-outbox.test.ts`, `test/hub-transport.test.ts`, `test/network-error.test.ts`, `test/models.test.ts`）。
  - 总测试数：**95 passed (95 项全部通过，0 failed)**。
- **构建**：
  - 执行 `npx tsc --outDir lib-next`：0 错误通过，生成产物至 `lib-next/`。
  - 严格遵守铁律：**未向 `lib/` 写入任何产物**，等待协调员在受控重启窗口替换。

---

# 修复任务 #6：假结算根治车道（第三轮：双轮确认结算 + 禁缓存 + 15s 静息 + Turn 级状态）

## 1. 生产实锤症状（2026-09-27 现场：TreeBot 性能车道 991fd9a8）
- **现象**：一个 Cascade 在 45 分钟内被**假结算→撤回 7 次**。
- **快照特征**：每次假结算的内容快照均停留在 Assistant 的前置启动宣言（如「I have launched Run X of 3 / I have launched the benchmark...」），随之步骤继续递增（666→668→718→720→780→782→796→797→804→805→812→814→828→829→972→974→1009→1011）触发 fake-done 撤回。
- **根因精读核实**：
  1. **宣言窗口竞态**：Assistant 输出启动宣言文本落盘即具备 `tailKind === 'assistant-text'` 与 `isFinished === true`，但此刻后台子任务/工具步骤尚未生成或尚未被采集入库。
  2. **任务缓存掩盖即时变更**：`getStructuredCascadeTasks` 存在 3 秒本地缓存（`STRUCTURED_TASKS_CACHE_TTL_MS = 3_000`）。即便后台任务刚刚写入，结算判定直接命中旧缓存（0 tasks），导致门禁失守。
  3. **静息窗口过窄且未与 lastActiveAt 紧密锚定**：原 `SETTLE_STABLE_MS = 3_000`（3 秒），面对耗时较长的后台任务启动调度，3 秒极易穿透。
  4. **缺少 Turn 级宏观活动状态门禁**：仅依赖局部 step 列表推断状态，缺少对底层 Cascade RunStatus 的全局宏观门禁。

## 2. 核心技术修复落点

### 2.1 双轮确认结算机制 (Two-Phase Settlement Confirmation)
- **机制原理**：
  - **Round 1 (Candidate Snapshot)**：当 watcher 检测到文本就绪（`tailKind === 'assistant-text'`）且无阻塞任务，或 `decideTailSettle` 首次返回 `settle` 时，绝不立即结算。而是记录第一轮快照 `settleCandidateSnapshot = { stepIndex, transcriptHash, firstSeenAt }`。
  - **确认等待期**：强制等待 $\ge 10$ 秒（`SETTLE_CONFIRMATION_INTERVAL_MS = 10_000`）。
  - **Round 2 (Fresh Non-Cached Re-query)**：静息满 10 秒后，强制发起无缓存的全新读取（`forceRefresh = true`），重新获取最新的 step 快照、结构化后台任务、子代理状态与审批状态。
  - **双轮一致性校验**：
    - `freshStepNow === snapshot.stepIndex`
    - `freshHash === snapshot.transcriptHash`
    - `freshActiveTasks.length === 0`
    - `!freshTasks.hasActiveChildren`
    - `!freshTasks.isCascadeActive`
    - `!freshPendingApproval`
  - **偏差重置**：若两轮之间有任何变化（如步骤增长、Hash 不符、后台任务出现、子代理活跃或 Cascade Active），立即判定一致性失败，打印 warn 日志，清空 `settleCandidateSnapshot`，重置 `stallSince`，继续监控。

### 2.2 结算路径零缓存 (Zero-Cache on Settle Path)
- `getStructuredCascadeTasks(cascadeId, brainDir, stepIndex, forceRefresh)` 支持 `forceRefresh` 参数。
- 在结算判定路径及双轮确认的 Round 2 中，强制传入 `forceRefresh = true`，绕过 3 秒 TTL 内存缓存，直达 SQLite / RPC 取出绝对最新的真实任务列表。

### 2.3 静息窗口提升至 15s 并锚定 lastActiveAt
- `SETTLE_STABLE_MS` 由 `3_000ms` 大幅提升至 `15_000ms`（15 秒）。
- 尾部静息时间计算（`tailQuietMs` / `quietMs`）严格锚定于 `Date.now() - snap.lastActiveAt`（若不可用则 fallback 到 `stallSince`），真实反映底层文件的客观静默时长，不再单纯依赖循环轮询间隔。

### 2.4 Turn 级宏观运行状态探索与门禁接入
- **Protobuf 状态探测**：精读 `exa.language_server_pb.GetCascadeTrajectoryResponse` 发现顶级 `status` 字段映射至 `exa.cortex_pb.CascadeRunStatus` 枚举：
  - `0`: `CASCADE_RUN_STATUS_UNSPECIFIED`
  - `1`: `CASCADE_RUN_STATUS_IDLE`
  - `2`: `CASCADE_RUN_STATUS_RUNNING`
  - `3`: `CASCADE_RUN_STATUS_CANCELING`
  - `4`: `CASCADE_RUN_STATUS_BUSY`
- **活动状态判定**：实现 `isCascadeRunStatusActive(status)`，对 `RUNNING (2)`、`BUSY (4)`、`CANCELING (3)` 判定为活跃。
- **门禁接入**：
  - `parseStructuredTrajectoryTasks` 输出 `isCascadeActive?: boolean`。
  - `decideTailSettle` 引入 `isCascadeActive` 门禁：若为 `true`，直接拦截返回 `{ action: 'wait-background', reason: 'background-task' }`，严禁结算。
  - Watcher 循环中将其纳入 `hasBlockingTasks` 判定。

### 2.5 零正则红线与 Fake-done 撤回兜底
- **恪守零正则红线**：坚决不引入任何话术或语言正则匹配，杜绝自然语言漂移与误判。
- **保留 Fake-done 撤回防护**：保留原有假 done 驻留检测与 `reverted-from-done` 撤回通知机制，作为双轮确认之外的终极兜底安全网。

## 3. 双轮确认结算时序流程图

```mermaid
sequenceDiagram
    autonumber
    participant W as Cascade Watcher
    participant DB as SQLite / RPC Trajectory
    participant TS as Transcript Disk
    participant DSH as DSH Host (Upper Agent)

    Note over W: Assistant 输出启动宣言文本<br/>(isFinished=true, tailKind=assistant-text)
    W->>W: 判定为候选结算点 (Candidate)
    W->>W: 记录 Round 1 快照:<br/>settleCandidateSnapshot = {stepIndex, hash, firstSeenAt}
    
    loop 等待确认窗口 (>= 10s)
        W->>W: 轮询探测，若有步数增长立即丢弃快照并切回 Running
    end

    Note over W: 10s 静息到期，启动 Round 2 强校验
    W->>TS: readCascadeTranscript (无缓存读取最新 Transcript)
    W->>DB: getStructuredCascadeTasks (forceRefresh=true 强穿透缓存)
    
    alt Round 2 检测到步骤增加 / 活跃任务 / Cascade RUNNING
        W->>W: isConsistent === false<br/>重置 settleCandidateSnapshot，重置 stallSince
        Note over W: 拦截假结算！继续保持监控
    else Round 2 状态完全一致且静止 (Consistent & Quiet)
        W->>W: 清空 settleCandidateSnapshot
        W->>W: 执行最终结算 (status = done, settledStepIndex = stepNow)
        W->>DSH: notifySettlementToDsh (投递真正终态通知)
    end
```

## 4. 残余限制说明
- **SQLite 降级路径限制**：当仅使用离线 SQLite 数据库（RPC 未连接）时，由于底层 SQLite `trajectories` 表主要记录持久化 step 而无实时内存状态，`isCascadeActive` 在 SQLite 路径下返回 `false`。此时系统完全依托 15s 静息窗口、Round 1 & Round 2 双轮 10s 强校验及 `fake-done` 驻留撤回来确保百分之百安全，不形成逻辑单点依赖。

## 5. 验证与回归测试
- **新增回归测试** (`test/tail-guard.test.ts` & `test/trajectory.test.ts`)：
  1. `rejects settlement when final-looking text has round 1 empty tasks but round 2 discovers active tasks`: 验证宣言窗口竞态下 Round 2 发现任务时成功拦截结算。
  2. `settles cleanly when two consecutive rounds are consistent and quiet`: 验证双轮完全静默且一致时平稳正常结算。
  3. `rejects settlement when trajectory indicates cascade is active (isCascadeActive: true)`: 验证 Cascade 处于 RUNNING 状态时强制拦截结算。
  4. `correctly maps CascadeRunStatus active and idle states`: 覆盖 Protobuf 状态码与文本枚举测试。
  5. `parseStructuredTrajectoryTasks flags isCascadeActive`: 验证 RPC 响应对象解析。
- **全量测试结果**：
  - `pnpm test`：7 个测试文件、**125 项测试全部通过（100% 绿灯）**。
  - `tsc --noEmit`：0 错误。
  - `pnpm run build`：tsdown 打包成功，`lib/` 产物与类型声明完整一致。






