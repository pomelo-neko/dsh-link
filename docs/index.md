# dsh-link documentation

Entry points, in the order most readers want them:

| Document | 内容 |
|---|---|
| [`../README.md`](../README.md) · [`../README.zh-CN.md`](../README.zh-CN.md) | Overview, quick start, command reference, security model |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 组件地图、状态文件、消息与唤醒链路、判据速查 |
| [`OPERATIONS.md`](OPERATIONS.md) | 部署、升级、常驻、巡检、令牌轮换、唤醒排障 |
| [`DSH-INTEGRATION.md`](DSH-INTEGRATION.md) | MCP 条目、技能安装、桥插件安装、profile patch 机制 |
| [`DSH-ACCESS.md`](DSH-ACCESS.md) | 0.3 的只读视图 / 转录 / 动作能力：开关、威胁模型、建议组合 |
| [`PROTOCOL.md`](PROTOCOL.md) | HTTP API 与消息/文件线协议 |
| [`DESIGN.md`](DESIGN.md) | 设计取舍（为什么是这样） |
| [`FRP.md`](FRP.md) | frps 部署、STCP provider/visitor、TLS、混用手工 frpc 的坑 |
| [`WAN-VERIFICATION.md`](WAN-VERIFICATION.md) | 跨公网实测记录与复现步骤 |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | 症状 → 原因 → 处理，附一分钟体检清单 |
| [`../SECURITY.md`](../SECURITY.md) | 信任模型与加固清单 |
| [`../AIGC-Notice.md`](../AIGC-Notice.md) | AIGC 声明：本仓库完全由 AI 生成与维护 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本历史 |

Also useful:

- [`../integrations/dsh-link-bridge/README.md`](../integrations/dsh-link-bridge/README.md) — the bridge plugin in detail (configuration, state file, self-check).
- [`../examples/`](../examples/) — sanitised config samples.
- [`../vendor/README.md`](../vendor/README.md) — where to get the frp binaries.
