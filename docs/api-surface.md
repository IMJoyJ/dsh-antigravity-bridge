# Hub gRPC API 面参考

## 服务总览

两个数字来源需要区分，**不要混用**：

- **Hub 实际注册**：从 `language_server.exe` 二进制的 gRPC 方法路径表提取
  （`agy-recon/grpc-methods.txt`），共 **12 个服务、618 个方法**——这是
  对 hub 端口真实可调用的面。
- **描述符中另有定义**：前端 bundle 的 126 个描述符里还定义了一批
  hub 并不 serve 的服务——上游 Google API 定义（hub 是它们的客户端）、
  iframe postMessage API（非 gRPC）等。对这些路径调用 hub 不会成功。

### Hub 注册的服务（权威清单）

| 服务 | 方法数 | 说明 |
|------|--------|------|
| `exa.language_server_pb.LanguageServerService` | 293 | IDE 与 hub 的核心交互面（会话、project、级联、sidecar、LSP） |
| `exa.api_server_pb.ApiServerService` | 108 | 云端 API 代理（遥测、模型状态、部署配置） |
| `exa.seat_management_pb.SeatManagementService` | 96 | 席位/许可管理 |
| `exa.extension_server_pb.ExtensionServerService` | 54 | VS Code 扩展协议（webview、picker、设置） |
| `exa.opensearch_clients_pb.KnowledgeBaseService` | 20 | 知识库检索 |
| `exa.index_pb.IndexManagementService` | 19 | 代码索引管理 |
| `exa.remoting.RemotingService` | 8 | 远程/remoting 支持 |
| `exa.analytics_pb.AnalyticsService` | 7 | 分析事件上报 |
| `exa.index_pb.IndexService` | 4 | 代码索引查询 |
| `exa.opensearch_clients_pb.CodeIndexService` | 4 | 代码索引查询 |
| `exa.cascade_plugins_pb.CascadePluginsService` | 3 | 级联插件管理 |
| `exa.dev_pb.DevService` | 2 | 开发调试 |

> 描述符版本（前端 bundle）与二进制可能存在小版本 skew：例如 bundle
> 描述符里 `ApiServerService` 有 114 个方法、`ExtensionServerService`
> 有 53 个，与二进制注册表（108 / 54）略有出入。**以二进制方法表为准**，
> 描述符仅用于消息编解码。

### 描述符中定义但 hub 不 serve 的服务（仅列举，勿对 hub 调用）

| 服务 | 实际角色 |
|------|---------|
| `google.internal.cloud.code.v1internal.JetskiService` | 上游 cloudcode-pa API（loadCodeAssist / onboardUser / fetchAvailableModels），hub 是它的客户端 |
| `google.cloud.aiplatform.master.PredictionService` | 上游 Vertex 预测服务定义 |
| `google.internal.cloud.code.v1internal.PredictionService` | 上游 v1internal 预测封装 |
| `google.longrunning.Operations` | 上游长运行操作 |
| `google.cloud.speech.v1p1beta1.Speech` | 上游语音转录 |
| `gemini_coder.agent_ui_toolkit.iframe.AntigravityApi` / `ExtensionApi` | iframe postMessage API（非 gRPC） |

`LanguageServerService` 的 293 个方法中，**19 个 server-streaming**（见文末）
+ **1 个 client-streaming**（`StreamTerminalShellCommand`）。

## 重点方法详解

以下字段号均经 `dump_desc.py` / `dump_full.py` 对 `third_party__jetski__language_server_pb__language_server.fd.bin` 实测核对。

### GetConversationMetadata

```
GetConversationMetadataRequest  ->  GetConversationMetadataResponse
```

**请求**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `conversation_id` | `string` | 会话 UUID |

