#!/usr/bin/env node
// dsh-link CLI — the same capabilities the MCP tools expose, for shells and scripts.
import process from 'node:process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MessageStore } from '../src/store.mjs';
import { FileRoots } from '../src/fsroot.mjs';
import { createOps } from '../src/ops.mjs';
import { createLinkServer } from '../src/server.mjs';
import {
  createInboundToken, defaultDataDir, defaultNodeName, loadConfig, normalizeRoot, saveConfig, sealTokens, slugName
} from '../src/config.mjs';
import { DSHLINK_VERSION, LinkError, flagBool, flagList, flagString, formatBytes, parseArgs, randomToken } from '../src/util.mjs';
import { TunnelManager, allocateVisitorPort, findFrpc, frpConfigToml, parseFrpcTomlSummary } from '../src/tunnel.mjs';
import { applyDshInstall, buildInvite, decodeInvite, defaultDshHome, peerEntryFromInvite, planDshInstall, upsertPeer } from '../src/pairing.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { createNodeWatcher } from '../src/reload.mjs';
import { createDshView } from '../src/dshview.mjs';
import { CAPABILITY_METHODS, createBridgePresence, createCommandQueue } from '../src/capabilities.mjs';

const HELP = `dsh-link ${DSHLINK_VERSION} — 让多台计算机上的 DeepSeek Harness 互相通信 / talk between DSH machines

用法 / usage: dshlink <command> [options]

  init        初始化本机节点（写配置 + 生成入站 token）     --name --port --bind --root --data-dir --force --allow-upload
  serve       启动本机节点 HTTP API + MCP 端点                --config --bind --port --auto-sync <秒> --no-reload
  status      查看本机节点、共享目录、peers                    --probe --json
  invite      生成配对码给对端（含 token / STCP 信息）       --url --ttl <分钟> --no-token --json
  peers       管理对端: list | add | accept | rm | ping       accept --invite <码> [--reply] [--their-token T]
  doctor      本机自检：配置/目录/端口/MCP/对端/隧道            --json
  token       管理入站 token: list | new | rm                 list|new --label|rm --id
  send        给对端发消息（离线排队，之后 flush/sync）       --to --subject --body|--body-file --attach --thread
  inbox       读取收到的消息                                 --unread --limit --thread --peer --mark-read --json
  show        查看单条消息                                    --id --box inbox|outbox
  sync        从对端拉取其为我们暂存的消息                     --from --limit
  flush       重试发送队列                                   --to
  outbox      查看/清理发送队列: outbox [list] | drop --id <msg> | drop --to <peer>
  ls          列出目录（本机或对端）                         --peer --root --path --json
  pull        从对端拉取文件                                 --peer --root --path --out --local-root
  push        推送文件到对端                                  --to --root --path --file --local-root --local-path
  audit       查看本机审计日志                                --limit
  tunnel      FRP 内网穿透: setup | enable | disable | sync | status | share | import | stop | config
  dsh         访问对方 DSH 的工作区 / 对话（需对端节点 ≥0.3.0）
              dsh workspaces [--peer P]      列出工作区
              dsh sessions [--peer P] [--workspace W] [--archived] [--query Q]
              dsh transcript <sessionId> [--peer P] [--limit N] [--tail]
              dsh capabilities [--peer P]    对端能力清单 + bridge 心跳
              dsh call <method> [--peer P] [--params '<json>'] [--wait N]
              dsh result <commandId>         补取异步命令结果
              dsh bridge                     本机 bridge 心跳与命令队列
              dsh enable [--actions m1,m2]   打开 DSH 视图（可选打开动作能力）
  install-dsh 把 MCP 配置和技能装进 DSH_HOME                   --profile web --url --write（默认只预览）
              自动唤醒桥（收到消息自动开对话）:              --bridge --bridge-workspace <目录> [--bridge-session <id>]
                                                            [--bridge-url http://127.0.0.1:8787] [--bridge-poll 15]
  peers-share 打印本机给别人用的 STCP 信息（proxyName + secretKey）
  help        显示帮助

通用选项 / global: --config <file> --data-dir <dir> --json

环境变量: DSHLINK_HOME（数据目录，默认 ~/.dshlink）、DSHLINK_CONFIG、DSHLINK_TOKEN
`;

function out(value, asJson, human) {
  if (asJson) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else process.stdout.write((human ?? JSON.stringify(value, null, 2)) + '\n');
}

function table(rows, columns) {
  if (!rows.length) return '(empty)';
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(columns.map((c) => c.header)), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(columns.map((c) => r[c.key] ?? '')))].join('\n');
}

/** Copy a reloaded config section onto the private object a component already holds. */
function syncSection(target, next) {
  if (!target || !next) return target;
  for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
  Object.assign(target, next);
  return target;
}

function sortedPeers(cfg) {
  return [...cfg.peers];
}

/** Console logger for the CLI: with --json, keep stdout machine-readable. */
function cliLogger(asJson) {
  const info = asJson ? (...args) => console.error(...args) : (...args) => console.log(...args);
  return { info, warn: (...args) => console.error(...args), error: (...args) => console.error(...args), debug: () => {} };
}

function rootLabel(root) {
  return `${root.name}=${root.path}${root.write ? ':rw' : root.read ? '' : ':none'}`;
}

async function loadCtx(args, { allowMissing = false, nodeOverrides = {} } = {}) {
  const configPath = flagString(args.config) ?? process.env.DSHLINK_CONFIG;
  const dataDir = flagString(args['data-dir']) ?? process.env.DSHLINK_HOME;
  const cfg = await loadConfig({ configPath, dataDir, overrides: { allowMissing, ...nodeOverrides } });
  const store = await new MessageStore(cfg.dataDir).init();
  // The DSH view and the command queue keep a reference to their own config section. A config
  // hot-reload replaces cfg.dsh / cfg.capabilities with fresh objects, so keep private copies and
  // refresh them in place (see syncSection) — otherwise a long-running node would gate on the new
  // settings while the components still read the old ones.
  const dshSection = { ...cfg.dsh };
  const capabilitySection = { ...cfg.capabilities };
  const commandsDir = path.join(cfg.dataDir, 'commands');
  const dsh = createDshView({ cfg: dshSection });
  const roots = new FileRoots({ ...cfg.files, maxListEntries: cfg.limits.maxListEntries }, { dshView: dsh });
  const commands = createCommandQueue({ dir: commandsDir, cfg: capabilitySection });
  const presence = createBridgePresence({ dir: commandsDir, cfg: capabilitySection });
  const ops = createOps({ cfg, store, roots, dsh, commands, presence });
  return { cfg, store, roots, ops, dsh, commands, presence, sections: { dsh: dshSection, capabilities: capabilitySection } };
}

