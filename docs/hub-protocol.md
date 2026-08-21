# Antigravity Hub 本地协议参考

> 基于 Antigravity IDE 2.8.0 / language_server 1.19.4 实测。
> 所有命令、路径、端口号均来自本会话实际探测，可直接复制使用。

## 1. 组件拓扑

```
Antigravity.exe（Electron 主程序）
    │
    ├── language_server.exe --standalone --subclient_type hub
    │   │   hub 实例：持有 OAuth 会话，暴露 gRPC + Web UI
    │   │   数据目录：~/.gemini/antigravity/
    │   │
    │   └── 每窗口独立 LS 实例（IDE daemon）
    │       ~/.gemini/antigravity-ide/daemon/ls_<hash>.json
    │       记录 pid / httpsPort / httpPort / lspPort / csrfToken
    │
    └── resources/app.asar（Electron shell，2.6 MB）
        前端 bundle 实际由 hub 自身 serve（编译进 language_server.exe）
```

**数据目录结构（`~/.gemini/antigravity/`）**

| 路径 | 用途 |
|------|------|
| `conversations/*.db` | 会话 SQLite 数据库 |
| `brain/<conversationId>/.system_generated/logs/transcript.jsonl` | 完整执行轨迹 |
| `brain/<conversationId>/task.md` | 会话标题与任务描述 |
| `bin/agentapi.bat` | 官方 CLI 包装脚本 |
| `antigravity_state.pbtxt` | IDE 状态（onboarding、model 等） |
| `sidecar_data/` | sidecar 运行时数据 |

**每窗口 LS 实例发现文件示例（`~/.gemini/antigravity-ide/daemon/`）**

```json
{
  "pid": 54980,
  "httpsPort": 4776,
  "httpPort": 4777,
  "lspPort": 10844,
  "lsVersion": "1.19.4",
  "csrfToken": "da681fe6-1384-48f4-82e3-a83f5c1be472"
}
```

> 注意：hub 实例（`--subclient_type hub`）**不会**写入 `antigravity-ide/daemon/`，它的端口需通过进程命令行 + 网络扫描获取。

---

## 2. Hub 发现

### 2.1 定位 hub 进程

Windows 下通过 WMI 筛选命令行含 `--subclient_type hub` 的 `language_server.exe`：

```powershell
Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" |
    Where-Object { $_.CommandLine -like '*subclient_type*hub*' } |
    Select-Object ProcessId, CommandLine
```

实测 hub 进程命令行：

```
C:\Users\<User>\AppData\Local\Programs\Antigravity\resources\bin\language_server.exe
    --standalone
    --override_ide_name antigravity
    --subclient_type hub
    --override_ide_version 2.8.0
    --override_user_agent_name antigravity
    --https_server_port 0
    --csrf_token b4d14c85-5ac9-4b6b-9b28-d8049591bedb
    --app_data_dir antigravity
    --api_server_url https://generativelanguage.googleapis.com
    --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com
    --enable_sidecars
```

### 2.2 获取监听端口

```powershell
$hubPid = 83056  # 从上一步获取
Get-NetTCPConnection -OwningProcess $hubPid -State Listen |
    Select-Object LocalAddress, LocalPort
```

实测输出：

| LocalAddress | LocalPort | 实测行为 |
|-------------|-----------|------|
| 127.0.0.1 | 7778 | **主端口**：同端口服务 HTTP/1（Web UI + gRPC-Web）与 h2c gRPC。参数名虽叫 `https_server_port`，实测为明文，无 TLS |
| 127.0.0.1 | 7777 | 用途未明：HTTP GET 返回 400，h2c 握手被拒（`error reading server preface`），两个验证客户端均不需要它 |

> 两个端口均为随机分配（`--https_server_port 0`），每次 IDE 重启会变。

### 2.3 从 Web UI 读取 csrfToken

访问 hub 的 HTTP 入口可拿到前端注入的 `window.__APP_CONFIG__`：

