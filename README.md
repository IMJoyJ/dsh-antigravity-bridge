# @dsh-external/dsh-antigravity-bridge

Native TypeScript Google Antigravity (Gemini Agent) Bridge for DeepSeek Harness (DSH).

本插件为 DeepSeek Harness 提供连接本地运行中的 **Google Antigravity IDE (language_server hub)** 的全功能原生客户端桥接，会话在 Antigravity 内部执行，消耗 IDE 自带的 OAuth 额度（无需付费 API Key，无封号风险）。

---

## 🌟 核心特性

- **官方原生 Hub 接入**：直接与运行中的 Antigravity `language_server.exe`（Hub 模式）通过 gRPC-Web（纯 fetch 零原生依赖）通信，会话在 IDE 界面完全可见并可实时接管。
- **免 API 费用 & 零封号风险**：完全走 Antigravity 消费版 OAuth 额度，不直调 Google 内部非公开 API，不替换二进制。
- **8 大完整工具矩阵**：覆盖任务委托（阻塞/后台）、会话状态查询、消息注入转向、IDE 程序化审批、项目管理、历史会话检索、层级血统树可视化与模型配额查询。
- **后台委托与生命周期监控**：支持 `background: true` 异步委托，内置 12 小时长效生命周期监视器（`watchMaxMs`），自动处理空闲退避与 IDE 授权挂起。
- **DSH 主动结算与恢复通知**：通过 `followup` / `steer` 主动向 DSH 会话注入结构化结算卡片，支持**早期异常/拒答检测**（`isRefusalOrEarlyDeath`）、IDE 授权等待报警以及授权通过后的自动恢复通知。
- **智能消息注入与交付确认**：支持 `step-end`（安全等待工具步结束）、`turn-end`（队列化等待轮次结束）、`interrupt`（立即中断）三种插入模式，并通过 `transcript.jsonl` 正则文本探测确认真实落盘与失败自动重试。
- **IDE 弹窗程序化审批**：逆向并实现 `HandleCascadeUserInteraction`，支持在无人值守或编排场景下自动响应命令行、URL 读取、文件权限、MCP 工具等交互弹窗。

---

## 🛠️ 提供的工具清单 (Tools Surface)

### 1. `antigravity_delegate`
向 Antigravity 委托任务。
- **参数**：
  - `task` (string, 必需)：任务说明或提示词。
  - `model` (string, 可选)：模型显示 ID（如 `gemini-3.7-flash-tiered`，默认从配置读取）。
  - `project_id` (string, 可选)：目标项目 UUID（若未提供且无 `conversation_id` 则使用配置默认项目）。
  - `conversation_id` (string, 可选)：已有会话/Cascade UUID，提供时在此会话中追加并继续执行。
  - `background` (boolean, 可选)：是否后台异步执行（默认 `false`）。
- **行为**：
  - `background: false`：阻塞等待任务完成（默认 300s 超时），返回最终回复文本；
  - `background: true`：启动会话后立即返回 `{cascadeId, status: 'running', ...}`，并在后台启动生命周期监视器。

### 2. `antigravity_check_run`
查询后台任务状态或阻塞等待完成。
- **参数**：
  - `run_id` (string, 必需)：Cascade UUID。
  - `wait` (boolean | number, 可选)：是否阻塞等待。`true` 默认等待 300s，传入数字代表自定义超时秒数（如 `wait: 30`）。
- **返回**：包含 `cascadeId`, `status` (`running` | `awaiting-approval` | `done` | `error` | `timeout`), `pendingTool`, `lastActiveAt`, `elapsedMs`, `content`, `error` 等字段的结构化对象。

### 3. `antigravity_send_message`
向进行中的 Antigravity 会话发送追加指导或转向消息。
- **参数**：
  - `conversation_id` (string, 必需)：目标 Cascade UUID。
  - `content` (string, 必需)：要发送的消息文本。
  - `wait` (boolean | number, 可选)：是否等待回复（默认 `true`；设为 `false` 可实现非阻塞转向）。
  - `mode` (string, 可选)：注入模式：
    - `'step-end'`（默认，推荐）：安全等待当前正在执行的工具步骤完成后插入；
    - `'turn-end'`：将消息加入队列，安全排队直到整个轮次自然结束；
    - `'interrupt'`：立即打断当前执行并注入。
