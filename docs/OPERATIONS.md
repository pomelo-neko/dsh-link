# 运维手册

面向"已经跑起来、要长期稳定运行"的部署。首次安装看 [`../README.md`](../README.md)，
组件与状态文件的位置看 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 1. 新机器部署清单

```powershell
# 1) 依赖：只需要 Node >= 20
node --version

# 2) 节点身份（生成入站 token 与 STCP 身份，打印一次明文，务必当次留档）
node bin\dshlink.mjs init --name alice-pc --port 8787 --root ws=D:\ws --allow-upload

# 3) 常驻（先确认 8787 能起来）
node bin\dshlink.mjs serve

# 4) 自检：config / 端口 / MCP / 对端 / 隧道 / DSH 视图，任一 fail 都会非 0 退出
node bin\dshlink.mjs doctor
```

接入 DSH（MCP 条目 + 技能 + 可选桥）：`node bin\dshlink.mjs install-dsh --profile web --write`；
要自动唤醒再加 `--bridge --bridge-workspace "D:\dshlink-bridge"`，然后**重启一次 DSH host**。

## 2. 常驻与开机自启

Windows：

```powershell
scripts\start-dshlink.cmd          # 幂等：8787 没在听就拉起节点，frpc 没跑就拉起 frpc（全程隐藏窗口）
```

把 `scripts\start-dshlink.vbs` 注册成计划任务（登录触发 + 每 15 分钟兜底）即可。Linux 用 systemd：
`ExecStart=/usr/bin/node <repo>/bin/dshlink.mjs serve`。

> **坑 1：节点必须由"外部进程"启动。**
> 在 DSH 的 agent 工具调用里用 `Start-Process`/`wscript` 起的 node 属于那次调用的进程树，
> 调用结束会被静默回收——现象是"节点起来几十秒后 8787 又空了"。正确做法是计划任务、
> 服务、或资源管理器双击 `.vbs`。
>
> **坑 2：`dsh.home` 要写绝对路径。**
> 计划任务/服务启动的进程没有 `DSH_HOME`，`resolveDshHome()` 会退回 `~/.dsh`，
> 于是节点读到的是**另一套 DSH** 的工作区与对话（`doctor` 会在没写绝对路径时告警）。
> 首次配置就写死 `"home": "D:\\DSH"`。
>
> **坑 3：`excludeWorkspaces` 是精确匹配。**
> 它比 workspace id / 标题 / 归一化绝对路径（大小写不敏感），**不是前缀**。要写全路径，
> 并把节点数据目录和桥工作区都列进去——节点数据目录含 `peers[].token` 明文与 frp 密钥。

## 3. 升级

| 升级对象 | 步骤 | 是否需要重启 |
|---|---|---|
| 节点 / CLI（`bin/`、`src/`） | 覆盖文件 → 重启节点进程（计划任务或 `serve`） | 需要 |
| 桥插件（`integrations/dsh-link-bridge/`） | 覆盖文件 → **重启 DSH host**（会中断所有会话） | 需要 |
| 配置（peers/tokens/roots/`dsh`/`capabilities`） | 直接改文件 | **不需要**（热重载） |
| `bind`/`port`/`limits.requestTimeoutMs`、frpc 进程 | 改配置 → 重启节点 / `tunnel stop && tunnel sync` | 需要 |

升级前后各做一次：

```powershell
node bin\dshlink.mjs --version          # 节点版本
node bin\dshlink.mjs doctor             # 本机体检
node bin\dshlink.mjs peers ping         # 对端 softwareVersion —— 两端版本差异要心里有数
```

> 桥的"升级"只有重启 host 才能装载新代码；配置改动则即时生效（profile patch 是 live 重载）。

## 4. 定期巡检

```powershell
node bin\dshlink.mjs doctor --json                     # 一把梭
node bin\dshlink.mjs status --json                     # runtime.configReloads / peers
node bin\dshlink.mjs outbox list --json                # 还有多少 pending
Get-Item "$env:DSH_HOME\plugin-data\dsh-link-bridge\state.json" | Select LastWriteTime
```

判据：

- `doctor` 无 fail；warn 要能解释（例如"没配隧道"在纯局域网部署里是正常的）；
- `outbox` 里长期挂着 `pending` = 对端不可达或 token 不对，不要当成"消息丢了"；
- 桥 `state.json` 的 mtime 一直在动，且 `errors: 0`；
- `audit.jsonl` 定期看一眼有没有不该出现的访问。

## 5. 令牌与凭据

两套凭证，作用域不同：

| 凭证 | 存在哪 | 谁能用 |
|---|---|---|
| dsh-link 入站 token | 本机 `auth.tokens`（只存 sha256）；对端 `peers[].token`（明文） | 决定谁能调你的 API、读写你的共享目录 |
| frp token | `tunnel.token`（明文） | 只用于接入 frps |
| STCP secretKey | `stcp.secretKey` / `peers[].stcp.secretKey` | 决定谁能开 visitor 连到你 |

轮换注意：

