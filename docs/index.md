# dsh-link documentation

Entry points, in the order most readers want them:

| Document | 内容 |
|---|---|
| [`../README.md`](../README.md) · [`../README.zh-CN.md`](../README.zh-CN.md) | Overview, quick start, command reference, security model |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 组件地图、状态文件、消息与唤醒链路、判据速查（0.8 hub 目标架构 + 当前 0.7 说明） |
| [`HUB-TOPOLOGY-DESIGN.md`](HUB-TOPOLOGY-DESIGN.md) | 0.8 中心服务器（hub）拓扑设计稿：动机、新拓扑、数据流、Hub API、FRP/配置、安全、迁移阶段与待拍板问题 |
| [`HUB-CONSOLE.md`](HUB-CONSOLE.md) | 0.8 hub 自带 Web 控制台：`/ui` 登录、enroll 令牌生成/吊销、状态监控、缓存区重投/丢弃、设置管理、admin API 与安全边界 |
| [`OPERATIONS.md`](OPERATIONS.md) | 部署、升级、常驻、巡检、令牌轮换、唤醒排障 |
| [`DSH-INTEGRATION.md`](DSH-INTEGRATION.md) | MCP 条目、技能安装、桥插件安装、profile patch 机制 |
| [`DSH-ACCESS.md`](DSH-ACCESS.md) | 0.3 的只读视图 / 转录 / 动作能力：开关、威胁模型、建议组合 |
| [`PROTOCOL.md`](PROTOCOL.md) | HTTP API 与消息/文件线协议 |
| [`GATEWAY.md`](GATEWAY.md) | 0.7 回环令牌网关：为什么需要、8788 反代、角色策略、手机/STCP provider 接法、排障 |
| [`DESIGN.md`](DESIGN.md) | 设计取舍（为什么是这样） |
| [`FRP.md`](FRP.md) | frps 部署、STCP provider/visitor、TLS、混用手工 frpc 的坑 |
| [`WAN-VERIFICATION.md`](WAN-VERIFICATION.md) | 跨公网实测记录与复现步骤 |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | 症状 → 原因 → 处理，附一分钟体检清单 |
| [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) | 0.4 安全审计 + 0.5.0 修复状态：信任边界、token 角色、回环/FRP 绕过、残余风险 |
| [`DIRECTED-SESSIONS.md`](DIRECTED-SESSIONS.md) | 0.4 定向会话：targetSession/originSession、绑定、桥策略、回退与线格式 |
| [`MOBILE-CONTROL-FEASIBILITY.md`](MOBILE-CONTROL-FEASIBILITY.md) · [`mobile/API-SKETCH.md`](mobile/API-SKETCH.md) | 安卓控制端可行性、架构评分、同步协议与 API 草案 |
| [`mobile/CONTROL-APP.md`](mobile/CONTROL-APP.md) · [`../android/README.md`](../android/README.md) | 安卓控制端（App 0.4.0，节点/hub 0.8.0）：直连节点与 hub 双入口、节点选择、子智能体标注、工具折叠、构建/安装、验证记录 |
| [`../SECURITY.md`](../SECURITY.md) | 信任模型与加固清单 |
| [`../AIGC-Notice.md`](../AIGC-Notice.md) | AIGC 声明：本仓库完全由 AI 生成与维护 |
| [`../CHANGELOG.md`](../CHANGELOG.md) | 版本历史 |

Also useful:

- [`../integrations/dsh-link-bridge/README.md`](../integrations/dsh-link-bridge/README.md) — the bridge plugin in detail (configuration, state file, self-check).
- [`../examples/`](../examples/) — sanitised config samples.
- [`../vendor/README.md`](../vendor/README.md) — where to get the frp binaries.