- **交付保证**：内置 `confirmMessageDelivered` 机制，自动校验消息是否成功写入 `transcript.jsonl`，若因并发竞态未落盘会自动重试一次。

### 4. `antigravity_respond`
程序化响应 Antigravity IDE 中挂起的权限与交互弹窗（免去人工在 IDE 中点击授权）。
- **参数**：
  - `run_id` (string, 必需)：处于 `awaiting-approval` 状态的 Cascade UUID。
  - `confirm` (boolean, 必需)：`true` 同意/授权，`false` 拒绝。
  - `scope` (string, 可选)：授权范围（如 `PERMISSION_SCOPE_ONCE`, `PERMISSION_SCOPE_CONVERSATION`, `PERMISSION_SCOPE_WORKSPACE`, `PERMISSION_SCOPE_PROJECT`, `PERMISSION_SCOPE_GLOBAL`，默认为单次授权）。
- **支持类型**：`runCommand`（终端命令）、`readUrlContent`（网页抓取）、`filePermission` / `permission`（文件与系统资源权限）、`mcp`（MCP 工具调用）、`openBrowserUrl`、`approvalInteraction` 等。

### 5. `antigravity_list_models`
获取本地 Antigravity Hub 当前可用的全部模型列表，包含实时配额比例（`quotaRemainingFraction`）、配额重置时间（`quotaResetTime`）、支持多模态与上下文窗口等。

### 6. `antigravity_create_project`
在 Hub 侧创建一个绑定到本地文件夹的新 Project，返回生成的 `projectId`，供 `antigravity_delegate` 使用。
- **参数**：
  - `name` (string, 必需)：项目名称。
  - `folder_uri` (string, 必需)：本地绝对路径 URI（如 `file:///d:/myproject`）。

### 7. `antigravity_list_conversations`
从本地数据目录（`~/.gemini/antigravity`）检索历史会话列表，支持按根会话过滤（`only_roots`）、包含子 Agent（`include_subagents`）、最大深度（`maxDepth`）及父会话 ID（`parent_id`）过滤。

### 8. `antigravity_get_conversation_tree`
可视化生成 Antigravity 会话的树状层级关系（包含 JSON 树与直观的 ASCII 字符树），清晰展现主会话与子 Agent 之间的调用派生链。

---

## 📡 DSH 主动推送与后台生命周期系统

当使用后台委托（`background: true`）或会话进入长时间运行时，插件提供统一的生命周期看护：

```
[Start Cascade]
       │
       ▼
[Active Watcher Loop] (watchMaxMs: 12h, idle backoff)
       │
       ├──► 遇到权限弹窗 ──► status: awaiting-approval ──► DSH 主动推送 🚨 报警通知
       │                                                      │
       │                                   用户 IDE 点击 / antigravity_respond 授权
       │                                                      │
       │                                                      ▼
       ├──◄ 恢复执行 ◄────── status: running ◄────── DSH 主动推送 ▶️ 恢复通知
       │
       ├──► 遇到报错 ────► status: error ──────────► DSH 主动推送 ❌ 错误通知
       │
       ├──► 早期拒答 ────► isRefusalOrEarlyDeath ──► DSH 主动推送 ⚠️ 早夭/拒答警告
       │
       └──► 成功结束 ────► status: done ───────────► DSH 主动推送 ✅ 结算通知
```

- **主动通知注入**：利用 DSH 的 `targetAgent.followup`（空闲时）或 `targetAgent.steer`（运行中），将结果结构化推入对话上下文。
- **幂等防护**：状态机记录 `lastNotifiedTransition`，相同状态变更绝不重复通知。
- **事件总线集成**：向 Cordis 上下文广播 `antigravity/settled` 与 `antigravity/resumed` 事件，便于其他插件监听联动。

