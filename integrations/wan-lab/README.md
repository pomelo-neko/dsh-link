# wan-lab —— 两机跨公网实测脚手架

用于在两台机器（本机 Windows + WSL 发行版）之间复现 dsh-link 的公网穿透链路。

## 前置

- 一台公网 frps（地址/端口/frp token）。
- Windows 侧：`vendor/frp/windows-amd64/frpc.exe`（仓库已随附 frp v0.71.0）。
- WSL 侧：`vendor/frp/linux-amd64/frpc`（从 `~/frp_bundles` 或官方 tar 包复制，仓库不含 Linux 二进制）。

## 用法

1. 在工作区准备测试目录与 token 文件：
   ```powershell
   # test/.tmp/wan/frp-token.txt 里放 frps 的 auth.token（不要提交）
   ```
2. 起 Windows 侧节点 A：见 `docs/WAN-VERIFICATION.md` 的"复现步骤"。
   长驻进程请用计划任务：
   ```powershell
   Register-ScheduledTask -TaskName 'dshlink-wan-A' -Action (New-ScheduledTaskAction -Execute node -Argument '"D:\dsh-link\bin\dshlink.mjs" serve --data-dir "D:\dsh-link\test\.tmp\wan\A"') -Force
   Start-ScheduledTask -TaskName 'dshlink-wan-A'
   ```
3. 起 WSL 侧节点 B 并配对：
   ```bash
   bash wsl-setup.sh      # init + tunnel setup/sync + accept 邀请 + 起服务
   bash wsl-exchange.sh   # 读收件箱 + 推文件 + 回消息 + 反向 ping
   ```
4. 收尾：`Unregister-ScheduledTask dshlink-wan-A`、`pkill -f dshlink.mjs`（WSL）。

> 实测结果与踩坑记录见 `../../docs/WAN-VERIFICATION.md`。
