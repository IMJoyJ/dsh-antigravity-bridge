# bridge 实现与架构文档

> 状态：**全功能成熟版本**（2026-08-21：包含 8 大工具矩阵 + 后台委托 + DSH 主动通知系统 + IDE 程序化审批 + 12h 长效生命周期守卫 + 消息注入队列与交付确认 + WaitForConversationFullyIdle 空闲完成检测）。
> 设计背景见 [integration-paths.md](integration-paths.md)，协议细节见 [hub-protocol.md](hub-protocol.md) 与 [api-surface.md](api-surface.md)。

## 架构

```
src/
  hub/
    descriptors.gen.ts  # 生成物：80 文件闭包 PACKED_FILES（scripts/gen-descriptors.py）
    registry.ts         # 懒加载单例：fileDesc 按依赖序构建 + createMutableRegistry.addFile
    discovery.ts        # hub 发现：进程扫描 → csrf_token → 监听端口 → __APP_CONFIG__ 校验
    transport.ts        # gRPC-Web over fetch：unary 完整实现（含空消息容错）；server-stream 骨架
    client.ts           # HubClient：类型化封装 (StartCascade, WaitForIdle, HandleCascadeUserInteraction, CancelCascade 等)
    transcript.ts       # transcript.jsonl 解析、状态判定 (PendingApproval, Engaged, Finished) 与轮询
  engine.ts / client.ts / media.ts / models.ts   # localharness 后端（备选）
  storage.ts            # 会话文件读取与多 Agent 层次血统树构建（两后端共享）
  index.ts              # Config + AntigravityService (主动通知、生命周期守卫、消息队列) + 8 大工具注册
```

## 关键实现事实

- **注册表**：80 个描述符、依赖序单遍构建，实测 ~130ms（插件加载时懒构建一次）。
- **传输**：`fetch` + 手工 gRPC-Web 封帧（1B flag + 4B BE len + payload），零原生依赖。trailer 帧（0x80）的 `grpc-status` 非 0 抛错并带 `grpc-message`。
- **空响应处理**：当服务端返回合法的空数据帧时（如 `SendUserCascadeMessage`），客户端正确 decode 为 output 类型的默认实例而非抛错。
- **请求/响应**：`fromJson`（支持枚举名字符串与 camelCase）→ `toBinary`；响应 `fromBinary` → `toJson`。
- **发现**：`Get-CimInstance Win32_Process` 找 `--subclient_type hub`，解析 `--csrf_token`，`Get-NetTCPConnection -OwningProcess` 取候选端口，逐端口 GET `/` 比对 `__APP_CONFIG__.csrfToken`。调用失败（ECONNREFUSED/Unauthenticated）时清缓存重发现并重试一次。配置 `hubAddress` + `hubCsrfToken` 同时给出可跳过发现。
- **delegate 流程**：`StartCascade`（配方见下）→ `SendUserCascadeMessage` → 统一进入 `ensureActiveWatcher` 生命周期管理，同步调用走 `waitCascadeDetailed`。

### StartCascade 最小配方（实测 FULLGRPC 验证）

```json
{
  "cascadeId": "<新 uuid>",
  "source": "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT",
  "trajectoryType": "CORTEX_TRAJECTORY_TYPE_CASCADE",
  "requestedModel": "<MODEL_PLACEHOLDER_Mxx>",
  "customAgentSpec": {
    "codingAgent": { "googleMode": true },
    "cascadeConfig": { "plannerConfig": { "planModel": "<同一占位符>" } }
  },
  "projectEnvConfig": { "projectId": "<project uuid>", "defaultProjectEnvironment": {} }
}
```

两处模型字段（顶层 `requestedModel` 与 `plannerConfig.planModel`）缺一不可，缺了执行器报 "neither PlanModel nor RequestedModel specified"。`workspace_uris` 与 `projectEnvConfig` 互斥（同时给出报 INVALID_ARGUMENT）。占位符枚举名由 `GetAvailableModels` 动态映射（显示 id → `MODEL_*`）。

## 工具面 (Tools Surface) 权威清单

插件默认在 Hub 模式下向 DSH 注册 8 大工具：

