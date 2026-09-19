---
name: dshlink
description: Talk to other DeepSeek Harness machines over dsh-link: send/read messages, list and pull/push files across computers, check peer reachability, and handle offline queues. Use when the user mentions another PC, a remote DSH, peer messages, or fetching a file from another machine.
---

# dsh-link (机器间通信)

`dshlink` 让本机 DSH 与其它机器上的 DSH 交换消息与文件。所有命令都在项目目录
`<仓库根目录>` 下用 `node bin\dshlink.mjs <命令>` 调用，**优先加 `--json`**
便于解析；人类可读输出不带 `--json`。

## 先看状态

```powershell
node bin\dshlink.mjs status --probe --json      # 本机名/URL/共享根/对端可达性
```

- `node.name` 是本机在对端眼里的名字；`peers[]` 列出可通信的机器与其 `reachable`。
- `roots[]` 是本机共享出去的目录（`write: true` 才允许对端推送）。

## 消息：当成异步邮件用

```powershell
node bin\dshlink.mjs inbox --unread --json                 # 读未读（--mark-read 可顺手标记）
node bin\dshlink.mjs show --id msg_xxx --json              # 读全文（含附件元数据）
node bin\dshlink.mjs send --to <peer> --subject s --body "..." --json
node bin\dshlink.mjs send --to <peer> --body "..." --thread <threadId> --reply-to <msgId> --json
node bin\dshlink.mjs sync --from <peer> --json             # 拉对方为我排队投递的消息
node bin\dshlink.mjs flush --json                          # 重试我这边待发的消息
```

`send` 的退出码：0 = 已投递；**3 = 仍在队列（对端离线）**；这不是失败，别重复发同一条。

## 文件：先看再拉

```powershell
node bin\dshlink.mjs ls   --peer <peer> --root <root> --path <dir> --json
node bin\dshlink.mjs pull --peer <peer> --root <root> --path <file> [--out <本地路径>] --json
node bin\dshlink.mjs push --to <peer> --root <root> --path <目标路径> --file <本地文件> --json
```

- 拉取默认落到 `<data-dir>\inbox\<文件名>`，返回里的 `path` 是真实落盘位置，`verified` 表示 sha256 校验。
- 只能访问对端**共享根之内**的文件；`.env`、`*.key`、`.ssh` 等会被拒绝（报 `forbidden`）。
- 大文件用文件 API（`pull/push`），不要把大文件塞进消息附件（内联上限 512 KiB）。

## 与 MCP 工具的关系

如果 DSH 里已经有 `mcp__dshlink__link_*` 工具，优先用它们（更省 token、参数结构化）：
`link_status`、`link_inbox`、`link_send_message`、`link_pull_file` …
CLI 适合这些场景：MCP 未配置、需要在脚本/长流程里批处理、或要给人看的表格输出。

## 有新消息时谁叫醒我

dsh-link 只把消息放进收件箱，**不会唤醒对话**；本机若装了 `dsh-link-bridge` 插件，
它会在收到未读消息时自动创建/复用一个对话并把你叫起来（`workspacePath` 指定的工作区里）。
判断它是否在工作：`$DSH_HOME/plugin-data/dsh-link-bridge/state.json` 的 mtime 是否在更新，
其中 `watermark` 是已唤醒到哪条消息、`sessionId` 是正在用的对话。
如果没人叫你，而你又怀疑有消息，主动查一次：`node bin\dshlink.mjs inbox --unread --json`。

## 注意

- 对端名来自 `peers list`；用 `self` 表示本机。
- 对端不可达先 `peers ping`；FRP 隧道可用 `tunnel status` 查看。
- 不要伪造 `--token`/`--url` 去连陌生地址；新增对端应让用户确认。