---

## ⚙️ 配置参考 (`cordis.patch.yml`)

```yaml
$plugins:
  "@dsh-external/dsh-antigravity-bridge":
    backend: "hub"                          # 后端模式: "hub" (默认, 走本地 IDE) 或 "localharness" (走独立 SDK 二进制)
    defaultModel: "gemini-3.7-flash-tiered" # 默认模型显示 ID
    projectId: "a1b2c3d4-0000-4000-8000-d51ec0000001" # 默认项目 UUID (新建 cascade 时使用)
    pollTimeoutMs: 300000                   # 同步轮询超时时间 (ms, 默认 300s)
    watchMaxMs: 43200000                    # 后台生命周期监视器绝对上限 (ms, 默认 12 小时)
    # appDataDir: "C:/Users/User/.gemini/antigravity" # 自定义数据目录 (可选)
    # hubAddress: "127.0.0.1:7778"          # 手动指定 hub 地址 (跳过自动发现)
    # hubCsrfToken: "your-csrf-token"       # 手动指定 CSRF token
    # binaryPath: "./bin/localharness.exe"  # localharness 后端二进制路径
    # protoDir: "./proto"                   # localharness 后端 proto 路径
```

---

## 📂 项目结构与架构

```
dsh-antigravity-bridge/
├── bin/                          # 备选 localharness 放置目录（README.md）
├── docs/                         # 深度协议与逆向参考文档
│   ├── README.md                 # 文档入口
│   ├── implementation.md         # 架构与实现演进记录
│   ├── hub-protocol.md           # Hub 发现、鉴权、传输协议与 CLI 参考
│   ├── api-surface.md            # Hub 618 个 gRPC 方法面与结构详解
│   ├── descriptor-extraction.md  # 描述符提取、依赖重建与踩坑记录
│   └── integration-paths.md      # 集成方案选型与架构设计
├── proto/                        # localharness 后端 protobuf 定义
├── src/
│   ├── hub/
│   │   ├── client.ts             # HubClient 封装 (StartCascade, WaitForIdle, HandleApproval 等)
│   │   ├── descriptors.gen.ts    # 预打包生成的 80 个 proto 描述符闭包
│   │   ├── discovery.ts          # Hub 进程扫描、PID 端口匹配与 CSRF 校验
│   │   ├── registry.ts           # @bufbuild/protobuf 描述符注册表单例
│   │   ├── transcript.ts         # transcript.jsonl 解析与状态探测 (PendingApproval / Engaged / Finished)
│   │   └── transport.ts          # gRPC-Web over fetch 编解码与封帧
│   ├── client.ts / engine.ts     # localharness 备选后端实现
│   ├── storage.ts                # 本地会话存储读取与血统树构建
│   ├── models.ts                 # 模型元数据与别名规范化
│   ├── media.ts                  # 多模态输入适配
│   └── index.ts                  # 插件主入口、Cordis 服务与 8 大工具注册
├── cordis.patch.yml              # DSH 插件配置文件
├── package.json
└── tsconfig.json
```

---

## 📚 详细文档索引

- [docs/README.md](docs/README.md)：文档导航与速查。
- [docs/implementation.md](docs/implementation.md)：全版本（v2 ~ v3.3）完整实现细节、StartCascade 配方、审批 RPC、通知系统与优化历程。
- [docs/hub-protocol.md](docs/hub-protocol.md)：Hub 进程发现机制、CSRF 鉴权、gRPC-Web 封帧规范与 `agentapi` 交互。
- [docs/api-surface.md](docs/api-surface.md)：Hub 12 个服务 618 个 gRPC 方法权威总览与核心消息结构。
- [docs/descriptor-extraction.md](docs/descriptor-extraction.md)：Proto 描述符提取、upb 段错误根因、符号依赖构建技术指南。
- [docs/integration-paths.md](docs/integration-paths.md)：三条集成路径权衡与架构决策记录。

---

## 📄 许可证

MIT License