**响应**（`GetConversationMetadataResponse.metadata` 为 `CortexTrajectoryMetadata`）

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `workspaces` | `repeated CortexWorkspaceMetadata` | 工作区列表 |
| 2 | `created_at` | `Timestamp` | 创建时间 |
| 3 | `initialization_state_id` | `string` | 初始化状态 ID |
| 5 | `parent_conversation_id` | `string` | 父会话 ID（子 agent 场景） |
| 6 | `root_conversation_id` | `string` | 根会话 ID |
| 7 | `workspace_uris` | `repeated string` | 工作区 URI 列表 |
| 8 | `subagent_spec` | `SubagentSpec` | 子 agent 规格（角色、模型、初始 prompt） |
| 10 | `static_config` | `CustomAgentSpec` | 静态配置（coding_agent、cascade_config 等） |
| 11 | `executable_spec` | `ExecutableScriptSpec` | 可执行脚本规格 |
| 12 | `source_metadata` | `SourceMetadata` | 来源元数据 |
| 15 | `mendel_experiment_ids` | `repeated int32` | 实验 ID 列表 |
| 18 | `project_id` | `string` | 所属 project ID |
| 19 | `environment_id` | `string` | 环境 ID |
| 17 | `nesting_depth` | `int32` | 嵌套深度 |
| 20 | `tags` | `repeated string` | 标签 |

**实测响应片段**（`7e534751-57eb-479f-9e4d-65a8ac3a1e16`）：

```json
{
  "metadata": {
    "workspaces": [{
      "workspace_folder_absolute_uri": "file:///path/to/my-project",
      "git_root_absolute_uri": "file:///path/to/my-project",
      "repository": {},
      "branch_name": "master"
    }],
    "created_at": "2026-08-17T08:51:30.681081Z",
    "initialization_state_id": "ee5d6480-f926-4f8d-bbec-6020081bfbd5",
    "root_conversation_id": "7e534751-57eb-479f-9e4d-65a8ac3a1e16",
    "workspace_uris": ["file:///path/to/my-project"],
    "static_config": {
      "coding_agent": { "google_mode": true },
      "command_execution_policy": "eager",
      "enforced_workspace_validation": false,
      "cascade_config": {
        "planner_config": { "plan_model": "MODEL_PLACEHOLDER_M50" }
      }
    },
    "mendel_experiment_ids": [101551624, 101868197, ...]
  }
}
```

### StartCascade

启动或恢复一个 cascade（agent 执行流）。

```
StartCascadeRequest  ->  StartCascadeResponse
```

**请求关键字段**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `metadata` | `exa.codeium_common_pb.Metadata` | 通用元数据 |
| 2 | `experiment_config` | `exa.codeium_common_pb.ExperimentConfig` | 实验配置 |
| 3 | `base_trajectory_identifier` | `exa.jetski_cortex_pb.BaseTrajectoryIdentifier` | 基础轨迹标识 |
| 4 | `source` | `exa.cortex_pb.CortexTrajectorySource` | 来源 |
| 5 | `trajectory_type` | `exa.cortex_pb.CortexTrajectoryType` | 轨迹类型 |
| 6 | `agent_script_item` | `exa.cortex_pb.AgentScriptItem` | agent 脚本项 |
| 7 | `cascade_id` | `string` | 级联 ID（恢复时传入已有 UUID） |
| 8 | `workspace_uris` | `repeated string` | 工作区 URI |
| 9 | `override_workspace_uris` | `repeated string` | 覆盖工作区 URI |
| 12 | `parent_conversation_id` | `string` | 父会话 ID |
| 14 | `requested_model` | `exa.codeium_common_pb.Model` | 请求的模型 |
| 17 | `project_env_config` | `ProjectEnvironmentConfig` | project 环境配置 |
| 18 | `tags` | `repeated string` | 标签 |
| 19 | `active_profile` | `string` | 生效的 profile |
| 20 | `agent_path` | `string` | agent 路径 |

### SendUserCascadeMessage

向已有 cascade 发送用户消息，实现"接管并继续会话"。

```
SendUserCascadeMessageRequest  ->  SendUserCascadeMessageResponse
```

