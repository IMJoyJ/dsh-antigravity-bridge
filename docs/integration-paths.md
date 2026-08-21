# 集成路径对比与插件改造设计

> **状态（2026-08-17）：已定稿并实现**。本文是设计决策记录；实现细节、
> 评审修复与联调记录见 [implementation.md](implementation.md)。
>
> 结论：**主路径切换为"本地 hub 客户端"**，localharness 降级为显式配置
> API key 时的备选后端，dsh-agy 式直连内部 API 不采用。

## 三条路径对比

| 维度 | A. localharness（现 bridge） | B. dsh-agy 直连内部 API | C. 本地 hub 客户端（选定） |
|---|---|---|---|
| 原理 | spawn SDK 自带 harness 二进制，protobuf 握手后 WebSocket 驱动会话 | 用 agy 公开 client_id 走 OAuth，伪装客户端直调 `daily-cloudcode-pa.googleapis.com/v1internal` | 连接运行中的 `language_server.exe` hub，走官方 gRPC 接口 |
| 额度来源 | Gemini API key / Vertex（**真金白银**） | agy 消费版 OAuth 额度 | agy 消费版 OAuth 额度（IDE 同一份登录态） |
| 会话归属 | 独立 harness 进程 | 无会话（纯 LLM 补全） | **Antigravity 内部**，IDE 可见、可接管 |
| 能力面 | 全功能：自定义工具、系统提示、workspace、流式事件 | LLM 适配器级（generateContent） | Hub 全协议：project/会话/cascade 管理 + 流式轨迹 |
| 合规风险 | 无（官方 SDK）但费钱 | 灰区：伪装客户端调内部 API，有封号风险 | 低：官方本地 IPC 面，IDE 调度器自己也这么用 |
| 依赖 | 捆绑 121MB 二进制 | 无本地依赖 | 需要 Antigravity 在运行（或可自 spawn LS 实例） |

### 为什么不是 B（dsh-agy）

dsh-agy 的 OAuth 部分本身干净（PKCE + loopback，公开 client_id），但之后
的行为是直接以客户端身份调用 Google 内部 `v1internal` 端点——这正是各类
反代项目（OmniRoute/opencode 插件）同源的模式，Google 可按 ToS 封号。
用户的 agy 额度是主资产，不为省工程成本冒险。

### 为什么是 C

- 官方性：`agentapi` 子命令与 `multicall schedule` 调度器证明这条本地
  gRPC 面是 Google 自己在一线上用的（IDE 定时任务就是
  `language_server.exe multicall schedule ... agentapi new-conversation`）。
- 额度正确：所有模型调用由 hub 以 IDE 的 OAuth 身份发出。
- 会话正统：会话出现在 IDE 会话列表，可在 IDE 里继续——满足"所有
  session 运行在 agy 里"。
- 能力足够：618 个方法覆盖 project 管理、会话加载/续聊、cascade 控制、
  流式更新，远超 agentapi 三命令。

### A 的保留价值

localharness 提供 hub 路径没有的东西：给 agent 注册**自定义工具**、完全
自定义系统提示、细粒度流式事件。若用户愿意配 API key（或将来 hub 协议
证明某能力缺失），作为 `backend: "localharness"` 显式备选保留。

## 插件改造设计（bridge v2）

```
src/
  hub/
    discovery.ts   # 进程扫描：Win32_Process 找 --subclient_type hub，
                   # 解析 --csrf_token；按 PID 查监听端口；
                   # 校验 GET / 的 __APP_CONFIG__.csrfToken 一致
    transport.ts   # gRPC-Web over fetch（HTTP/1，零原生依赖）
                   # 帧: 1B flag + 4B BE len + payload；0x80 = trailer
    descriptors.ts # 内嵌 74 文件闭包 base64；启动时 fileDesc + sweep 构建
                   # createFileRegistry（先清 public_dependency！）
    client.ts      # callUnary(service, method, json) / callServerStream(...)
  backends/
    hub.ts         # AntigravityBackend 实现：本设计主体
    localharness.ts# 现有 engine.ts/client.ts 平移，API-key 备选
  storage.ts       # 现有：conversations/brain 目录读取（保留）
  index.ts         # 插件壳：注册 antigravity_* 工具 + system prompt
```

关键实现决策：

1. **传输选 gRPC-Web 而非 h2c gRPC**：纯 fetch 实现（约 60 行封帧），
   无 `@grpc/grpc-js` 原生依赖；h2c 留作性能不够时的升级位。
   server-streaming 在 gRPC-Web 下按帧顺序读即可。
2. **描述符随插件打包**：74 个闭包文件的 base64 约 600KB，构建期从
   `agy-recon/descriptors-web` 生成单个 `descriptors.ts`。**注册前必须
   清掉 `public_dependency`/`weak_dependency`**（否则 upb 段错误，
   见 descriptor-extraction.md），依赖按"全限定类型名→文件"符号索引重建。
3. **发现失败回退**：找不到 hub 进程时，提示用户启动 Antigravity；
   二期再评估自 spawn `language_server.exe --standalone`（与 IDE 共享
   `~/.gemini` 登录态，需实测同 app_data_dir 双实例冲突）。
4. **异步会话模型**：`StartCascade`/`SendUserCascadeMessage` 立即返回，
   用 `WaitForConversationFullyIdle` 轮询或
   `StreamCascadeReactiveUpdates` 订阅；磁盘 transcript.jsonl 作为
   兜底/调试读道。
5. **写操作守卫**：CreateProject/DeleteProject 等在工具描述里标清
   副作用；默认模型走 hub 侧选择的档位，不传 `requested_model`。

### 工具面（对模型暴露）

保留并扩展现有 4 个工具：

| 工具 | 后端 RPC | 状态 |
|---|---|---|
| `antigravity_list_models` | `GetAvailableModels`（hub） | 改接 |
| `antigravity_list_conversations` | 文件系统（storage.ts）/ `SearchConversations` | 保留+增强 |
| `antigravity_get_conversation_tree` | 文件系统（storage.ts） | 保留 |
| `antigravity_delegate` | `StartCascade` + `WaitForConversationFullyIdle` | 改接 |
| `antigravity_create_project`（新） | `CreateProject` | 新增 |
| `antigravity_send_message`（新） | `SendUserCascadeMessage`（按 UUID 续聊） | 新增 |

## 已知边界（一期不做）

- 模型只能粗粒度选档（agentapi 的 `flash_lite|flash|pro`）；`StartCascade`
  的 `requested_model`（`codeium_common_pb.Model` 枚举，含
  `MODEL_PLACEHOLDER_M196` 等占位符）映射表需后续观察建立。
- `new-conversation` 无 workspace 参数（继承 project 配置）；精细控制走
  `StartCascadeRequest.workspace_uris`，需实测。
- hub 进程重启 → csrf_token/端口变化，客户端需每次会话前重新发现。
- 同一 hub 的并发 cascade 数未见文档，按 agentapi 调度器用法推断支持
  多会话并行，上限待压测。