```powershell
(Invoke-WebRequest -Uri "http://127.0.0.1:7778/" -UseBasicParsing).Content |
    Select-String 'csrfToken":"([^"]+)"' |
    ForEach-Object { $_.Matches.Groups[1].Value }
```

返回示例：

```json
{"productName":"antigravity","csrfToken":"b4d14c85-5ac9-4b6b-9b28-d8049591bedb","appVersion":"2.8.0","devMode":false}
```

---

## 3. 鉴权

所有请求必须携带 header：

```
x-codeium-csrf-token: <csrf_token>
```

缺失时返回 gRPC 错误：

```
rpc error: code = Unauthenticated desc = missing CSRF token
```

CSRF token 生命周期与 hub 进程绑定，IDE 重启后失效。

---

## 4. 传输一：原生 gRPC（h2c）

Hub 的 7778 端口同时支持 h2c（明文 HTTP/2）gRPC。Python 示例：

```python
import grpc

channel = grpc.insecure_channel('127.0.0.1:7778')
stub = channel.unary_unary(
    '/exa.language_server_pb.LanguageServerService/GetConversationMetadata',
    request_serializer=lambda x: x.SerializeToString(),
    response_deserializer=GetConversationMetadataResponse.FromString,
)
resp = stub(
    req,
    metadata=[('x-codeium-csrf-token', 'b4d14c85-...')],
    timeout=60
)
```

方法路径格式（从二进制提取的 618 条方法之一）：

```
/exa.language_server_pb.LanguageServerService/GetConversationMetadata
/exa.language_server_pb.LanguageServerService/CreateProject
/exa.language_server_pb.LanguageServerService/StartCascade
/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage
/exa.language_server_pb.LanguageServerService/SearchConversations
```

完整列表见 `agy-recon/grpc-methods.txt`（12 个服务 / 618 个方法）。

---

## 5. 传输二：gRPC-Web

同一端口也支持 gRPC-Web（`application/grpc-web+proto`），适合浏览器/Node fetch 环境。

### 帧格式

| 字节 | 含义 |
|------|------|
| 1 byte flag | `0x00` = 数据帧，`0x80` = trailer 帧 |
| 4 bytes | payload 长度，大端 uint32 |
| N bytes | protobuf payload |

### Node fetch 最小示例

```js
const payload = toBinary(method.input, create(method.input, { conversationId: '...' }));
const frame = Buffer.alloc(5 + payload.length);
frame[0] = 0;                          // 数据帧
frame.writeUInt32BE(payload.length, 1); // 大端长度
frame.set(payload, 5);

const res = await fetch(
  'http://127.0.0.1:7778/exa.language_server_pb.LanguageServerService/GetConversationMetadata',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/grpc-web+proto',
      'x-grpc-web': '1',
      'x-user-agent': 'grpc-web-javascript/0.1',
      'x-codeium-csrf-token': csrf,
    },
    body: frame,
  }
);

// 解析响应帧
const body = Buffer.from(await res.arrayBuffer());
let pos = 0;
while (pos + 5 <= body.length) {
  const flag = body[pos];
  const len = body.readUInt32BE(pos + 1);
  const data = body.subarray(pos + 5, pos + 5 + len);
  if (flag & 0x80) {
    console.log('TRAILER:', data.toString('utf8'));  // grpc-status: 0
  } else {
    const msg = fromBinary(method.output, data);
    console.log(JSON.stringify(msg, null, 2));
  }
  pos += 5 + len;
}
```

---

## 6. agentapi CLI 旁路

`language_server.exe` 内置 `agentapi` 子命令，通过环境变量连接 hub，无需手写 gRPC。

### 环境变量

| 变量 | 说明 |
|------|------|
| `ANTIGRAVITY_LS_ADDRESS` | hub 地址，如 `127.0.0.1:7778` |
| `ANTIGRAVITY_CSRF_TOKEN` | 从 hub 命令行获取的 csrf_token |
| `ANTIGRAVITY_PROJECT_ID` | 项目 ID（`new-conversation` 必需） |

### 命令