**请求关键字段**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `cascade_id` | `string` | 目标级联/会话 ID |
| 2 | `items` | `repeated exa.codeium_common_pb.TextOrScopeItem` | 文本或 scope 项 |
| 3 | `metadata` | `exa.codeium_common_pb.Metadata` | 元数据 |
| 4 | `experiment_config` | `exa.codeium_common_pb.ExperimentConfig` | 实验配置 |
| 5 | `cascade_config` | `exa.cortex_pb.CascadeConfig` | 级联配置覆盖 |
| 6 | `images` | `repeated exa.codeium_common_pb.ImageData` | 图片附件 |
| 8 | `blocking` | `bool` | 是否阻塞等待 |
| 9 | `additional_steps` | `repeated .gemini_coder.Step` | 额外步骤 |
| 10 | `artifact_comments` | `repeated ArtifactComment` | 产物评论 |
| 12 | `file_diff_comments` | `repeated FileDiffComment` | 文件 diff 评论 |
| 13 | `file_comments` | `repeated FileComment` | 文件评论 |
| 14 | `media` | `repeated Media` | 多媒体 |
| 19 | `custom_agent_spec` | `exa.cortex_pb.CustomAgentSpec` | 自定义 agent 规格 |
| 23 | `active_profile` | `string` | profile |
| 24 | `user_identity` | `exa.cortex_pb.UserIdentity` | 用户身份 |

> 注：agentapi 的 `send-message` 子命令在底层即调用此方法（或等效 gRPC），已通过实测验证可正确延续上下文。

### Project 管理（CreateProject / ReadProject / UpdateProject / DeleteProject）

**CreateProjectRequest**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `project` | `exa.project_pb.Project` | project 定义 |

**Project 结构**（`exa.project_pb.Project`）

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `id` | `string` | project UUID（调用方生成） |
| 2 | `name` | `string` | 显示名称 |
| 6 | `project_resources` | `Resources` | 资源列表（文件夹 URI） |
| 7 | `environments` | `Environments` | 环境列表 |
| 8 | `project_conversations` | `ProjectConversations` | 关联会话 |
| 9 | `permission_grants` | `PermissionGrants` | 权限授予 |
| 10 | `settings` | `ProjectSettings` | 设置（文件访问策略、沙箱模式等） |
| 11 | `updated_at` | `Timestamp` | 更新时间 |
| 12 | `is_workspace_only` | `bool` | 是否仅工作区 |
| 13 | `archived` | `bool` | 是否归档 |

**Resource 结构**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `folder_uri` | `string` | 文件夹 URI |
| 2 | `google3` | `Google3` | Google3 仓库配置（可选） |
| 3 | `git_folder` | `GitFolder` | Git 仓库配置（可选） |

**实测创建 payload**（`CreateProject` 成功返回 `{}`）：

```json
{
  "project": {
    "id": "a1b2c3d4-0000-4000-8000-d51ec0000001",
    "name": "dsh-recon-test",
    "project_resources": {
      "resources": [
        { "folder_uri": "file:///path/to/my-project" }
      ]
    }
  }
}
```

### ForkConversation / LoadReplayConversation

| 方法 | 请求关键字段 | 用途 |
|------|-------------|------|
| `ForkConversation` | `conversation_id`（string） | 从已有会话 fork 出新分支 |
| `LoadReplayConversation` | `conversation_id`（string） | 加载历史会话用于 replay |

### SearchConversations

```
SearchConversationsRequest  ->  SearchConversationsResponse
```

**请求**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `query` | `string` | 搜索关键词 |
| 2 | `limit` | `int32` | 返回上限 |

### WaitForConversationFullyIdle

阻塞等待指定会话完全空闲（所有级联执行完毕）。

```
WaitForConversationFullyIdleRequest  ->  WaitForConversationFullyIdleResponse
```

**请求**

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `conversation_id` | `string` | 会话 ID |

### CancelCascadeInvocation / ForceStopCascadeTree

| 方法 | 请求关键字段 | 用途 |
|------|-------------|------|
| `CancelCascadeInvocation` | `cascade_id`, `kill_background_tasks` (bool) | 取消当前级联调用（若级联处于 busy 状态可安全中断） |
| `ForceStopCascadeTree` | `cascade_id` | 强制停止整棵级联树（含子 agent） |

### GetCascadeTrajectory

获取 Cascade 实时轨迹步骤（用于解析 `requestedInteraction` 审批项及详细执行步）：

```
GetCascadeTrajectoryRequest -> GetCascadeTrajectoryResponse
```