async function cmdInit(args) {
  const asJson = flagBool(args.json);
  const dataDir = path.resolve(flagString(args['data-dir']) ?? process.env.DSHLINK_HOME ?? defaultDataDir());
  const configPath = flagString(args.config) ?? path.join(dataDir, 'dshlink.config.json');
  const force = flagBool(args.force);
  try {
    await fs.access(configPath);
    if (!force) throw new LinkError(2, 'exists', `config already exists: ${configPath} (use --force to overwrite)`);
  } catch (err) {
    if (err instanceof LinkError) throw err;
  }
  const name = slugName(flagString(args.name) ?? defaultNodeName());
  const rootSpecs = flagList(args.root);
  const cfg = await loadConfig({ configPath, overrides: { allowMissing: true, raw: {
    name,
    bind: flagString(args.bind) ?? '127.0.0.1',
    port: Number(flagString(args.port) ?? 8787),
    dataDir
  } } });
  cfg.name = name;
  cfg.dataDir = dataDir;
  cfg.configPath = configPath;
  cfg.files.roots = rootSpecs.length
    ? rootSpecs.map(normalizeRoot)
    : [{ name: 'ws', path: process.cwd(), read: true, write: false }];
  cfg.files.allowUpload = flagBool(args['allow-upload']);
  cfg.stcp.proxyName = `dshlink-${name}`;
  cfg.stcp.secretKey = randomToken(24);
  const token = createInboundToken(cfg, 'peer-default');
  await new MessageStore(dataDir).init();
  await saveConfig(cfg, configPath);
  const lines = [
    `dsh-link node initialised: ${name}`,
    `  config    ${configPath}`,
    `  data dir  ${dataDir}`,
    `  listen    http://${cfg.bind}:${cfg.port}`,
    `  roots     ${cfg.files.roots.map(rootLabel).join(', ')}`,
    `  token     ${token.token}   (id ${token.id}; shown once — give it to peers)`,
    `  STCP      proxyName=${cfg.stcp.proxyName} secretKey=${cfg.stcp.secretKey}`,
    '',
    'next:',
    `  dshlink serve`,
    `  dshlink peers add --name <peer> --url http://<host>:<port> --token <its token>`,
    `  dshlink tunnel setup --server <frps-host> --port 7000 --token <frp token>   # for NAT traversal through your frps`
  ];
  out({ config: configPath, name, dataDir, port: cfg.port, bind: cfg.bind, token: token.token, tokenId: token.id, stcp: cfg.stcp, roots: cfg.files.roots }, asJson, lines.join('\n'));
}