| 工具名称 | 作用 | 核心参数 | 关键底层实现 |
|---|---|---|---|
| `antigravity_delegate` | 任务委托（同步阻塞或后台异步） | `task`, `model?`, `project_id?`, `conversation_id?`, `background?` | `client.startCascade` + `client.sendMessage` + 监视器守卫 |
| `antigravity_check_run` | 查询后台任务状态或阻塞等待 | `run_id`, `wait?` (bool/seconds) | 读取注册表/实时 transcript 快照，或 `waitCascadeDetailed` 阻塞等待 |
| `antigravity_send_message` | 发送追加消息或转向指令 | `conversation_id`, `content`, `wait?`, `mode?` (`step-end`/`turn-end`/`interrupt`) | 智能插入判定 + 队列排队 + `confirmMessageDelivered` 落盘确认 |
| `antigravity_respond` | 程序化响应 IDE 审批弹窗 | `run_id`, `confirm`, `scope?` | `client.getCascadeTrajectory` 提取 `requestedInteraction` → `client.handleCascadeUserInteraction` |
| `antigravity_list_models` | 查看模型目录与配额余量 | 无 | `client.getAvailableModels` + lossless JSON 归并 |
| `antigravity_create_project` | 创建关联本地目录的 Project | `name`, `folder_uri` | `client.createProject` (自动生成 UUID) |
| `antigravity_list_conversations` | 检索本地历史会话 | `limit?`, `only_roots?`, `include_subagents?`, `max_depth?`, `parent_id?` | `storage.ts` 解析 `.gemini/antigravity/` 下 `.db` 与 `transcript.jsonl` |
| `antigravity_get_conversation_tree` | 生成会话调用血统树 | `conversation_id?`, `limit?` | `buildConversationGraph` 递归计算 depth，输出 JSON 树 + ASCII 字符树 |

## 进阶特性与演进记录

### 1. IDE 弹窗程序化审批 (`antigravity_respond`)

- **背景**：在复杂或无人值守任务中，Antigravity 执行命令、抓取 URL 或访问工作区外文件时，会在 IDE 弹出交互审批，Cascade 状态挂起并进入 `awaiting-approval`。
- **协议实现**：
  1. 调用 `GetCascadeTrajectory` 获取当前轨迹 steps，倒序查找带有 `requestedInteraction` 的步骤；
  2. 支持各类交互变体映射：
     - `runCommand`：`{ runCommand: { confirm, proposedCommandLine, submittedCommandLine } }`
     - `readUrlContent`：`{ readUrlContent: { confirm } }`
     - `permission` / `filePermission`：`{ permission: { allow: confirm, scope } }`
     - `mcp` / `openBrowserUrl` / `approvalInteraction` 等；
  3. 调用 `HandleCascadeUserInteraction` 提交审批答复，解除 Cascade 挂起。

### 2. DSH 主动推送与通知系统 (Active Settlement & Resumption)

- **主动推送链路**：
  - 当后台 Cascade 状态发生迁移（`awaiting-approval`、`running` (恢复)、`done`、`error`、`timeout`）时，通过 `notifySettlementToDsh` / `notifyResumedToDsh` 主动向 DSH 调用方 Agent 注入结构化卡片；
  - 调度策略：若目标 Agent 为 `idle`，调用 `followup()`；若正在执行，调用 `steer()`；
  - 幂等性：记录 `run.lastNotifiedTransition`，相同状态变更不重复打扰。
- **早期早夭/拒答检测 (`isRefusalOrEarlyDeath`)**：
  - 若 Cascade 在 60 秒内结束，且内容匹配安全拒答正则（`无法协助`、`safety policy`、`cannot assist` 等）或输出过短（<50 字符），系统自动打上 `⚠️ Early Termination / Model Refusal` 标签并立即向 DSH 告警。
- **IDE 审批等待与恢复报警**：
  - 发现 `pendingApproval` 时，立即发出 `🚨 Awaiting User Approval in IDE` 报警，包含待授权工具名、动作与参数详情，提示前往 IDE 或调用 `antigravity_respond`；
  - 授权通过后自动发出 `▶️ Antigravity Cascade Resumed` 恢复通知。

### 3. 智能消息注入与交付确认机制 (`hubSendMessage`)