- **请求**：`cascade_id: string`
- **响应**：`trajectory: CortexTrajectory`（包含 `trajectory_id`, `steps: repeated Step`）

### HandleCascadeUserInteraction

程序化答复 IDE 中的权限审批与交互弹窗（免人工点击）：

```
HandleCascadeUserInteractionRequest -> HandleCascadeUserInteractionResponse
```

- **请求字段**：
  - `cascade_id`: `string`
  - `interaction`: `CascadeUserInteraction` 对象：
    - `trajectory_id`: `string`
    - `step_index`: `int32`
    - 交互变体（Oneof）：
      - `run_command`: `{ confirm: bool, proposed_command_line: string, submitted_command_line: string }`
      - `read_url_content`: `{ confirm: bool }`
      - `permission`: `{ allow: bool, scope: string }`（scope 如 `PERMISSION_SCOPE_ONCE`, `PERMISSION_SCOPE_CONVERSATION` 等）
      - `file_permission`: `{ allow: bool, scope: string, absolute_path_uri: string }`
      - `approval_interaction`: `{ confirm: bool }`
      - `mcp`: `{ confirm: bool }`
      - `open_browser_url`: `{ confirm: bool }`


## 关键配置消息结构摘录

### SubagentSpec（子 agent 规格）

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `type_name` | `string` | 类型名（如 `"self"`） |
| 2 | `role` | `string` | 角色描述 |
| 3 | `initial_prompt` | `string` | 初始 prompt |
| 4 | `inherit` | `bool` | 是否继承父配置 |
| 5 | `branch` | `string` | 分支名 |
| 6 | `workspace_uri` | `string` | 工作区 URI |
| 7 | `model` | `exa.codeium_common_pb.Model` | 模型 |
| 8 | `model_tier` | `ModelTier` | 模型 tier |
| 9 | `run_as_task` | `bool` | 是否以任务运行 |
| 11 | `fork` | `bool` | 是否 fork |

### CustomAgentSpec / StaticConfig

`static_config` 字段的实际类型为 `CustomAgentSpec`（`exa.cortex_pb.CustomAgentSpec`），包含：

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `custom_agent` | `CustomAgentConfig` | 自定义 agent |
| 2 | `coding_agent` | `CodingAgentConfig` | 编码 agent 配置 |
| 3 | `builtin_agent` | `BuiltinAgentConfig` | 内置 agent |
| 5 | `command_execution_policy` | `string` | 命令执行策略（如 `"eager"`） |
| 8 | `enforced_workspace_validation` | `bool` | 是否强制工作区验证 |
| 11 | `cascade_config` | `CascadeConfig` | 级联配置 |

`CodingAgentConfig` 仅两个字段：

| 字段号 | 字段名 | 类型 |
|--------|--------|------|
| 1 | `google_mode` | `bool` |
| 2 | `agentic_mode` | `bool` |

`CascadeConfig` 包含 `planner_config`（`CascadePlannerConfig`），其中：

| 字段号 | 字段名 | 类型 | 说明 |
|--------|--------|------|------|
| 1 | `plan_model` | `exa.codeium_common_pb.Model` | 规划模型 |
| 15 | `requested_model` | `ModelOrAlias` | 请求模型 |
| 28 | `model_name` | `string` | 模型名称 |
| 6 | `max_output_tokens` | `uint32` | 最大输出 token |
| 14 | `truncation_threshold_tokens` | `int32` | 截断阈值 |
| 55 | `autonomous` | `bool` | 是否自主模式 |

## Model 枚举线索

描述符中模型以 `exa.codeium_common_pb.Model` 消息表示，但实际运行时 hub 使用**占位符枚举**：

- 实测 `GetConversationMetadata` 返回 `"MODEL_PLACEHOLDER_M50"`（plan_model）。
- 子 agent 规格中常见 `"MODEL_PLACEHOLDER_M196"`、`"MODEL_PLACEHOLDER_M298"`。
- agentapi CLI 的 `--model` 仅暴露三档：`flash_lite`、`flash`、`pro`，映射到内部占位符由 hub 决定。

因此直接通过 gRPC 调用 `StartCascade` 时，`requested_model` 字段可尝试传入上述占位符字符串，或留空让 hub 按 project/profile 默认选择。

