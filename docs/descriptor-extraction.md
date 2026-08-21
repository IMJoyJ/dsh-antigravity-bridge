# Proto 描述符提取与加载指南

## 结论：描述符在哪

`language_server.exe`（Go / google3 jetski 项目，150 MB）二进制内**裸 FileDescriptorProto 与 gzip 流均扫不到**。`carve/main.go` 对 0x0A+len+".proto" 模式的候选扫描仅命中 google/* 等 well-known 类型（90 个），jetski 自有描述符（exa.*）一个都没出现；随后对 1F 8B gzip 魔数的全二进制扫描也零命中。

真正的描述符来源是 **hub 的 7778 端口服务的 Web UI bundle**。hub 自身 serve 一个 8.9 MB 的 `main.js`（`http://127.0.0.1:7778/main.js`），这是 protobuf-es v2 编译后的前端产物，内部把每个 `.proto` 的 FileDescriptorProto 以 base64 字面量形式内嵌在 `fileDesc("...")`（minified 后别名常为 `nd`）调用中。从中提取出 **126 个完整描述符**，覆盖 jetski 全部 gRPC 服务。

## 提取方法

核心脚本：`agy-recon/extract-descs.mjs`

```js
const re = /\b[a-zA-Z_$][\w$]{0,3}\("([A-Za-z0-9+/=]{100,})"/g;
```

对每个匹配：
1. base64 解码得到字节。
2. 校验首字节为 `0x0A`（FileDescriptorProto 的 field 1，name 字段的 wire tag）。
3. 次字节为 varint 长度（<128，即单字节），后续字节为 `.proto` 文件名。
4. 文件名通过 `/^[a-z0-9_./-]+\.proto$/`  sanity 校验。
5. 去重后按**全路径转 `__` 命名**保存，避免 basename 冲突。

**命名冲突实例**：
- `google/cloud/aiplatform/master/prediction_service.proto`
- `google/internal/cloud/code/v1internal/prediction_service.proto`

若按 basename 保存，后者会覆盖前者，导致后续加载时 `.google.cloud.aiplatform.master.GenerateContentRequest` 解析失败。提取脚本最终保存为：
- `google__cloud__aiplatform__master__prediction_service.fd.bin`
- `google__internal__cloud__code__v1internal__prediction_service.fd.bin`

## 三个实测大坑（后人必踩）

### a. 悬空 public_dependency 索引 → upb 段错误

protobuf-es v2 为了减小 bundle 体积，把 `dependency`（依赖文件名列表）字段整个剥掉了，但**残留了 `public_dependency` 和 `weak_dependency` 索引数组**。这些索引指向已被清空的 dependency 列表，对 upb（Python grpcio 底层）来说是越界访问，直接触发 `0xC0000005`（Access Violation），而不是抛 Python 异常。

**修复**：注册前必须显式清空：

```python
del fd.public_dependency[:]
del fd.weak_dependency[:]
del fd.dependency[:]
# 然后按需重写 dependency
```

### b. 同名 proto 覆盖

如上文所述，`prediction_service.proto`、`content.proto` 等存在同名不同路径的文件。按 basename 保存会导致磁盘文件互相覆盖，闭包加载时随机缺失类型，报错形如：

```
couldn't resolve name '.google.cloud.aiplatform.master.GenerateContentRequest'
```

### c. 依赖重建不能用"包名前缀猜"

最初尝试按"引用类型的包名最长前缀匹配文件"来重建 dependency，结果同一 package 下有多份文件（如 `exa.cortex_pb` 同时包含 `cortex.proto` 和 `options.proto`），导致**假依赖环**：`cortex.proto` 被错误地依赖到 `options.proto`，而后者又依赖 `net/proto2/descriptor.proto`，最终整批文件 stuck。

**正确做法**：建立**全限定类型名 →  owning file** 的精确符号索引。遍历每份描述符的所有 message、enum、nested type，记录 `package.Msg.SubMsg` 到文件名的映射。后续解析 type_name 时直接查表，零猜测。

```python
sym2file = {}
for name, fd in files.items():
    def index_msgs(msgs, prefix):
        for m in msgs:
            fq = prefix + '.' + m.name
            sym2file[fq] = name
            for e in m.enum_type:
                sym2file[fq + '.' + e.name] = name
            index_msgs(m.nested_type, fq)
    for e in fd.enum_type:
        sym2file[fd.package + '.' + e.name] = name
    index_msgs(fd.message_type, fd.package)
```

### d. WKT 与 google3 血统文件

- **WKT（Well-Known Types）**：bundle 里也带了 `google/protobuf/timestamp.proto` 等，但它们的 `dependency` 同样被剥。直接用 protobuf 内置模块的 `serialized_pb` 预注册更干净：
  ```python
  from google.protobuf import timestamp_pb2, any_pb2, ...
  pool.AddSerializedFile(timestamp_pb2.DESCRIPTOR.serialized_pb)
  ```
  随后跳过 bundle 中所有 `google/protobuf/*` 重复文件。

- **google3 血统**：jetski 部分文件（如 `options.proto`）extend `.proto2.FieldOptions`，需要 `net/proto2/proto/descriptor.proto`（package `proto2`）。该文件在 bundle 中存在，必须纳入闭包。

## 闭包概念

全部 126 个描述符并非都需要。以 `LanguageServerService` 为根做**符号级依赖闭包**，实际只需 **74 个文件**即可完整解析该服务及其全部输入输出消息。闭包计算逻辑：

1. 从 ROOT 文件（`third_party/jetski/language_server_pb/language_server.proto`）开始。
2. 对其引用的每个 type_name，查 `sym2file` 得到 owning file，压栈。
3. 递归直到无新文件产生。

## 加载方式

### Python（推荐用于快速验证）

参考 `agy-recon/agy_call2.py`：

1. 用 `DescriptorPool()` 新建空池。
2. 预注册 WKT（通过各 `_pb2` 模块的 `DESCRIPTOR.serialized_pb`）。
3. 对闭包内每份描述符：清 public/weak dep、写 computed dependency、序列化后 `pool.AddSerializedFile()`。
4. 按 dependency 拓扑分轮注册（deps ⊆ registered 时才尝试）。
5. 调用：
   ```python
   svc = pool.FindServiceByName('exa.language_server_pb.LanguageServerService')
   m = next(c for c in svc.methods if c.name == 'GetConversationMetadata')
   ReqCls = message_factory.GetMessageClass(m.input_type)
   RespCls = message_factory.GetMessageClass(m.output_type)
   req = ReqCls()
   json_format.Parse('{"conversation_id":"..."}', req)
   ```

### TypeScript（@bufbuild/protobuf）

参考 `agy-recon/client/call.mjs`：

1. 读取 `.fd.bin`，用 `FileDescriptorProtoSchema` 反序列化得到 `FileDescriptorProto` 对象。
2. 对每份描述符计算依赖（同样用符号索引法）。
3. 转成 base64 字符串后调用 `fileDesc(b64, depDescFiles)` 得到 `DescFile`。
4. 多轮 sweep：已构建的 `DescFile` 作为候选 deps 传给未构建文件，直到收敛。
5. `createFileRegistry(...allDescFiles)` 得到注册表。
6. 用 `registry.getService('exa.language_server_pb.LanguageServerService')` 取服务定义，再用 `create(method.input, json)` + `toBinary` 序列化请求。
7. 通过 fetch 发送 gRPC-Web 帧（`application/grpc-web+proto` + `x-grpc-web: 1` + `x-codeium-csrf-token`）。

**gRPC-Web 帧格式**（ unary）：

```
[0x00] [4-byte uint32BE payload_len] [protobuf payload]
```

响应同理，最后一帧 flag 为 `0x80` 表示 trailer（`grpc-status: 0`）。

## 浏览与调试工具

### dump_desc.py

快速查看某个描述符的服务方法和指定消息字段：

```bash
python dump_desc.py descriptors-web/third_party__jetski__language_server_pb__language_server.fd.bin \
  GetConversationMetadata CreateProject StartCascade
```

输出带 `*` 标记匹配到的方法，以及匹配消息名的字段表（含字段号、repeated 标记、类型）。

### dump_full.py

递归输出某份描述符的全部 message、enum、nested type：

```bash
python dump_full.py descriptors-web/third_party__jetski__project_pb__project.fd.bin
```

### protoc --decode_raw

对未知结构的二进制响应做盲解：

```bash
python -m grpc_tools.protoc --decode_raw < last-response.bin
```

适用于 gRPC-Web 探针阶段，尚未加载描述符时快速查看字段号与 wire 类型。