1. **两端同时轮换**：`peers[].token` 是"对端签发给我的入站 token"，只改一端会让跨机调用全部 401；
2. **带外交接**：新值用人工拷贝或 `invite` 配对码传递，别放进双方共享的根目录；
3. **先搬数据目录，再轮换**：如果 token 曾经落在共享根里，顺序是"把 `<dataDir>` 移出共享根 →
   轮换两端"——脚本内联 token 出现在对端可读的目录里就属于凭据外泄，不只是卫生问题；
4. 轮换窗口内暂停跨机操作（`send`/`pull`/`push`）。

> **已知边界：回环信任会让 token 免检。**
> `auth.trustLocalhost: true`（默认）+ 经 frp STCP 进来的请求，其来源地址恒为 `127.0.0.1`，
> `server.mjs` 的 `authorize()` 在 token 校验失败后会回落放行。也就是说，**在这种组合下
> 入站 token 从未被检查，真正边界是 STCP 的 `secretKey` 与 frps**。要让 token 成为边界，
> 两端都要切 `auth.trustLocalhost: false`，并给本机 MCP/脚本补 token。

## 6. 唤醒排障（bridge）

按顺序确认，每一步都有明确判据：

| 步骤 | 命令 / 文件 | 期望 |
|---|---|---|
| 1. 消息到了节点吗 | `dshlink inbox --unread --json` | 有未读、`source=push` 或落库时间正常 |
| 2. 桥在轮询吗 | `plugin-data/dsh-link-bridge/state.json` 的 mtime | 一直在动，`ticks` 递增，`errors: 0` |
| 3. 水位推进了吗 | 同文件的 `watermarkTs`/`watermarkId` | 等于/晚于最新未读消息（0.2.2+ 才有元组） |
| 4. 真的唤醒过吗 | 同文件的 `notified` | 增长（它是**累计消息条数**，不是唤醒次数） |
| 5. 会话在哪 | `pool`（0.3）或 `sessionId`（0.2.x） | 指向专用工作区里的会话，不是人工工作区 |
| 6. agent 读到了吗 | 会话转录 / `dshlink audit` | 出现 `link_read_message`/`link_reply` 调用 |

常见坑：

- **`markRead` 的语义**：`link_inbox` 只把**本次返回的消息集合**置读。想"全部置读"必须
  `unreadOnly: true, markRead: true`；用 `unreadOnly: false, limit: N` 可能漏标，也可能
  把刚到达的新消息一并置读，等于吞掉一次唤醒。核对"是否重复唤醒"只能用 `markRead: false` 的只读列表。
- **探针要在重启之后发**：DSH host 重启前发的消息，旧实例可能已经推进过水位，事后核对会得到假阴性。
- **自检要显式给 `--state-dir`**：`integrations/dsh-link-bridge/selfcheck.mjs` 不知道 `DSH_HOME`
  时会拼成 `~/.dsh/...` 的错路径。
- **模拟节点**：指向 `127.0.0.1:9` 之类的自检节点不在 `peers` 列表里，对它的回复恒为
  `pending / unknown recipient`，属预期，不是链路故障。
- **桥工作区必须是专用空目录**，并且连同节点数据目录一起写进 `dsh.excludeWorkspaces`：
  否则桥会话污染人工工作区，节点数据目录也会经虚拟根 `allws` 暴露给对端。

## 7. 隧道排障

```powershell
node bin\dshlink.mjs tunnel status      # 进程 / 配置 / visitor 端口
node bin\dshlink.mjs doctor --json      # tunnel:* 与 peer-route:* 两项
```

- frpc 日志要同时看到 `login to server success` 与 `start proxy success`（对端 visitor 是
  `start visitor success`）；只有前者 = 连上了但代理没起来。
- **`dshlink tunnel sync` 会覆盖 `<dataDir>/frp/frpc.toml`**：如果 frpc 是手写配置起的，
  两边会打架（peer 由外面某个 frpc 转发时，`doctor` 会给一条 `peer-route:<peer>` 提示）。
  要么全交给 dsh-link，要么保留手工 frpc 且不要再跑 `tunnel sync`，不要一半一半。
- 端口冲突：管理端口 7400 与 visitor 端口 19100+ 会被自动后移并回写 peer 配置。

## 8. 备份与回滚

要备份的最小集合：

```
<dataDir>/dshlink.config.json          # 身份与凭据（含明文 token，注意保管）
<dataDir>/inbox.jsonl, outbox.jsonl, state.json
<DSH_HOME>/profiles/<profile>/cordis.patch.yml
<DSH_HOME>/plugin-data/dsh-link-bridge/state.json
```

配置类改动（profile patch、`dshlink.config.json`）都是热重载的，回滚 = 用备份覆盖回去即可，
不需要重启；代码升级的回滚要先停进程再覆盖。

## 9. 一分钟体检

```powershell
node bin\dshlink.mjs doctor                        # 全绿/可解释的 warn
node bin\dshlink.mjs status --json | Select-String 'configReloads|peers'
node bin\dshlink.mjs peers ping                    # reachable + softwareVersion
node bin\dshlink.mjs inbox --unread --json         # 有没有到货没处理的
node bin\dshlink.mjs outbox list --json            # 有没有发不出去的
```

`plugin-data/dsh-link-bridge/state.json` 的 mtime 还在动、`errors: 0` —— 桥这条链路就算健康。
