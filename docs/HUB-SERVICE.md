# hub 常驻服务（Windows 自启动 + daemon 保活）

> 适用版本：0.11.2 及以后。Linux / macOS 的 hub 常驻仍按
> [DISTRIBUTION.md](DISTRIBUTION.md) §3.4 的 systemd 示例处理；本文只讲 Windows。

## 1. 为什么需要它

hub 过去是"手动在前台/后台跑"的：最常见的是在 DSH host 的会话里用
Start-Process node bin\dshlink.mjs hub serve 起一个后台任务。这样启动的 hub 是
**DSH host 进程树的子进程**，host 一重启（升级插件、清理进程、重启电脑）hub 就被一起回收，
手机上表现为"节点/中心服务器突然离线"，而 DSH 本身一切正常。

scripts\hub-service.ps1 把 hub 交给 **Windows 计划任务 + 独立 daemon**：

- 计划任务 dshlink-hub-autostart（登录触发，另有每 15 分钟兜底触发）启动
  hub-daemon.vbs（无窗口）→ hub-daemon.ps1；
- daemon 只做一件事：保证**有且只有一个** hub 进程在线。hub 退出、崩溃、或连续 3 次
  /healthz 失败时，daemon 清掉残留的 hub/frpc 进程并按退避间隔重启 hub；
- daemon 不是 DSH host 的子进程，所以**重启 DSH host 不影响 hub**；
- 停止用 hub-service.ps1 stop：它会**先禁用计划任务再杀进程**。如果只杀 daemon 而不禁用任务，
  15 分钟内的兜底触发会把 hub 又拉起来——这是 "临时停 hub" 场景最容易踩的坑。

所有脚本都是通用参数化的，**不含主机名、IP、用户路径或令牌**，随仓库一起分发；
机器相关的位置通过 -InstallDir / -DataDir 传入（也可以用 DSHLINK_HUB_HOME 环境变量）。

## 2. 文件与进程结构

| 文件 | 作用 |
|---|---|
| scripts\hub-service.ps1 | 唯一入口：install / status / start / stop / restart / enable / disable / uninstall / run-task |
| scripts\hub-service-lib.ps1 | 共用函数：路径解析、/healthz 探测、计划任务查询与启停、按数据目录识别 hub/frpc 进程、日志 |
| scripts\hub-daemon.ps1 | 保活循环（单实例、健康检查、残留清理、日志轮转、指数退避） |
| scripts\hub-daemon.vbs | 用 wscript 无窗口启动 daemon，供计划任务调用 |

进程关系：

    dshlink-hub-autostart (计划任务)
      └─ wscript.exe hub-daemon.vbs
           └─ powershell.exe hub-daemon.ps1        ← daemon，pid 写入 hub-daemon.pid
                └─ node.exe bin\dshlink.mjs hub serve --data-dir <dataDir>   ← hub，pid 写入 hub.pid
                     ├─ frpc.exe（hub 自己的 FRP provider）
                     └─ frpc.exe（phone-frps，可选）

计划任务用**当前用户**（Interactive，非 SYSTEM）运行，因为 hub 的配置、证书和 frp 凭据都在
数据目录里，SYSTEM 账户读不到当前用户的 %USERPROFILE%。

## 3. 安装与日常操作

在仓库根目录（或部署副本的根目录）执行：

    # 安装：注册计划任务、启动 daemon、等 hub /healthz 通过
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 install -InstallDir "D:\dsh-link"

    # 之后日常都用同一个短命令
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 status
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 stop
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 start
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-service.ps1 restart

-InstallDir 指向**包含 bin\dshlink.mjs 的那棵树**；-DataDir 默认按
$env:DSHLINK_HUB_HOME → %USERPROFILE%\.dshlink-hub 的顺序解析，所以大多数机器可以省略。
-TaskName 默认 dshlink-hub-autostart；-Json 让 status 输出机器可读对象；
-WaitSeconds 控制 install/start 等健康检查的超时（默认 30 秒）。

| 动作 | 含义 |
|---|---|
| install | 注册（或替换）计划任务并启动；hub 配置不存在时只告警，不创建配置 |
| status | 任务 / daemon / hub 健康 / 端口 / 日志位置；-Json 给脚本用 |
| start | 启用计划任务（若被禁用）并启动 daemon，等 hub 健康 |
| stop | **禁用**计划任务 → 杀 daemon 进程树 → 清理残留 hub/frpc → 等端口释放 |
| restart | stop + start |
| enable / disable | 只改计划的自动启动状态，不动正在跑的 daemon（disable 后下次登录不再自启） |
| uninstall | stop + 删除计划任务（数据和日志保留） |
| run-task | 通过计划任务再触发一次（排障用，等价于手动点"运行"） |

**临时停用**（网络不稳、要切到另一台阿里云服务器、升级 frps 等）：

    powershell -File scripts\hub-service.ps1 stop      # 停止并禁止自启
    # ……做迁移/维护……
    powershell -File scripts\hub-service.ps1 start     # 重新启用并启动