async function cmdServe(args) {
  const overridePort = flagString(args.port);
  const { cfg, store, roots, ops, dsh, sections } = await loadCtx(args, {
    nodeOverrides: { bind: flagString(args.bind), port: overridePort !== undefined ? Number(overridePort) : undefined }
  });
  const persisted = sealTokens(cfg);
  await saveConfig(cfg);
  const logger = { level: 'info', info: (...a) => console.log(...a), warn: (...a) => console.warn(...a), error: (...a) => console.error(...a), debug: () => {} };
  const startedAt = new Date().toISOString();
  const reloadSeconds = Number(flagString(args['reload-ms']) ?? 1000);
  const watcher = flagBool(args['no-reload'])
    ? null
    : createNodeWatcher({
      cfg,
      roots,
      dshView: dsh,
      intervalMs: Number.isFinite(reloadSeconds) ? reloadSeconds : 1000,
      onReload: ({ rootsRebuilt }) => {
        syncSection(sections.dsh, cfg.dsh);
        syncSection(sections.capabilities, cfg.capabilities);
        // The view and the queue normalize their config into private objects, so hand them the new
        // section explicitly — a changed dsh.home or capability list must not need a node restart.
        try { dsh.reconfigure?.(cfg.dsh); } catch (error) { console.warn('[reload] DSH view reconfigure failed: ' + (error?.message ?? error)); }
        try { commands.setConfig?.(cfg.capabilities); } catch (error) { console.warn('[reload] capability queue reconfigure failed: ' + (error?.message ?? error)); }
        console.log(`[reload] config file changed — reapplied${rootsRebuilt ? ' (shared folders rebuilt)' : ''}`);
      }
    });
  if (watcher) await watcher.prime();
  const link = createLinkServer({
    cfg,
    store,
    roots,
    ops,
    logger,
    refresh: watcher ? () => watcher.check() : undefined,
    runtime: watcher
      ? () => {
        const state = watcher.state();
        return {
          version: DSHLINK_VERSION, pid: process.pid, startedAt, configPath: cfg.configPath,
          configReloads: state.reloads, configLastReloadAt: state.lastReloadAt, configLastError: state.lastError
        };
      }
      : () => ({ version: DSHLINK_VERSION, pid: process.pid, startedAt, configPath: cfg.configPath, configReloads: null, configLastReloadAt: null, configLastError: null })
  });
  const info = await link.listen({ port: cfg.port, bind: cfg.bind });
  const autoSyncSec = Number(flagString(args['auto-sync']) ?? 0);
  console.log(`dsh-link node "${cfg.name}" listening on ${info.url}`);
  console.log(`  MCP endpoint : ${info.url}/mcp`);
  console.log(`  peers        : ${cfg.peers.length} configured`);
  console.log(`  roots        : ${roots.describe().map((r) => `${r.name}(${r.read ? 'r' : '-'}${r.write ? 'w' : '-'})`).join(', ') || '(none)'}`);
  if (persisted) console.log(`  sealed ${persisted} plaintext token(s) in the config file`);
  console.log(`  DSH view     : ${cfg.dsh.enabled ? `on (workspaces ${cfg.dsh.exposeWorkspaces ? 'yes' : 'no'}, transcripts ${cfg.dsh.exposeTranscripts ? 'yes' : 'no'}, home ${cfg.dsh.home || process.env.DSH_HOME || '(auto)'})` : 'off (set "dsh": { "enabled": true } or run: dshlink dsh enable)'}`);
  console.log(`  capabilities : ${cfg.capabilities.enabled ? `on (${cfg.capabilities.methods.length} method(s))` : 'off'}`);
  console.log(`  config       : ${cfg.configPath} (${watcher ? `hot-reload every ${watcher.intervalMs}ms` : 'reload disabled'})`);
  let tunnel = null;
  if (cfg.tunnel.enabled && cfg.tunnel.autoStart) {
    tunnel = new TunnelManager(cfg, { log: logger });
    const result = await tunnel.relaunch();
    console.log(`  tunnel       : ${result.running ? `frpc pid ${result.pid}` : `not running (${result.reason ?? 'unknown'})`}`);
  }
  let timer = null;
  if (autoSyncSec > 0) {
    const tick = async () => {
      try {
        const sync = await ops.sync({});
        const flush = await ops.flush({});
        if (sync.imported || flush.attempted) console.log(`[auto-sync] imported ${sync.imported}, flushed ${flush.attempted} (${flush.delivered} delivered)`);
      } catch (err) {
        console.warn('[auto-sync] failed:', err.message);
      }
    };
    timer = setInterval(tick, autoSyncSec * 1000);
    timer.unref?.();
    console.log(`  auto-sync    : every ${autoSyncSec}s`);
  }
  const shutdown = async (signal) => {
    console.log(`\nreceived ${signal}, shutting down`);
    if (timer) clearInterval(timer);
    await link.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function cmdStatus(args) {
  const { cfg, ops } = await loadCtx(args);
  const status = await ops.status({ probe: flagBool(args.probe) });
  out(status, flagBool(args.json), [
    `node ${status.node.name} (${status.node.nodeId})`,
    `  url        ${status.node.url}`,
    `  data dir   ${status.node.dataDir}`,
    `  mailbox    inbox ${status.stats.inbox} (${status.stats.inboxUnread} unread) / outbox ${status.stats.outbox} (${status.stats.outboxPending} pending)`,
    `  roots      ${status.roots.map(rootLabel).join(', ') || '(none)'}`,
    `  upload     ${status.allowUpload ? 'allowed' : 'disabled'}`,
    '',
    table(status.peers, [
      { key: 'name', header: 'PEER' },
      { key: 'url', header: 'URL' },
      { key: 'hasToken', header: 'TOKEN' },
      { key: 'reachable', header: 'REACHABLE' },
      { key: 'latencyMs', header: 'MS' },
      { key: 'error', header: 'ERROR' }
    ])
  ].join('\n'));
}

async function cmdPeers(args) {
  const sub = args._[0] ?? 'list';
  const { cfg, ops } = await loadCtx(args);
  const asJson = flagBool(args.json);
  if (sub === 'list') {
    return out(await ops.peers({ probe: flagBool(args.probe) }), asJson,
      table(sortedPeers(cfg), [
        { key: 'name', header: 'PEER' }, { key: 'url', header: 'URL' },
        { key: 'token', header: 'TOKEN' }, { key: 'note', header: 'NOTE' }
      ].map((c) => (c.key === 'token' ? { ...c, key: 'hasToken' } : c))));
  }
  if (sub === 'add') {
    const name = slugName(flagString(args.name) ?? '');
    if (!name) throw new LinkError(2, 'usage', 'peers add --name <peer> [--url http://host:port] [--token <token>] [--frp-server-name X --frp-secret Y --visitor-port N]');
    const stcpServerName = flagString(args['frp-server-name']);
    const stcpSecret = flagString(args['frp-secret']);
    let visitorPort = Number(flagString(args['visitor-port']) ?? 0);
    if (stcpServerName && !visitorPort) visitorPort = allocateVisitorPort(cfg);
    const url = flagString(args.url) ?? (visitorPort ? `http://127.0.0.1:${visitorPort}` : undefined);
    if (!url) throw new LinkError(2, 'usage', 'peers add needs --url, or --frp-server-name with --frp-secret');
    const existing = cfg.peers.findIndex((p) => p.name === name);
    const entry = {
      name,
      url: url.replace(/\/+$/, ''),
      token: flagString(args.token),
      autoSync: flagBool(args['auto-sync']),
      note: flagString(args.note),
      stcp: stcpServerName ? { serverName: stcpServerName, secretKey: stcpSecret ?? null, visitorPort } : null
    };
    if (existing >= 0) cfg.peers[existing] = entry; else cfg.peers.push(entry);
    await saveConfig(cfg);
    return out(entry, asJson, `peer ${existing >= 0 ? 'updated' : 'added'}: ${name} -> ${entry.url}${entry.stcp ? ` (stcp ${entry.stcp.serverName}, visitor port ${entry.stcp.visitorPort})` : ''}`);
  }
  if (sub === 'accept') {
    let code = flagString(args.invite) ?? args._[1];
    if (typeof code === 'string' && code.startsWith('@')) {
      code = (await fs.readFile(path.resolve(code.slice(1)), 'utf8')).trim();
    }
    const invite = decodeInvite(code);
    const result = peerEntryFromInvite(cfg, invite, {
      name: flagString(args.name),
      token: flagString(args['their-token']) ?? flagString(args.token),
      visitorPort: flagString(args['visitor-port']) ? Number(flagString(args['visitor-port'])) : undefined
    });
    const { action, peer } = upsertPeer(cfg, result.entry);
    let replyCode = null;
    if (flagBool(args.reply)) {
      replyCode = buildInvite(cfg, { withToken: true, label: `invite:${peer.name}` }).code;
    }
    await saveConfig(cfg);
    let tunnel = null;
    if (result.usedStcp && cfg.tunnel.enabled) {
      tunnel = await new TunnelManager(cfg, { log: cliLogger(flagBool(args.json)) }).relaunch();
    }
    const human = [
      `peer ${action}: ${peer.name} -> ${peer.url}${result.usedStcp ? ' (through the frps tunnel)' : ''}`,
      peer.token ? '  token        accepted from the invite' : '  token        MISSING — add it with: dshlink peers add --name ' + peer.name + ' --token <its token>',
      result.usedStcp ? `  visitor port ${peer.stcp.visitorPort} via ${peer.stcp.serverName}` : null,
      tunnel ? `  frpc         ${tunnel.running ? `running (pid ${tunnel.pid})` : `not running: ${tunnel.reason}`}` : null,
      ...result.warnings.map((w) => `  warning      ${w}`),
      replyCode ? '' : null,
      replyCode ? 'reply code for the other machine (give it back so it can reach you):' : null,
      replyCode,
      replyCode ? `  (or have it run: dshlink peers accept --invite <code>)` : null,
      '',
      `next: dshlink peers ping --name ${peer.name}`
    ].filter((line) => line !== null).join('\n');
    return out({ action, peer: { ...peer, token: peer.token ? '<hidden>' : undefined }, warnings: result.warnings, replyCode, tunnel }, asJson, human);
  }
  if (sub === 'rm' || sub === 'remove') {
    const name = slugName(flagString(args.name) ?? args._[1] ?? '');
    const before = cfg.peers.length;
    cfg.peers = cfg.peers.filter((p) => p.name !== name);
    await saveConfig(cfg);
    return out({ removed: before - cfg.peers.length }, asJson, `removed ${before - cfg.peers.length} peer(s)`);
  }
  if (sub === 'ping') {
    const result = await ops.peers({ probe: true });
    const filtered = flagString(args.name) ? result.peers.filter((p) => p.name === flagString(args.name)) : result.peers;
    const failed = filtered.filter((p) => p.reachable === false).length;
    process.exitCode = failed && filtered.length ? 1 : 0;
    return out({ peers: filtered }, asJson, table(filtered, [
      { key: 'name', header: 'PEER' }, { key: 'reachable', header: 'OK' },
      { key: 'latencyMs', header: 'MS' }, { key: 'remote', header: 'REMOTE' }, { key: 'error', header: 'ERROR' }
    ]));
  }
  throw new LinkError(2, 'usage', `unknown peers subcommand: ${sub}`);
}

async function cmdToken(args) {
  const sub = args._[0] ?? 'list';
  const { cfg } = await loadCtx(args);
  const asJson = flagBool(args.json);
  if (sub === 'list') {
    return out(cfg.auth.tokens.map((t) => ({ id: t.id, label: t.label, createdAt: t.createdAt })), asJson,
      table(cfg.auth.tokens, [{ key: 'id', header: 'ID' }, { key: 'label', header: 'LABEL' }, { key: 'createdAt', header: 'CREATED' }]));
  }
  if (sub === 'new') {
    const created = createInboundToken(cfg, flagString(args.label) ?? 'peer');
    await saveConfig(cfg);
    return out(created, asJson, `token ${created.id} created (label ${created.label}):\n${created.token}\nGive this to the peer; it is stored hashed and will not be shown again.`);
  }
  if (sub === 'rm') {
    const id = flagString(args.id) ?? args._[1];
    const before = cfg.auth.tokens.length;
    cfg.auth.tokens = cfg.auth.tokens.filter((t) => t.id !== id && t.label !== id);
    await saveConfig(cfg);
    return out({ removed: before - cfg.auth.tokens.length }, asJson, `removed ${before - cfg.auth.tokens.length} token(s)`);
  }
  throw new LinkError(2, 'usage', `unknown token subcommand: ${sub}`);
}

async function attachmentSpecs(args, roots) {
  const specs = [];
  for (const file of flagList(args.attach)) {
    if (file === true) continue;
    const abs = path.resolve(String(file));
    let found = null;
    for (const root of roots.roots) {
      const rel = path.relative(root.path, abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { found = { name: path.basename(abs), path: rel.replace(/\\/g, '/'), localRoot: root.name }; break; }
    }
    if (!found) throw new LinkError(2, 'usage', `--attach ${file} is outside every configured file root; add a root for it (dshlink init --root) or use push/pull for large files`);
    specs.push(found);
  }
  return specs;
}

async function cmdSend(args) {
  const { cfg, ops, roots } = await loadCtx(args);
  const asJson = flagBool(args.json);
  const to = flagString(args.to) ?? args._[0];
  if (!to) throw new LinkError(2, 'usage', 'send --to <peer> --body <text> [--subject s] [--attach file]');
  let body = flagString(args.body);
  if (body === undefined && flagString(args['body-file'])) body = await fs.readFile(path.resolve(flagString(args['body-file'])), 'utf8');
  if (body === undefined) { body = await readStdin(); }
  const result = await ops.sendMessage({
    to,
    subject: flagString(args.subject),
    body: body ?? '',
    thread: flagString(args.thread),
    replyTo: flagString(args['reply-to']),
    kind: flagString(args.kind) ?? 'message',
    attachments: await attachmentSpecs(args, roots)
  });
  process.exitCode = result.delivery.state === 'delivered' ? 0 : 3;
  return out(result, asJson, `${result.message.id} -> ${result.message.to}: ${result.delivery.state}${result.delivery.via ? ` via ${result.delivery.via}` : ''}${result.delivery.error ? ` (${result.delivery.error})` : ''}`);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdInbox(args) {
  const { ops } = await loadCtx(args);
  const result = await ops.inbox({
    unreadOnly: flagBool(args.unread),
    limit: Number(flagString(args.limit) ?? 20),
    since: flagString(args.since),
    thread: flagString(args.thread),
    peer: flagString(args.peer),
    markRead: flagBool(args['mark-read']),
    order: flagBool(args.asc) ? 'asc' : 'desc'
  });
  const human = [
    `${result.count}/${result.total} message(s), ${result.unread} unread`,
    table(result.messages.map((m) => ({
      id: m.id, from: m.from?.name ?? '?', state: m.read ? 'read' : 'unread',
      attachments: (m.attachments ?? []).length, subject: m.subject ?? '', ts: String(m.ts).slice(0, 19)
    })), [
      { key: 'ts', header: 'TIME' }, { key: 'id', header: 'ID' }, { key: 'from', header: 'FROM' },
      { key: 'state', header: 'STATE' }, { key: 'attachments', header: 'ATT' }, { key: 'subject', header: 'SUBJECT' }
    ])
  ].join('\n');
  return out(result, flagBool(args.json), human);
}

async function cmdShow(args) {
  const { ops } = await loadCtx(args);
  const message = await ops.readMessage({ id: flagString(args.id) ?? args._[0], box: flagString(args.box) ?? 'inbox' });
  return out(message, flagBool(args.json), [
    `id      ${message.id}`,
    `from    ${message.from?.name ?? '?'}  to ${message.to}`,
    `time    ${message.ts}`,
    message.subject ? `subject ${message.subject}` : null,
    message.thread ? `thread  ${message.thread}` : null,
    (message.attachments ?? []).length ? `attach  ${message.attachments.map((a) => `${a.name} (${formatBytes(a.size)})`).join(', ')}` : null,
    '',
    message.body
  ].filter((l) => l !== null).join('\n'));
}

async function cmdSync(args) {
  const { ops } = await loadCtx(args);
  const result = await ops.sync({ peer: flagString(args.from) ?? flagString(args.peer), limit: Number(flagString(args.limit) ?? 200) });
  return out(result, flagBool(args.json), result.peers.map((p) => `${p.peer}: ${p.error ? `error ${p.error}` : `fetched ${p.fetched}, imported ${p.imported}, skipped ${p.skipped}`}`).join('\n') || 'no peers to sync');
}

async function cmdOutbox(args) {
  const sub = args._[0] ?? 'list';
  const { store, ops } = await loadCtx(args);
  const asJson = flagBool(args.json);
  if (sub === 'drop') {
    const result = await ops.dropOutbox({ id: flagString(args.id) ?? args._[1], to: flagString(args.to) });
    return out(result, asJson, `dropped ${result.dropped} queued message(s)${result.ids.length ? `: ${result.ids.join(', ')}` : ''}; ${result.remaining} still queued`);
  }
  if (sub !== 'list') throw new LinkError(2, 'usage', 'outbox list | outbox drop --id <msg> | outbox drop --to <peer>');
  const pending = await store.pendingOutbox();
  const all = await store.list('outbox', { limit: Number(flagString(args.limit) ?? 50) });
  const rows = (asJson ? pending : all.messages).map((m) => ({
    id: m.id,
    to: m.to,
    ts: String(m.ts).slice(0, 19),
    state: m.delivery?.state ?? 'pending',
    attempts: m.delivery?.attempts ?? 0,
    error: m.delivery?.error ?? '',
    subject: String(m.subject ?? '').slice(0, 40)
  }));
  const result = { pending: pending.length, total: all.total, messages: rows };
  if (!rows.length) return out(result, asJson, 'outbox is empty — nothing waiting to be delivered');
  return out(result, asJson, [
    `${pending.length} of ${all.total} message(s) still queued (drop one with: dshlink outbox drop --id <msg>)`,
    table(rows, [
      { key: 'state', header: 'STATE' }, { key: 'to', header: 'TO' }, { key: 'attempts', header: 'TRIES' },
      { key: 'ts', header: 'TS' }, { key: 'id', header: 'ID' }, { key: 'error', header: 'ERROR' }, { key: 'subject', header: 'SUBJECT' }
    ])
  ].join('\n'));
}

async function cmdFlush(args) {
  const { ops } = await loadCtx(args);
  const result = await ops.flush({ to: flagString(args.to) });
  process.exitCode = result.pending ? 3 : 0;
  return out(result, flagBool(args.json), `attempted ${result.attempted}: delivered ${result.delivered}, still pending ${result.pending}`);
}

async function cmdLs(args) {
  const { ops } = await loadCtx(args);
  const result = await ops.listFiles({ peer: flagString(args.peer) ?? 'self', root: flagString(args.root), path: flagString(args.path) ?? '' });
  const human = [
    `${result.peer}:${result.root}:${result.path || ''} -?${result.count} entr(y|ies)${result.truncated ? ' (truncated)' : ''}`,
    table(result.entries.map((e) => ({ type: e.type, size: e.type === 'file' ? formatBytes(e.size) : '', mtime: String(e.mtime).slice(0, 19), path: e.path })), [
      { key: 'type', header: 'TYPE' }, { key: 'size', header: 'SIZE' }, { key: 'mtime', header: 'MTIME' }, { key: 'path', header: 'PATH' }
    ])
  ].join('\n');
  return out(result, flagBool(args.json), human);
}

async function cmdPull(args) {
  const { ops } = await loadCtx(args);
  const result = await ops.pullFile({
    peer: flagString(args.peer) ?? 'self',
    root: flagString(args.root),
    path: flagString(args.path) ?? args._[0],
    out: flagString(args.out),
    localRoot: flagString(args['local-root'])
  });
  process.exitCode = result.verified === false ? 4 : 0;
  return out(result, flagBool(args.json), `${result.path} (${formatBytes(result.size)})${result.verified === false ? ' — SHA-256 MISMATCH' : result.remoteSha256 ? ' — sha256 ok' : ''}`);
}

async function cmdPush(args) {
  const { ops } = await loadCtx(args);
  const localRoot = flagString(args['local-root']);
  const result = await ops.pushFile({
    peer: flagString(args.to) ?? flagString(args.peer),
    root: flagString(args.root),
    path: flagString(args.path),
    file: flagString(args.file) ?? (localRoot ? flagString(args['local-path']) : undefined),
    localRoot
  });
  return out(result, flagBool(args.json), `pushed ${formatBytes(result.size)} to ${result.peer}:${result.target.root}:${result.target.path} (sha256 ${result.sha256.slice(0, 12)}…`);
}

async function cmdAudit(args) {
  const { store } = await loadCtx(args);
  const entries = await store.recentAudit(Number(flagString(args.limit) ?? 30));
  return out({ entries }, flagBool(args.json), table(entries, [
    { key: 'ts', header: 'TIME' }, { key: 'event', header: 'EVENT' },
    { key: 'path', header: 'PATH' }, { key: 'size', header: 'SIZE' }, { key: 'ip', header: 'IP' }, { key: 'token', header: 'TOKEN' }
  ]));
}

async function cmdTunnel(args) {
  const sub = args._[0] ?? 'status';
  const { cfg } = await loadCtx(args);
  const asJson = flagBool(args.json);
  const manager = new TunnelManager(cfg, { log: cliLogger(flagBool(args.json)) });
  if (sub === 'setup') {
    const server = flagString(args.server);
    if (!server) throw new LinkError(2, 'usage', 'tunnel setup --server <frps host> [--port 7000] [--token <frp token>] [--frpc <path>] [--user team]');
    cfg.tunnel.serverAddr = server;
    cfg.tunnel.serverPort = Number(flagString(args.port) ?? cfg.tunnel.serverPort ?? 7000);
    if (flagString(args.token)) cfg.tunnel.token = flagString(args.token);
    if (flagString(args.user)) cfg.tunnel.user = flagString(args.user);
    if (flagString(args.frpc)) cfg.tunnel.frpcPath = path.resolve(flagString(args.frpc));
    if (flagString(args['visitor-port-base'])) cfg.tunnel.visitorPortBase = Number(flagString(args['visitor-port-base']));
    cfg.tunnel.enabled = true;
    if (!cfg.stcp.secretKey) cfg.stcp.secretKey = randomToken(24);
    await saveConfig(cfg);
    return out({ tunnel: cfg.tunnel, stcp: cfg.stcp }, asJson, [
      `tunnel configured against ${cfg.tunnel.serverAddr}:${cfg.tunnel.serverPort} (enabled)`,
      `  frpc       ${(await findFrpc(cfg)) ?? 'not found — pass --frpc <path to frpc(.exe)>'}`,
      `  STCP share proxyName=${cfg.stcp.proxyName}`,
      '',
      'next: dshlink tunnel sync   # write frpc.toml from config and (re)start frpc'
    ].join('\n'));
  }
  if (sub === 'enable' || sub === 'disable') {
    cfg.tunnel.enabled = sub === 'enable';
    await saveConfig(cfg);
    if (!cfg.tunnel.enabled) await manager.stop();
    return out({ enabled: cfg.tunnel.enabled }, asJson, `tunnel ${cfg.tunnel.enabled ? 'enabled' : 'disabled'}`);
  }
  if (sub === 'sync') {
    const result = await manager.relaunch({ force: true });
    if (manager.dirty) await saveConfig(cfg);
    process.exitCode = result.running ? 0 : 3;
    return out(result, asJson, result.running
      ? `frpc started (pid ${result.pid}), config ${result.configPath}\n${result.visitors.map((v) => `  ${v.peer} -> ${v.bindAddr}:${v.bindPort} (${v.serverName})`).join('\n')}`
      : `frpc not running: ${result.reason}`);
  }
  if (sub === 'status') {
    const status = await manager.status();
    return out(status, asJson, [
      `tunnel     ${cfg.tunnel.enabled ? 'enabled' : 'disabled'}`,
      `  server   ${cfg.tunnel.serverAddr ?? '(unset)'}:${cfg.tunnel.serverPort}`,
      `  frpc     ${status.frpcPath ?? '(not found)'}`,
      `  config   ${status.configPath}`,
      `  process  ${status.running ? `running pid ${status.pid}` : `stopped${status.reason ? ` (${status.reason})` : ''}`}`,
      `  visitors ${status.visitors.length ? status.visitors.map((v) => `${v.peer}->${v.visitorPort}`).join(', ') : '(none)'}`,
      status.logTail ? `  log      ${status.logTail.split('\n').slice(-3).join('\n           ')}` : null
    ].filter(Boolean).join('\n'));
  }
  if (sub === 'config') {
    const toml = frpConfigToml(cfg, { manager });
    return out({ toml }, asJson, toml);
  }
  if (sub === 'share') {
    const share = manager.share();
    return out(share, asJson, [
      'Give this to a peer so it can reach this node through frps:',
      `  dshlink peers add --name ${cfg.name} --frp-server-name ${share.proxyName} --frp-secret ${share.secretKey} --token ${'<this node token>'}`,
      '',
      `  proxyName ${share.proxyName}`,
      `  secretKey ${share.secretKey}`,
      `  frps      ${share.serverAddr ?? '(unset)'}:${share.serverPort}`
    ].join('\n'));
  }
  if (sub === 'import') {
    // Import a share string from a peer: dshlink tunnel import --peer bob --frp-server-name X --frp-secret Y --token Z
    const peer = slugName(flagString(args.peer) ?? '');
    const serverName = flagString(args['frp-server-name']);
    const secret = flagString(args['frp-secret']);
    if (!peer || !serverName || !secret) throw new LinkError(2, 'usage', 'tunnel import --peer <name> --frp-server-name <proxyName> --frp-secret <key> [--token <peer token>]');
    const visitorPort = Number(flagString(args['visitor-port']) ?? 0) || allocateVisitorPort(cfg);
    const entry = { name: peer, url: `http://127.0.0.1:${visitorPort}`, token: flagString(args.token), stcp: { serverName, secretKey: secret, visitorPort } };
    const index = cfg.peers.findIndex((p) => p.name === peer);
    if (index >= 0) cfg.peers[index] = entry; else cfg.peers.push(entry);
    await saveConfig(cfg);
    const result = await manager.relaunch({ force: true });
    return out({ peer: entry, tunnel: result }, asJson, `imported peer ${peer} via stcp ${serverName} on 127.0.0.1:${visitorPort}; frpc ${result.running ? 'running' : `not running (${result.reason})`}`);
  }
  if (sub === 'stop') {
    const result = await manager.stop();
    return out(result, asJson, result.stopped ? 'frpc stopped' : `nothing to stop (${result.reason ?? 'not running'})`);
  }
  if (sub === 'parse') {
    const toml = flagString(args.file) ? await fs.readFile(path.resolve(flagString(args.file)), 'utf8') : '';
    return out(parseFrpcTomlSummary(toml), asJson, JSON.stringify(parseFrpcTomlSummary(toml), null, 2));
  }
  throw new LinkError(2, 'usage', `unknown tunnel subcommand: ${sub}`);
}

async function cmdInvite(args) {
  const { cfg } = await loadCtx(args);
  const asJson = flagBool(args.json);
  const withToken = !flagBool(args['no-token']);
  const { code, invite } = buildInvite(cfg, {
    withToken,
    ttlMinutes: Number(flagString(args.ttl) ?? 0),
    url: flagString(args.url),
    label: flagString(args.label),
    note: flagString(args.note)
  });
  if (withToken) await saveConfig(cfg);
  const human = [
    `pairing code for "${cfg.name}" — send it over a trusted channel, it embeds a secret:`,
    '',
    code,
    '',
    'on the other machine:',
    '  node bin\\dshlink.mjs peers accept --invite <code> --reply',
    '',
    `urls      ${invite.urls.join(', ')}`,
    `stcp      ${invite.stcp ? `${invite.stcp.proxyName} @ ${invite.stcp.serverAddr}:${invite.stcp.serverPort}` : '(not configured)'}`,
    `token     ${withToken ? `embedded (id ${invite.tokenId}; revoke with: dshlink token rm --id ${invite.tokenId})` : 'not embedded'}`,
    `expires   ${invite.expiresAt ?? 'never'}`
  ].join('\n');
  return out({ code, invite }, asJson, human);
}

async function cmdDoctor(args) {
  const { cfg, store, roots, ops } = await loadCtx(args);
  const report = await runDoctor({ cfg, store, roots, ops });
  process.exitCode = report.ok ? 0 : 1;
  const human = [
    `dsh-link doctor — ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    table(report.checks, [
      { key: 'status', header: 'STATUS' }, { key: 'name', header: 'CHECK' }, { key: 'detail', header: 'DETAIL' }
    ])
  ].join('\n');
  return out(report, flagBool(args.json), human);
}

async function cmdInstallDsh(args) {
  const asJson = flagBool(args.json);
  const write = flagBool(args.write);
  const profile = flagString(args.profile) ?? 'web';
  const bridge = flagBool(args.bridge);
  const plan = await planDshInstall({
    dshHome: flagString(args['dsh-home']) ?? defaultDshHome(),
    profile,
    url: flagString(args.url) ?? 'http://127.0.0.1:8787/mcp',
    serverName: flagString(args['server-name']) ?? 'dshlink',
    includeSkill: !flagBool(args['no-skill']),
    bridge,
    bridgeWorkspace: flagString(args['bridge-workspace']),
    bridgeSessionId: flagString(args['bridge-session']) ?? '',
    bridgeNodeUrl: flagString(args['bridge-url']) ?? 'http://127.0.0.1:8787',
    bridgePollSeconds: Number(flagString(args['bridge-poll']) ?? 15),
    bridgeCooldownSeconds: Number(flagString(args['bridge-cooldown']) ?? 30)
  });
  const result = await applyDshInstall(plan, { dryRun: !write });
  const human = [
    `dsh home  ${plan.dshHome} (profile ${plan.profile})`,
    `patch     ${plan.patchPath}`,
    `          mode: ${plan.patchMode}${write ? '' : ' (dry run)'}`,
    `plugin    @deepseek-ai/dsh-mcp-client ${plan.pluginResolvable ? 'resolvable' : 'NOT resolvable from the profile — install it first (dsh plugin --profile ' + plan.profile + ' add @deepseek-ai/dsh-mcp-client)'}`,
    plan.bridge
      ? `bridge    dsh-link-bridge -> ${plan.bridge.mode}; workspace ${plan.bridge.workspacePath}; session ${plan.bridge.sessionId ?? 'auto'}`
      : 'bridge    not requested (add --bridge --bridge-workspace <dir> to wake a conversation automatically)',
    plan.bridge && plan.bridge.mode !== 'unchanged'
      ? `          note: a new plugin entry loads at boot — stop the running host and start it again (dsh ${plan.profile === 'web' ? 'web' : '--profile ' + plan.profile})`
      : null,
    `skill     ${plan.skill.dest} — ${plan.skill.action}`,
    '',
    plan.patchContent.trim(),
    '',
    write
      ? `applied${result.backupPath ? `; backup: ${result.backupPath}` : ''}${result.skillWritten ? '; skill installed' : ''}${result.validation ? `; yaml ${result.validation.validated ? 'validated' : 'not validated (' + result.validation.reason + ')'}` : ''}`
      : 'nothing written — re-run with --write to apply (a backup is made first)'
  ].filter((line) => line !== null).join('\n');
  return out(result, asJson, human);
}

/**
 * dsh: see and drive the DSH installation this node belongs to (and, with --peer, the one on
 * another machine). "workspaces|sessions|transcript" read the local disk view; "call|result"
 * go through the capability channel, which the DSH-side bridge plugin executes.
 */
async function cmdDsh(args) {
  const asJson = flagBool(args.json);
  const sub = String((args._ ?? [])[0] ?? 'help');
  const peer = flagString(args.peer);
  const { cfg, ops, commands, presence } = await loadCtx(args);

  if (sub === 'enable' || sub === 'disable') {
    const on = sub === 'enable';
    cfg.dsh.enabled = on;
    if (on) {
      cfg.dsh.exposeWorkspaces = flagString(args.workspaces) === '0' ? false : true;
      cfg.dsh.exposeTranscripts = flagString(args.transcripts) === '0' ? false : true;
      const home = flagString(args.home);
      if (home) cfg.dsh.home = path.resolve(home);
    }
    // Accept both --actions a,b,c and repeated --actions a --actions b.
    const actions = flagList(args.actions)
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean);
    if (actions.length) {
      const unknown = actions.filter((method) => !(method in CAPABILITY_METHODS));
      if (unknown.length) {
        throw new LinkError(2, 'unknown_method', `unknown capability method(s): ${unknown.join(', ')}`, { known: Object.keys(CAPABILITY_METHODS) });
      }
      cfg.capabilities.enabled = on;
      cfg.capabilities.methods = on
        ? [...new Set([...cfg.capabilities.methods, ...actions])]
        : cfg.capabilities.methods.filter((method) => !actions.includes(method));
    }
    if (!flagBool(args.write)) {
      return out({ dsh: cfg.dsh, capabilities: cfg.capabilities }, asJson, [
        'preview only — nothing written. add --write to apply:',
        `  dsh.enabled=${cfg.dsh.enabled} exposeWorkspaces=${cfg.dsh.exposeWorkspaces} exposeTranscripts=${cfg.dsh.exposeTranscripts}`,
        `  capabilities.enabled=${cfg.capabilities.enabled} methods=${cfg.capabilities.methods.join(',') || '(none)'}`
      ].join('\n'));
    }
    const file = await saveConfig(cfg);
    return out({ config: file, dsh: cfg.dsh, capabilities: cfg.capabilities }, asJson, [
      `${on ? 'enabled' : 'disabled'} the DSH view in ${file}`,
      `  workspaces  : ${cfg.dsh.exposeWorkspaces ? 'readable by peers' : 'hidden'}`,
      `  transcripts : ${cfg.dsh.exposeTranscripts ? 'readable by peers' : 'hidden'}`,
      `  capabilities: ${cfg.capabilities.enabled ? cfg.capabilities.methods.join(', ') : 'off'}`,
      '',
      'the running node picks this up on its next request (config hot-reload);',
      'restart it if it was started with --no-reload.'
    ].join('\n'));
  }

  if (sub === 'workspaces') {
    const result = await ops.dshWorkspaces({ peer });
    const lines = (result.workspaces ?? []).map((w) => `- ${w.id}  ${w.title ?? ''}  ${w.path ?? ''}  (${w.sessions ?? 0} session(s))`);
    return out(result, asJson, `${result.workspaces?.length ?? 0} workspace(s) on ${result.peer}\n${lines.join('\n')}`);
  }

  if (sub === 'sessions') {
    const result = await ops.dshSessions({
      peer,
      workspace: flagString(args.workspace),
      includeArchived: flagBool(args.archived) || flagBool(args['include-archived']),
      query: flagString(args.query),
      limit: Number(flagString(args.limit) ?? 100)
    });
    const lines = (result.sessions ?? []).map((s) => `- ${s.sessionId}  ${s.archived ? '[archived] ' : ''}${s.title ?? '(untitled)'}  ${s.updatedAt ?? ''}`);
    return out(result, asJson, `${result.sessions?.length ?? 0} session(s) on ${result.peer}\n${lines.join('\n')}`);
  }

  if (sub === 'transcript') {
    const sessionId = flagString(args.id) ?? (args._ ?? [])[1];
    if (!sessionId) throw new LinkError(2, 'missing_argument', 'usage: dshlink dsh transcript <sessionId> [--peer P] [--limit N] [--tail]');
    const result = await ops.dshTranscript({
      peer,
      sessionId,
      limit: Number(flagString(args.limit) ?? 100),
      offset: Number(flagString(args.offset) ?? 0),
      tail: flagBool(args.tail)
    });
    const lines = (result.messages ?? []).map((m) => `--- [${m.seq ?? '?'}] ${m.role ?? ''} ${m.kind ?? ''}\n${m.text ?? ''}`);
    return out(result, asJson, `${result.session?.title ?? sessionId} — ${result.messages?.length ?? 0}/${result.total ?? '?'} message(s) on ${result.peer}\n${lines.join('\n')}`);
  }

  if (sub === 'capabilities') {
    const result = await ops.dshCapabilities({ peer });
    const methods = (result.catalog ?? []).map((m) => `  ${result.methods?.includes(m.method) ? '[on] ' : '[off]'} ${m.method} (${m.kind})`);
    return out(result, asJson, [
      `${result.peer}: capability channel ${result.enabled ? 'enabled' : 'disabled'}`,
      ...methods,
      `  bridge: ${result.bridge ? `${result.bridge.version ?? '?'} at ${result.bridge.at ?? '?'}${result.bridge.stale ? ' (stale)' : ''}` : 'no heartbeat yet'}`
    ].join('\n'));
  }

  if (sub === 'call') {
    const method = flagString(args.method) ?? (args._ ?? [])[1];
    if (!method) throw new LinkError(2, 'missing_argument', 'usage: dshlink dsh call <method> [--peer P] [--params <json>] [--wait <seconds>]');
    let params = {};
    const rawParams = flagString(args.params);
    if (rawParams) {
      try { params = JSON.parse(rawParams); } catch { throw new LinkError(2, 'bad_params', '--params must be a JSON object'); }
    }
    const waitSeconds = flagString(args.wait) !== undefined ? Number(flagString(args.wait)) : undefined;
    const result = await ops.dshCall({ peer, method, params, waitSeconds });
    const lines = [`${method} -> ${result.status ?? 'unknown'}${result.pending ? ' (still queued; use: dshlink dsh result ' + result.commandId + ')' : ''}`];
    if (result.error) lines.push(`error: ${result.error.message ?? JSON.stringify(result.error)}`);
    if (result.result !== null && result.result !== undefined) lines.push(JSON.stringify(result.result, null, 2));
    return out(result, asJson, lines.join('\n'));
  }

  if (sub === 'result') {
    const id = flagString(args.id) ?? (args._ ?? [])[1];
    if (!id) throw new LinkError(2, 'missing_argument', 'usage: dshlink dsh result <commandId>');
    const result = await ops.dshCallResult({ peer, id });
    return out(result, asJson, `${result.method} -> ${result.status}\n${JSON.stringify(result.result ?? result.error, null, 2)}`);
  }

  if (sub === 'bridge') {
    const status = await ops.bridgeStatus();
    const info = status.bridge;
    return out(status, asJson, [
      `capability channel: ${status.enabled ? 'enabled' : 'disabled'}`,
      `bridge: ${info ? `${info.version ?? '?'} node=${info.node ?? '?'} sessions=${info.sessions ?? '?'} at ${info.at ?? '?'}${status.fresh ? '' : ' (STALE — is DSH running with the bridge plugin?)'}` : 'no heartbeat yet'}`,
      `queue: ${JSON.stringify(status.queue)}`
    ].join('\n'));
  }

  if (sub === 'commands') {
    const stats = commands ? await commands.stats() : null;
    return out({ stats }, asJson, JSON.stringify(stats, null, 2));
  }

  throw new LinkError(2, 'unknown_subcommand', `unknown: dsh ${sub} (try: workspaces | sessions | transcript | capabilities | call | result | bridge | enable)`);
}

const COMMANDS = {
  init: cmdInit, serve: cmdServe, status: cmdStatus, peers: cmdPeers, token: cmdToken,
  send: cmdSend, inbox: cmdInbox, show: cmdShow, sync: cmdSync, flush: cmdFlush, outbox: cmdOutbox,
  ls: cmdLs, pull: cmdPull, push: cmdPush, audit: cmdAudit, tunnel: cmdTunnel,
  invite: cmdInvite, doctor: cmdDoctor, 'install-dsh': cmdInstallDsh, dsh: cmdDsh,
  help: async (args) => { out({}, flagBool(args.json), HELP); }
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const args = parseArgs(argv.slice(1));
  if (args.version || command === '--version') { console.log(DSHLINK_VERSION); return; }
  if (args.help && command !== 'help') { console.log(HELP); return; }
  const handler = COMMANDS[command] ?? COMMANDS[command === 'peers-share' ? 'tunnel' : command];
  if (!handler) {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (command === 'peers-share') { args._ = ['share', ...(args._ ?? [])]; }
  await handler(args);
}

main().catch((err) => {
  const code = err instanceof LinkError ? err.code : 'error';
  const details = err instanceof LinkError && err.details ? `\n${JSON.stringify(err.details, null, 2)}` : '';
  process.stderr.write(`dshlink: [${code}] ${err.message}${details}\n`);
  process.exitCode = err instanceof LinkError && err.status >= 2 && err.status < 100 ? err.status : 1;
});