## 流式方法列表

`LanguageServerService` 中标记为 `server_streaming` 的 19 个方法（另有 1 个
client-streaming 方法 `StreamTerminalShellCommand`：客户端上行流式发送终端命令）：

| # | 方法 | 输入类型 | 输出类型 |
|---|------|----------|----------|
| 1 | `SubscribeToSidecars` | `SubscribeToSidecarsRequest` | `SubscribeToSidecarsResponse` |
| 2 | `GetSidecarLogs` | `GetSidecarLogsRequest` | `GetSidecarLogsResponse` |
| 3 | `HandleStreamingCommand` | `HandleStreamingCommandRequest` | `HandleStreamingCommandResponse` |
| 4 | `WatchDirectory` | `WatchDirectoryRequest` | `WatchDirectoryResponse` |
| 5 | `WatchVersionControlState` | `WatchVersionControlStateRequest` | `WatchVersionControlStateResponse` |
| 6 | `StreamUserTrajectoryReactiveUpdates` | `exa.reactive_component_pb.StreamReactiveUpdatesRequest` | `exa.reactive_component_pb.StreamReactiveUpdatesResponse` |
| 7 | `StreamCascadePanelReactiveUpdates` | `exa.reactive_component_pb.StreamReactiveUpdatesRequest` | `exa.reactive_component_pb.StreamReactiveUpdatesResponse` |
| 8 | `StreamCascadeReactiveUpdates` | `exa.reactive_component_pb.StreamReactiveUpdatesRequest` | `exa.reactive_component_pb.StreamReactiveUpdatesResponse` |
| 9 | `StreamCascadeSummariesReactiveUpdates` | `exa.reactive_component_pb.StreamReactiveUpdatesRequest` | `exa.reactive_component_pb.StreamReactiveUpdatesResponse` |
| 10 | `StreamAgentStateUpdates` | `exa.jetski_cortex_pb.StreamAgentStateUpdatesRequest` | `exa.jetski_cortex_pb.StreamAgentStateUpdatesResponse` |
| 11 | `StreamTerminalOutput` | `StreamTerminalOutputRequest` | `StreamTerminalOutputResponse` |
| 12 | `StreamAudioTranscription` | `StartAudioTranscriptionRequest` | `StreamAudioTranscriptionResponse` |
| 13 | `JetboxSubscribeToState` | `JetboxSubscribeToStateRequest` | `JetboxSubscribeToStateResponse` |
| 14 | `JetboxSubscribeToSummaries` | `JetboxSubscribeToSummariesRequest` | `JetboxSubscribeToSummariesResponse` |
| 15 | `JetboxSubscribeToGcertState` | `JetboxSubscribeToGcertStateRequest` | `JetboxSubscribeToGcertStateResponse` |
| 16 | `JetboxSubscribeToOAuthState` | `JetboxSubscribeToOAuthStateRequest` | `JetboxSubscribeToOAuthStateResponse` |
| 17 | `StreamSearchCode` | `SearchCodeRequest` | `StreamSearchCodeResponse` |
| 18 | `ProjectUpdatesStream` | `ProjectUpdatesStreamRequest` | `ProjectUpdatesStreamResponse` |
| 19 | `SetupJetskiChat` | `SetupJetskiChatRequest` | `SetupJetskiChatResponse` |

### gRPC-Web 下消费 server stream

gRPC-Web 的 server-streaming 帧格式与 unary 相同，只是服务端会连续发送多个 `0x00` 数据帧，最后以 `0x80` trailer 帧结束。客户端需循环读取：

```
while (pos + 5 <= body.length) {
  const flag = body[pos];
  const len = body.readUInt32BE(pos + 1);
  const data = body.subarray(pos + 5, pos + 5 + len);
  if (flag & 0x80) {
    // trailer: grpc-status
  } else {
    // 一条 StreamReactiveUpdatesResponse
    const msg = fromBinary(method.output, data);
  }
  pos += 5 + len;
}
```

fetch 的 `Response.body` 为 ReadableStream 时，需按 chunk 边读边解帧；对短流也可等 `res.arrayBuffer()` 全部收到后再解析。
