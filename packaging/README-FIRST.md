# dsh-link 客户端包 --- 三步接入

把压缩包解压到任意一台机器，几分钟内就能和别的机器互相发消息、互拉文件。

> **本包只含客户端**：包内只有 FRP 客户端 `frpc`（Windows + Linux 各一个），**没有 `frps`**。
> 公网 frps 由服务器侧单独部署（例如 `<frps-host>:7000`，见 `docs/FRP.md`）。

## 一、解压

```powershell
# Windows
Expand-Archive .\dsh-link-<版本>-portable.zip -DestinationPath C:\tools
```

```bash
# Linux / WSL
tar -xzf dsh-link-<版本>-portable.tar.gz -C ~/
```

只需要 **Node.js ≥ 20**（`node --version`）；不需要 `npm install`（零运行时依赖）。

## 二、安装

```powershell
# Windows：共享当前目录（只读）+ 常驻计划任务
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Name my-pc -ShareWorkspace -Task

# 允许对端往这里传文件（目标可写根要先建好目录）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Name my-pc -ShareWorkspace -Root "drop=D:\dshlink-drop:rw" -AllowUpload -Task

# 顺带接入本机 DSH（写 MCP 条目 + 装技能）
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Name my-pc -ShareWorkspace -Task -InstallDsh -Profile web -DshHome D:\DSH
```

```bash
# Linux / WSL
./install.sh --name my-wsl --share-workspace --task
./install.sh --name my-wsl --root "drop=$HOME/dshlink-drop:rw" --allow-upload --task
./install.sh --name my-wsl --share-workspace --task --install-dsh --dsh-home /home/user/.dsh
```

脚本流程：检查 Node → `dshlink init`（生成身份、入站 token、STCP 密钥）→ 可选配置 frps →
可选注册常驻服务 → 可选写入 DSH 的 MCP 条目 → 打印**配对码**。

常用参数：

| 参数（Windows / Linux） | 作用 |
|---|---|
| `-Name` / `--name` | 节点名（对端看到的名字），默认 `<主机名>-win` / `<主机名>-wsl` |
| `-Port` / `--port` | 本机监听端口，默认 8787 |
| `-ShareWorkspace` / `--share-workspace` | 把当前目录作为只读共享根 |
| `-Root` / `--root` | 追加共享根：`name=路径[:rw]`（可重复） |
| `-AllowUpload` / `--allow-upload` | 允许对端往 `rw` 根里推文件 |
| `-Task` / `--task` | 注册常驻服务（计划任务 / systemd 用户服务） |
| `-InstallDsh` / `--install-dsh` | 写入 DSH profile 的 MCP 条目并安装技能 |
| `-FrpServer` / `--frp-server`（+`-FrpToken`） | 配置公网 frps 并启动 frpc |
| `-NoInvite` / `--no-invite` | 不打印配对码 |

## 三、和别的机器配对

把打印出来的 `dshlink1:...` 配对码发给对方（任意可信渠道，**它内含密钥**），对方执行：

```powershell
node bin\dshlink.mjs peers accept --invite "dshlink1:..." --reply
```

对方会回一段**回执码**，你这边用同样的命令收下，双向配对就完成了：

```powershell
node bin\dshlink.mjs peers ping --name <对端名>
node bin\dshlink.mjs send --to <对端名> --subject hi --body "hello"
node bin\dshlink.mjs pull --peer <对端名> --root ws --path some/file.txt
node bin\dshlink.mjs push --to <对端名> --root drop --path my.txt --file .\my.txt
```

细节见 `PAIRING.md`；完整文档在 `docs/`。

## 包里有什么

| 路径 | 说明 |
|---|---|
| `bin/dshlink.mjs` | CLI：init / serve / send / inbox / pull / push / tunnel / invite / doctor / install-dsh |
| `src/` | HTTP API、MCP 端点、消息存储、文件沙箱、FRP 隧道 |
| `vendor/frp/windows-amd64/frpc.exe` | FRP **客户端**（v0.71.0，Windows） |
| `vendor/frp/linux-amd64/frpc` | FRP **客户端**（v0.71.0，Linux x86_64） |
| `integrations/dsh-skill/` | 给 DSH agent 的技能（install-dsh 会装上） |
| `integrations/aliyun-mcp.mjs` | 可选：经 MCPHub 调阿里云 OpenAPI MCP |
| `docs/` | 设计、协议、DSH 接入、FRP 部署、跨公网实测记录 |
| `test/` | 116 项自测 + 真实进程冒烟：`node test/run.mjs` |
| `install.ps1` / `install.sh` | 本页的安装脚本 |
| `SHA256SUMS.txt` | 完整性校验（`sha256sum -c` / `Get-FileHash`） |

## 安全默认值

- 只监听 `127.0.0.1`；公网访问一律走 frps 的 STCP 私密通道，不开放任何入站端口。
- 共享根默认**只读**；要接受推送需显式 `--allow-upload` 且该根是 `rw`。
- 入站 token 只以 sha256 存储；`.env`、`*.key`、`.ssh` 等在拒绝清单里。
- 文件访问、消息投递、认证失败都写 `audit.jsonl`。