```powershell
$env:ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:7778'
$env:ANTIGRAVITY_CSRF_TOKEN = 'b4d14c85-5ac9-4b6b-9b28-d8049591bedb'
$env:ANTIGRAVITY_PROJECT_ID = 'b84c977f-b8e2-4850-93b7-d5f3fce4adeb'

# 新建会话（异步，返回 conversationId）
& "C:\Users\$env:USERNAME\.gemini\antigravity\bin\agentapi.bat" `
    new-conversation --model=flash_lite --title="任务标题" "详细提示词"

# 追加消息
& "C:\Users\$env:USERNAME\.gemini\antigravity\bin\agentapi.bat" `
    send-message <conversationId> "后续消息"

# 读取元数据
& "C:\Users\$env:USERNAME\.gemini\antigravity\bin\agentapi.bat" `
    get-conversation-metadata <conversationId>
```

模型档位（`--model`）：`flash_lite` | `flash` | `pro`

> `new-conversation` 不带 `ANTIGRAVITY_PROJECT_ID` 会报错：`project_id is required when providing project_env_config`。

### 官方入口包装

`~/.gemini/antigravity/bin/agentapi.bat` 内容：

```bat
@echo off
"%LOCALAPPDATA%\Programs\Antigravity\resources\bin\language_server.exe" agentapi %*
```

### 调度器用法

IDE 内部定时任务使用 `multicall schedule`（实测命令行来自运行中的调度进程）：

```powershell
# multicall 要求 JETSKI_APP_DATA_DIR（未设置时报 "JETSKI_APP_DATA_DIR
# environment variable not set"）；指向 hub 数据目录的取值为推测，未实测
$env:JETSKI_APP_DATA_DIR = "$HOME\.gemini\antigravity"
language_server.exe multicall schedule "0 1 * * *" `
    agentapi new-conversation "<prompt>"
```

---

## 7. 结果读取

会话执行是**异步**的。模型回复不会通过 RPC 直接返回，而是落盘到本地日志。

### 轨迹文件

```
~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl
```

每行一个 JSON 对象，关键字段：

| 字段 | 示例值 | 说明 |
|------|--------|------|
| `step_index` | `0, 1, 2...` | 执行步序号 |
| `source` | `USER_EXPLICIT` / `MODEL` / `SYSTEM` | 来源 |
| `type` | `USER_INPUT` / `PLANNER_RESPONSE` / `CHECKPOINT` / `SYSTEM_MESSAGE` | 消息类型 |
| `status` | `DONE` / `RUNNING` | 状态 |
| `created_at` | `2026-08-17T08:51:30Z` | UTC 时间 |
| `content` | `"PONG"` / `"{{ CHECKPOINT 0 }}..."` | 内容 |

### 实测片段

```jsonl
{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-08-17T08:51:30Z","content":"<USER_REQUEST>\nReply with exactly the word: PONG.\n</USER_REQUEST>"}
{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","created_at":"2026-08-17T08:51:30Z","content":"# Conversation History\n..."}
{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-17T08:51:30Z","content":"PONG"}
{"step_index":3,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","created_at":"2026-08-17T08:51:33Z","content":"{{ CHECKPOINT 0 }}\n**The earlier parts...**"}
{"step_index":4,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-08-17T08:52:27Z","content":"<SYSTEM_MESSAGE>\n[Message] ... content=What word did I ask...\n</SYSTEM_MESSAGE>"}
{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-17T08:52:27Z","content":"PONG"}
```

> `SYSTEM_MESSAGE` 是 `send-message` 的实际注入方式（非 `USER_INPUT`）。

---

## 8. 已验证方法清单

### 8.1 gRPC 方法（Python 动态调用验证）