只停进程、仍允许下次登录自启：stop 之后手动 enable（或维护期间直接 disable 而不 stop）。

## 4. 升级 hub 代码

daemon 每次拉起 hub 都执行 bin\dshlink.mjs hub serve，所以升级只需要：

1. 用 node scripts\deploy-sync.mjs --apply --write --target <部署树> 同步代码（或直接覆盖发行包）；
2. 重启服务让新代码生效：

       powershell -File scripts\hub-service.ps1 restart

计划任务里的路径是**安装时**的 -InstallDir；换目录后要重新 install。

## 5. 日志与状态文件

都在 hub 数据目录（默认 %USERPROFILE%\.dshlink-hub）：

| 路径 | 内容 |
|---|---|
| logs\hub-daemon.log | daemon 自己的时间线：启动/停止、每次拉起 hub 的 pid、健康检查失败、退避重启 |
| logs\hub-<时间戳>.out.log / .err.log | hub 进程自己的 stdout / stderr，每次重启新建一组，保留最近 20 组 |
| hub-daemon.pid / hub.pid | daemon / hub 的进程号（用于 status 与单实例判断） |

健康检查：status 会请求 http://127.0.0.1:<hub 配置 port>/healthz（默认 8790）；
带 token 的完整状态在 hub 控制台 /ui 或 GET /api/v1/hub/status。

## 6. 排障

| 症状 | 检查 |
|---|---|
| task not installed | 先 install；注册计划任务需要当前用户对任务计划程序有权限 |
| daemon not running 但任务已装 | 看 logs\hub-daemon.log；常见是 node 不在 PATH（计划任务不加载 shell 的 PATH） |
| hub 进程在但 /healthz 不回答 | 看 hub-*.err.log；端口被占、配置损坏、frpc 起不来都会这样，daemon 会在 3 次失败后重启它 |
| stop 后 hub 又起来 | 任务没被禁用：用 hub-service.ps1 stop（会禁用任务），不要只 taskkill |
| 端口被占 | Get-NetTCPConnection -State Listen -LocalPort 8790；daemon 会优先认领本数据目录的进程，不会杀别的 hub |
| 换用户/换机器后不自启 | 计划任务绑定的是安装时的用户；用新用户重新 install |

脚本按**数据目录**识别 hub 进程：只杀命令行里带同一个 --data-dir 的 node，以及命令行里带
同一数据目录或监听 hub 配置的 frpc admin 端口的 frpc。同机的其他 hub / 节点 frpc 不会被误杀。

## 7. 与节点自启动的关系

节点（scripts\start-dshlink.ps1）和 hub 是**两套独立的常驻**：

- 节点：计划任务 dshlink-node-autostart → start-dshlink.vbs → 节点 + 节点自己的外部 frpc；
- hub：本文的 dshlink-hub-autostart → hub-daemon.vbs → daemon + hub。

两者不互相启动，也不依赖 DSH host。注意 start-dshlink.ps1 修过一个坑：以前只要机器上
**任意** frpc.exe 在跑（比如 hub 的 frpc）就认为"节点 frpc 已在跑"而跳过；现在它只在
命令行包含**本节点配置路径**时才算已运行。

## 8. 安全与杀软

- 不写任何秘密到计划任务或脚本：token、证书、frp 凭据仍在 hub 配置/数据目录里，权限沿用原文件；
- 计划任务以当前用户运行，命令行为 wscript + 本地 ps1 路径；
- daemon 只监听/访问 127.0.0.1 上的 /healthz，不新增网络暴露面；
- 若机器上装了火绒等 HIPS，首次安装/登录时可能拦截 wscript.exe 启动 PowerShell、
  powershell.exe 读取脚本、以及 node.exe / frpc.exe 联网。把下列路径加入信任即可
  （按安装位置替换 <install>、<dataDir>）：
  - <install>\scripts\hub-service.ps1
  - <install>\scripts\hub-service-lib.ps1
  - <install>\scripts\hub-daemon.ps1
  - <install>\scripts\hub-daemon.vbs
  - <install>\bin\dshlink.mjs 与 <install>\src\（node 读取的 JS）
  - <install>\vendor\frp\windows-amd64\frpc.exe
  - <dataDir>\logs\（daemon 写日志）与 <dataDir>\ 下的配置/证书
  - %SystemRoot%\System32\wscript.exe、%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
  - node 可执行文件本身

## 9. 手动调试（一般不需要）

    # 前台跑 daemon，直接观察输出（Ctrl+C 停；正常停止请用 hub-service.ps1 stop）
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hub-daemon.ps1 -InstallDir "D:\dsh-link" -DataDir "C:\Users\<you>\.dshlink-hub"

daemon 是**单实例**的：检测到已有 daemon 在跑会记日志并以退出码 3 结束；不要在计划任务之外
长期跑第二个 daemon。