- **插入模式 (`mode`)**：
  - `'step-end'`（默认）：等待当前正在执行的工具步结束，且仅在 Cascade 真正 engaged 时执行 cancel + inject，避免误打断处于 idle 状态的 Cascade 造成 "User cancelled" 伪错；
  - `'turn-end'`：通过 `messageQueues` 安全排队，等待当前轮次彻底完成后由 `flushMessageQueue` 自动发出；
  - `'interrupt'`：立即打断并注入。
- **交付确认探针 (`confirmMessageDelivered`)**：
  - 针对高并发或特定状态下 Hub 偶尔丢消息的问题，发送后在 8 秒内通过正文特征（`[\p{L}\p{N}]{8,}`）正则探测 `transcript.jsonl`；
  - 若未探测到落盘，自动进行一次 Plain Resend 重试，彻底消除消息静默丢失隐患。

### 4. 12 小时长生命周期监视器 (`runCascadeWatcher`)

- **问题根因**：原先后台 watcher 沿用 `pollTimeoutMs` (300s)，导致长跑任务在 300s 时误触发 `timeout` 并销毁 watcher，后续真正的完成结果无法推送到 DSH。
- **重构方案**：
  - 引入 `watchMaxMs`（默认 43,200,000ms 即 12 小时），watcher 持续跟踪直到最终结算（`done`/`error`）；
  - `pollTimeoutMs` 仅对同步阻塞等待生效；
  - 引入**空闲退避（idle backoff）**：在无新 step 产出时逐步延长检测间隔（最多 5s），大幅降低 CPU 与磁盘 I/O 占用。

### 5. 服务端空闲检测 (WaitForConversationFullyIdle)

- **两阶段检测**：
  - **阶段 1 (engagement guard)**：轮询 `readCascadeTranscript`，确保收到 USER_INPUT 后的首个 MODEL 步，防止执行器未接单时空闲检测立即返回；
  - **阶段 2 (server-side waitForIdle)**：调用 `WaitForConversationFullyIdle`（带 `inactivityTimeoutSeconds` 与 `stabilizationDurationSeconds`），彻底解决 thinking 模型（如 `claude-opus-4-6-thinking`）中间停顿导致的过早收口。

## 联调验证记录

- `smoke-v2.mjs`：进程发现、模型目录、StartCascade、SendMessage、Transcript 轮询通过；
- `smoke-v31.mjs`：engagement guard、WaitForConversationFullyIdle 实测调通；
- `test_chat.mjs` / `test_tree.mjs` / `test_inspect_db.mjs`：多轮对话、层级树构建、数据库元数据读取全部通过；
- 构建与类型检查：`pnpm build`（tsdown bundle）与 `pnpm typecheck`（tsc --noEmit）0 错误通过。

## 配置参考 (cordis.patch.yml)

```yaml
$plugins:
  "@dsh-external/dsh-antigravity-bridge":
    backend: "hub"                          # 后端类型: "hub" (推荐) 或 "localharness"
    defaultModel: "gemini-3.7-flash-tiered" # 默认模型显示 ID
    projectId: "<默认 project uuid>"         # delegate 新建 cascade 的默认归属
    pollTimeoutMs: 300000                   # 同步轮询超时时间 (ms, 默认 300s)
    watchMaxMs: 43200000                    # 后台生命周期监视器绝对上限 (ms, 默认 12h)
    # appDataDir: "C:/Users/User/.gemini/antigravity" # 自定义数据目录
    # hubAddress / hubCsrfToken             # 可选手工覆盖，跳过进程发现
    # binaryPath / protoDir                 # localharness 后端才需要
```

## 已知边界

- **发现平台**：目前自动发现针对 Windows（`Get-CimInstance`/`Get-NetTCPConnection`）；如需 macOS/Linux 需扩展 discovery.ts 对应 ps/lsof 实现（或直接配置 `hubAddress` + `hubCsrfToken`）。
- **流式方法**：`callServerStream` 暂未启用，当前通过高频/长轮询 transcript + waitForIdle 获取完整轨迹。
- **并发能力**：Hub 实例支持多个并发 Cascade，各自维护独立的 UUID 与后台生命周期。
