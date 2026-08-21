# Binaries Directory

默认主后端为 `backend: "hub"`（直接连接本地 Antigravity IDE 的 language_server gRPC 服务，消耗 IDE 的 OAuth 额度）。

若显式配置使用 `backend: "localharness"`（通过 Google Cloud API Key 调用），可将 Google 官方 antigravity-sdk-python 附带的 `localharness.exe` 放置于此目录，或在 `cordis.patch.yml` 中指定 `binaryPath`。