| 方法 | 请求关键字段 | 说明 |
|------|-------------|------|
| `GetConversationMetadata` | `conversation_id: string` | 读取会话完整元数据（workspace、配置、父子链） |
| `CreateProject` | `project: Project` | 创建项目（需 `id`、`name`、`project_resources`） |
| `ReadProject` | `id: string` | 读取项目详情 |
| `DeleteProject` | `id: string` | 删除项目 |
| `SearchConversations` | `query: string`, `limit: int32` | 搜索历史会话 |
| `StartCascade` | `cascade_id: string`, `workspace_uris: []string`, `requested_model: Model` | 启动 agent 执行 |
| `SendUserCascadeMessage` | `cascade_id: string`, `items: TextOrScopeItem[]` | 向会话追加消息 |
| `WaitForConversationFullyIdle` | `conversation_id: string` | 等待会话完全空闲 |
| `GetCascadeTrajectory` | `cascade_id: string` | 获取实时执行轨迹与待审批 interaction |
| `HandleCascadeUserInteraction` | `cascade_id: string`, `interaction: CascadeUserInteraction` | 程序化提交 IDE 弹窗审批响应 |
| `CancelCascadeInvocation` | `cascade_id: string`, `kill_background_tasks: bool` | 取消正在执行的 Cascade 步骤 |

### 8.2 agentapi CLI 命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `new-conversation` | `--model=<flash_lite\|flash\|pro>` `--title=<...>` `[--profile=<...>]` `<prompt>` | 新建异步会话 |
| `send-message` | `<recipient_id>` `<content>` | 追加消息 |
| `get-conversation-metadata` | `<conversation_id>` | 读取元数据 |

### 8.3 注意事项

- `new-conversation` 返回的 `conversationId` 可用于 `get-conversation-metadata` 和后续 `send-message`。
- `send-message` 的消息在 transcript 中表现为 `SYSTEM_MESSAGE`，而非 `USER_INPUT`。
- 模型档位只有三档，无法指定 `gemini-3.7-flash` 等具体模型名。
- 所有写操作（CreateProject、new-conversation）均会同步到 IDE 的本地状态，在 IDE UI 中可见。

---

## 9. 语言服务器启动参数表（集成相关）

从 `language_server.exe --help` 实测整理：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-standalone` | `false` | 独立守护模式，不依赖 IDE 扩展 |
| `-subclient_type` | `""` | 子客户端类型：`hub` / `sdk` / `cli` |
| `-https_server_port` | `0` | HTTPS/gRPC 端口，`0` 表示随机 |
| `-http_server_port` | `0` | HTTP/1 端口，`0` 表示随机 |
| `-csrf_token` | `""` | CSRF 令牌，客户端必须携带 |
| `-app_data_dir` | `"antigravity-ide"` | 应用数据目录（相对于 `~/.gemini`） |
| `-gemini_dir` | `".gemini"` | Gemini 文件根目录（相对于 HomeDir） |
| `-cloud_code_endpoint` | `""` | CCPA API URL，consumer 账户为 `https://daily-cloudcode-pa.googleapis.com` |
| `-api_server_url` | `"http://0.0.0.0:50001"` | API 服务器地址 |
| `-model_api_client_type` | `ccpa` | 模型客户端类型：`ccpa` 或 `gemini` |
| `-override_ide_name` | `""` | 覆盖 IDE 名称（如 `antigravity`） |
| `-override_ide_version` | `""` | 覆盖 IDE 版本号 |
| `-override_user_agent_name` | `""` | 覆盖 HTTP User-Agent |
| `-persistent_mode` | `false` | 持久守护模式：写入发现文件，扩展关闭后不退出 |
| `-headless` | `false` | 无头模式 |
| `-enable_lsp` | `false` | 启用 LSP 协议 |
| `-disable_telemetry` | `false` | 禁用遥测 |

---

## 附录：描述符资产位置

本会话提取的全部 proto 描述符与验证脚本参考位于：

```
agy-recon/
├── descriptors-web/          # 126 个 FileDescriptorProto（base64 解码后）
├── grpc-methods.txt          # 618 条 gRPC 方法路径
├── agy_call2.py              # Python 动态 gRPC 客户端（验证通过）
├── client/call.mjs           # Node gRPC-Web 客户端（验证通过）
└── hub-index.html            # hub Web UI 首页（含 __APP_CONFIG__）
```
