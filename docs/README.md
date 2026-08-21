# dsh-antigravity-bridge 文档

本目录记录对 Google Antigravity 本地协议的可行性探索与逆向成果，以及插件的演进方向与完整实现规范。

> **当前状态：全功能成熟版本**（8 大工具矩阵 + 后台委托 + DSH 主动结算/恢复通知 + IDE 程序化审批 + 12h 长效生命周期监视器 + 消息注入队列与交付探测 + 服务端 WaitForConversationFullyIdle 空闲检测）。
> 默认 `backend: "hub"`。实现与联调记录见 [implementation.md](implementation.md)。

## 背景问题

本插件最初基于 `localharness.exe`（Google 官方 antigravity-sdk-python 附带的独立 harness 二进制），其 `ModelConfig` 仅支持 `GeminiAPIEndpoint` / `VertexEndpoint`（均需 API key），烧的是 Google Cloud 计费额度，而非 Antigravity 消费版 OAuth 自带的慷慨额度。

逆向结论：**本地运行中的 Antigravity hub 是一个全功能 gRPC 服务，可直接作为客户端接入**，会话运行在 Antigravity 内部、走 IDE 自己的 OAuth 额度，不需要替换二进制、中间人攻击或直连 Google 内部 API。

## 文档索引

| 文档 | 内容 |
|---|---|
| [integration-paths.md](integration-paths.md) | 三条集成路径对比（localharness / dsh-agy 反代 / 本地 hub）与插件改造设计决策 |
| [implementation.md](implementation.md) | **完整实现记录**：架构、StartCascade 配方、8 大工具矩阵、DSH 主动通知系统、HandleCascadeUserInteraction 程序化审批、消息注入与交付确认、12h 生命周期守卫、配置说明 |
| [hub-protocol.md](hub-protocol.md) | Hub 连接参考：进程发现、CSRF 鉴权、h2c 与 gRPC-Web 传输、agentapi CLI、transcript 落盘格式、IDE 交互协议 |
| [descriptor-extraction.md](descriptor-extraction.md) | 126 个 proto 描述符的提取方法与三个实测大坑（段错误根因等） |
| [api-surface.md](api-surface.md) | Hub gRPC API 面参考：12 服务 618 方法总览与重点消息结构（含审批与交互方法） |

## 一分钟速览

- Hub = 运行中的 `language_server.exe --standalone --subclient_type hub`，监听随机本地端口（实测 7778 为主端口：同端口服务 HTTP/1 Web UI、gRPC-Web 与 h2c gRPC，明文无 TLS）。
- 鉴权只需请求头 `x-codeium-csrf-token`，token 在 hub 进程命令行 `--csrf_token` 参数里（也在 Web UI 首页 `window.__APP_CONFIG__` 里）。
- 完整协议定义（126 个 FileDescriptorProto，含 293 方法的 `LanguageServerService`）从 hub 服务的 `main.js` 前端 bundle 提取，recon 工具与产物参考 `agy-recon/` 目录。
- 已实测调通：`GetConversationMetadata`（按 UUID 加载会话）、`CreateProject` / `ReadProject`（新建/读取 project）、`StartCascade` / `SendUserCascadeMessage`（创建/续聊会话）、`WaitForConversationFullyIdle`（空闲等待）、`HandleCascadeUserInteraction`（IDE 弹窗程序化审批）。
- 会话异步执行，结果落盘 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`。

## 工具矩阵速览

1. `antigravity_delegate(task, model?, project_id?, conversation_id?, background?)`：
   - `background: false`：阻塞等待回复；
   - `background: true`：立即返回 `{cascadeId, status:'running'}`，后台守护并在完成/挂起时向 DSH 主动推送通知。
2. `antigravity_check_run(run_id, wait?)`：查询后台运行状态快照；`wait: true` 或数字秒数阻塞等待 transcript 完成。
3. `antigravity_send_message(conversation_id, content, wait?, mode?)`：
   - `mode: 'step-end'`（默认，等待当前步骤结束注入）、`'turn-end'`（安全排队至轮次结束）、`'interrupt'`（立即中断）；
   - `confirmMessageDelivered` 自动探测 transcript.jsonl 并带失败重试。
4. `antigravity_respond(run_id, confirm, scope?)`：程序化答复 IDE 权限审批弹窗（支持命令、URL、文件、MCP、浏览器等交互）。
5. `antigravity_list_models()`：实时查看模型目录与配额余量（`quotaRemainingFraction`/`quotaResetTime`）。
6. `antigravity_create_project(name, folder_uri)`：创建绑定到本地目录的 Antigravity Project。
7. `antigravity_list_conversations(limit?, only_roots?, include_subagents?, max_depth?, parent_id?)`：浏览本地历史会话。
8. `antigravity_get_conversation_tree(conversation_id?, limit?)`：生成多 Agent 层次调用关系血统树（JSON + ASCII 字符图）。

```js
// 1) 后台委托：立即拿到 cascadeId，不阻塞
const { cascadeId } = JSON.parse(
  await antigravity_delegate({ task: "调查 X", background: true })
);
// 2) …… 并行做其他工作 ……
// 3) 运行中转向：以 step-end 模式安全注入指导，并可非阻塞（wait: false）
await antigravity_send_message({ conversation_id: cascadeId, content: "优先关注 Y 模块", wait: false, mode: "step-end" });
// 4) 遇到 IDE 审批阻塞时，可程序化批准（或等待 DSH 收到主动推送后处理）
await antigravity_respond({ run_id: cascadeId, confirm: true, scope: "PERMISSION_SCOPE_ONCE" });
// 5) 需要结果时阻塞等待（亦可通过 DSH 主动推送的 settlement notice 自动唤醒）
const run = await antigravity_check_run({ run_id: cascadeId, wait: true });
```

## recon 产物位置

逆向工程的相关参考产物位于 `agy-recon/` 目录：

| 路径 | 内容 |
|---|---|
| `descriptors-web/` | 126 个 `.fd.bin`（FileDescriptorProto 原始字节）+ `.b64.txt` |
| `agy_call2.py` | Python 动态 gRPC 客户端，可调任意方法（闭包注册 + 依赖修复参考实现） |
| `client/call.mjs` | TS/Node gRPC-Web 客户端（@bufbuild/protobuf，sweep 构建法） |
| `grpcweb-probe.mjs` | 零依赖 gRPC-Web 封帧探针 |
| `grpc-methods.txt` | 全部 618 个 gRPC 方法路径（按服务分组统计） |
| `extract-descs.mjs` | 从 main.js 提取 base64 描述符的脚本 |
| `dump_desc.py` / `dump_full.py` / `list_deps.py` | 描述符浏览工具 |
| `carve/` | Go 二进制描述符凿取器（本路线未用到，存档备用） |

