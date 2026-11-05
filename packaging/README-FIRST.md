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

## 四、部署 hub（可选：多节点/手机协作）

点对点互连不需要 hub。当节点在 NAT 后面、或要让手机接入时，在**一台有公网 IP 的服务器**上跑 hub：

```powershell
# 服务器：装 Node 20+，解压本包，初始化（需要先有 frps 与证书，见 docs/FRP.md、docs/DISTRIBUTION.md）
node bin\dshlink.mjs hub init --name team-hub --port 8790 --frp-server <frps-host> --frp-port 16443 --frp-token <frps-token> --frp-cert C:\certs\client.crt --frp-key C:\certs\client.key --frp-ca C:\certs\ca.crt
node bin\dshlink.mjs hub serve
# Web 控制台：http://127.0.0.1:8790/ui （admin token 在 init 时只显示一次）
```

节点加入：

```powershell
node bin\dshlink.mjs tunnel setup --server <frps-host> --port 16443 --token <frps-token>
node bin\dshlink.mjs hub enroll --url http://<hub 地址>:8790 --token <enroll token>   # enroll token 在 hub 上签发
node bin\dshlink.mjs tunnel sync
node bin\dshlink.mjs hub status
```

完整步骤、拓扑与排错见 `docs/DISTRIBUTION.md`、`docs/HUB-TOPOLOGY-DESIGN.md`、`docs/HUB-CONSOLE.md`。

## 五、手机控制端（APK）

包内 `apk/` 里是 Android 控制端（0.5.0+，**不含任何密钥**）：

1. 把 APK 传到手机安装（允许安装未知来源应用）；
2. 在 hub 上生成连接串：`node bin\dshlink.mjs hub invite --phone --out phone.txt`
   （或 Web 控制台“手机接入”卡片）；
3. 手机 App → **导入连接串**（粘贴或选文件）→ 勾选 STCP 中转 → 连接；
4. 之后可以浏览工作区/会话、看实时消息、发送消息（steer/queue）。

连接串等同密码（内含 device token 与隧道凭据），请私下发送；每个手机一份，丢失后在 hub 上
`hub token rm --id <id>` 吊销。

## 包里有什么

| 路径 | 说明 |
|---|---|
| `bin/dshlink.mjs` | CLI：init / serve / send / inbox / pull / push / tunnel / invite / hub / doctor / install-dsh |
| `src/` | HTTP API、MCP 端点、消息存储、文件沙箱、FRP 隧道、hub（中心服务器） |
| `apk/` | Android 控制端 APK（0.5.0+，出厂不含密钥；连接串在手机上导入） |
| `vendor/frp/windows-amd64/frpc.exe` | FRP **客户端**（v0.71.0，Windows） |
| `vendor/frp/linux-amd64/frpc` | FRP **客户端**（v0.71.0，Linux x86_64） |
| `integrations/dsh-skill/` | 给 DSH agent 的技能（install-dsh 会装上） |
| `integrations/aliyun-mcp.mjs` | 可选：经 MCPHub 调阿里云 OpenAPI MCP |
| `docs/` | 设计、协议、DSH 接入、FRP 部署、hub 拓扑、分发部署、跨公网实测记录 |
| `examples/` | 节点 / hub / frps / DSH 配置样例（全部为占位值） |
| `test/` | 全量自测 + 真实进程冒烟：`node test/run.mjs` |
| `install.ps1` / `install.sh` | 本页的安装脚本 |
| `SHA256SUMS.txt` | 完整性校验（`sha256sum -c` / `Get-FileHash`） |

## 安全默认值

- 只监听 `127.0.0.1`；公网访问一律走 frps 的 STCP 私密通道，不开放任何入站端口。
- 共享根默认**只读**；要接受推送需显式 `--allow-upload` 且该根是 `rw`。
- 入站 token 只以 sha256 存储；`.env`、`*.key`、`.ssh` 等在拒绝清单里。
- 文件访问、消息投递、认证失败都写 `audit.jsonl`。
