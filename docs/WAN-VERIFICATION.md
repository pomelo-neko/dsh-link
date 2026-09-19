# 跨公网实测记录（Round 2）

目标：证明 dsh-link 能让**两台机器**通过**公网服务器**互相通信、互相传文件，且双方都不需要开放入站端口。

## 拓扑

```
  Windows 节点 A (win-node)              WSL 节点 B (wsl-node)
  D:\dsh-link                            /mnt/d/dsh-link
  127.0.0.1:19301                        127.0.0.1:19302
        │  STCP provider                        │  STCP provider
        └───────► 公网 frps <frps-host>:7000 ◄────────┘
              （TLS 强制；仅 7000/tcp 放行；双方都是出站连接）
        ▲ visitor 127.0.0.1:19101                ▲ visitor 127.0.0.1:19100
        └────────────── A 通过它访问 B ───────────┘
```

- frps：一台有公网地址的机器（任意云主机或自有服务器），`bindPort=7000`、
  `transport.tls.force=true`、dashboard 只绑 `127.0.0.1`。具体配置见 [`FRP.md`](FRP.md)。
- 两个节点都用 `dshlink tunnel setup` 指向该 frps，再用 `dshlink invite` / `peers accept` 配对。
- 所有验证命令都只走 `127.0.0.1:<visitor 端口>`，这些端口只有在 frpc 成功经公网连上 frps 后才存在。

## 实测结果（全部通过）

| 步骤 | 命令 | 结果 |
|---|---|---|
| A 连接公网 frps | `tunnel sync` | frpc 日志 `login to server success` + `start proxy success` |
| B 连接公网 frps | `tunnel sync` | `login to server success` + `start visitor success` |
| 配对（新功能） | A `invite` → B `peers accept --reply` → A `peers accept` | A/B 互相登记，visitor 端口自动分配 |
| WAN 可达性 | `peers ping --name wsl-node` | `reachable: true`，延迟 **80 ms**（往返公网） |
| 消息 A→B | `send --to wsl-node ...` | `delivery.state=delivered`，B 收件箱 `via=push` |
| 文件 B→A（拉） | `pull --peer wsl-node --root ws --path hello-from-wsl.txt` | 16 B，sha256 `793be644…` **本端与远端一致**（`verified: true`） |
| 目录浏览 | `ls --peer wsl-node --root ws` | 列出远端条目 |
| 文件 A←B（推） | B `push --to win-node --root ws --path from-wsl.txt` | A 的 `D:\ws\drop\from-wsl.txt` 出现，内容一致 |
| 消息 B→A | B `send --to win-node ...` | A 收件箱收到 `re: wan test` |
| 反向可达 | B `peers ping --name win-node` | `reachable: true`，读出 A 的 roots |

## 复现步骤

1. **frps**（公网机器）：按 [`FRP.md`](FRP.md) §1 的模板起 frps，放行 7000/tcp，
   `auth.token` 用 `openssl rand -hex 32` 现场生成（不要复用任何示例值）。

2. **每台机器**：
   ```powershell
   node bin\dshlink.mjs init --name <机器名> --port 8787 --allow-upload --root ws=<共享目录>
   node bin\dshlink.mjs tunnel setup --server <frps> --port 7000 --token <frp token>
   node bin\dshlink.mjs tunnel sync
   ```

3. **配对**（A、B 各一次）：
   ```powershell
   # A
   node bin\dshlink.mjs invite            # 把整段 dshlink1:... 发给 B
   # B
   node bin\dshlink.mjs peers accept --invite "<code>" --reply   # 打印回执码给 A
   # A
   node bin\dshlink.mjs peers accept --invite "<reply>"
   ```

4. 验证：`peers ping` / `send` / `pull` / `push`，都可在任意一侧执行。

## 踩过的坑（已修进代码或写进文档）

1. **两个节点在同一台机器上会抢端口**（WSL2 镜像网络下 WSL 的监听会映射到 Windows 回环）：
   - frpc 管理端口 7400 与 visitor 端口 19100 都会冲突。
   - 现在 `TunnelManager.start()` 会**先探测端口**：管理端口被占用就往后找，visitor 端口被占用就改到下一个空闲端口并回写 peer 配置（`manager.dirty` → CLI 自动 `saveConfig`）。
2. **重启 frpc 时旧进程尚未释放管理端口** → 新进程启动即退出、隧道静默失效。
   现在 stop 会等端口释放，start 会在 600ms 后检查子进程存活，失败时把 frpc 日志尾部作为错误抛出。
3. **`start = ["dshlink"]` 是 frp 的"只启动这些代理"白名单**（不是标签），会让 provider/visitor 全部不启动。已从生成的配置里移除。
4. **通过 pwsh/工具调用起的后台进程会在调用结束时被回收**：长驻节点要用计划任务（`Register-ScheduledTask`）或 systemd；WSL 里用 `setsid nohup`。
5. **frpc 的 `allowUsers` 必须包含 visitor 的 `user`**：同一 frps 下所有节点用同一个 `user`（默认 `dsh-link`）。
