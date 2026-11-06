#!/usr/bin/env node
// dsh-link CLI — the same capabilities the MCP tools expose, for shells and scripts.
import process from 'node:process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { MessageStore } from '../src/store.mjs';
import { FileRoots } from '../src/fsroot.mjs';
import { createOps } from '../src/ops.mjs';
import { createLinkServer } from '../src/server.mjs';
import { GATEWAY_POLICY_SUMMARY, createGateway } from '../src/gateway.mjs';
import {
  createInboundToken, defaultDataDir, defaultNodeName, loadConfig, normalizeRoot, saveConfig, sealTokens, slugName
} from '../src/config.mjs';
import { DSHLINK_VERSION, LinkError, flagBool, flagList, flagString, formatBytes, parseArgs, randomToken, sha256Hex } from '../src/util.mjs';
import { TunnelManager, allocateVisitorPort, findFrpc, frpConfigToml, parseFrpcTomlSummary } from '../src/tunnel.mjs';
import { applyDshInstall, buildInvite, decodeInvite, defaultDshHome, peerEntryFromInvite, planDshInstall, upsertPeer } from '../src/pairing.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { createNodeWatcher } from '../src/reload.mjs';
import { createDshView } from '../src/dshview.mjs';
import { CAPABILITY_METHODS, createBridgePresence, createCommandQueue } from '../src/capabilities.mjs';
import {
  createHubToken, defaultHubConfig, defaultHubDataDir, hubConfigPathFor, loadHubConfig, saveHubConfig
} from '../src/hubconfig.mjs';
import { createHub } from '../src/hub.mjs';
import { HubStore } from '../src/hubstore.mjs';
import { HubTunnelManager } from '../src/hubfrp.mjs';
import { createHubLink } from '../src/hublink.mjs';
import { PHONE_TUNNEL_BIND_PORT, buildHubPhoneInvite } from '../src/phone.mjs';
import { openPhoneCA } from '../src/phoneca.mjs';
import { createPhoneGateway } from '../src/phonegateway.mjs';
import { PhoneTunnelManager } from '../src/phonefrp.mjs';
import { PHONE_BOOTSTRAP_DEFAULT_BIND_PORT, buildPhoneBootstrap } from '../src/phonebootstrap.mjs';

const HELP = `dsh-link ${DSHLINK_VERSION} — 让多台计算机上的 DeepSeek Harness 互相通信 / talk between DSH machines

用法 / usage: dshlink <command> [options]

  init        初始化本机节点（写配置 + 生成入站 token）     --name --port --bind --root --data-dir --force --allow-upload
  serve       启动本机节点 HTTP API + MCP 端点                --config --bind --port --auto-sync <秒> --no-reload
  status      查看本机节点、共享目录、peers                    --probe --json
  invite      生成配对码给对端（含 token / STCP 信息）       --url --ttl <分钟> --no-token --role --peer --json
  peers       管理对端: list | add | accept | rm | ping       accept --invite <码> [--reply] [--their-token T]
  doctor      本机自检：配置/目录/端口/MCP/对端/隧道            --json [--token T]
  harden      安全加固：关 trustLocalhost、铸 MCP/bridge 专用 token  [--write] [--json]
  token       管理入站 token: list | new --label --role --peer --ttl-days | rm --id
  send        给对端发消息（离线排队，之后 flush/sync）       --to --subject --body|--body-file --attach --thread
                                                              --target-session <对端会话> --origin-session <本机会话>
  bind        查看/登记 thread 与本机 DSH 会话的绑定            --thread T [--session S] [--peer P]
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
              dsh transcript <sessionId> [--peer P] [--limit N] [--tail] [--since-seq N]
              dsh capabilities [--peer P]    对端能力清单 + bridge 心跳
              dsh call <method> [--peer P] [--params '<json>'] [--wait N]
              dsh result <commandId>         补取异步命令结果
              dsh bridge                     本机 bridge 心跳与命令队列
              dsh enable [--actions m1,m2]   打开 DSH 视图（可选打开动作能力）
  hub         中心服务器（hub 拓扑）: init | serve | enroll | status | nodes | token | outbox | flush | reconnect | revoke
              hub init --name --bind --port [--frp-server H --frp-port P --frp-token T]
                       [--frp-cert F --frp-key F --frp-ca F --frpc-path P]
              hub serve                                     前台运行中心（Web 控制台在 <url>/ui）
              hub token new --role enroll --ttl-hours 2     一次性接入 token（默认 TTL 2h）
              hub enroll --url <hub> --token <t>            本机节点加入中心（之后 dshlink tunnel sync）
              hub status [--node]                           中心状态 / 本机节点链路状态
              hub reconnect                                 手动重连中心（本机节点）
              hub nodes | token list | outbox --pending | flush | revoke <node>
              hub invite --phone [--ttl-hours 2] [--label L] [--no-tunnel] [--url U] [--out F]
                                                      生成手机连接串（device token + 内嵌 STCP 隧道）
              hub phone setup [--phone-frp-server H --phone-frp-port P --phone-frp-token T]
                              [--phone-frp-cert F --phone-frp-key F --phone-frp-ca F --frpc-path P]
                                                      启用手机 mTLS 网关 + 独立 phone-frps 隧道（生成 CA/hub token/provider）
              hub phone bootstrap [--label L] [--ttl-hours 2] [--max-uses 1] [--no-tunnel] [--url U] [--out F]
                                                      生成一次性 dshlink2: 引导码（手机凭它换自己的证书）
              hub phone devices | status              列出手机设备 / 网关与隧道状态
              hub phone revoke <deviceId|fingerprint> 立即吊销一部手机
  install-dsh 把 MCP 配置和技能装进 DSH_HOME                   --profile web --url --write（默认只预览）
              token 认证: --token <admin token> [--bridge-token <bridge token>]
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

// One-shot CLI commands build a HubLink but never start it. Its constructor default is "disabled",
// which describes this CLI process, not the running node — without this, `dshlink status` while the
// node is online reports "disabled" and sends people chasing a phantom outage.
function markHubSnapshot(status) {
  if (!status || typeof status !== 'object') return status;
  if (status.enabled && !status.startedAt) {
    status.snapshot = true;
    status.state = 'unknown';
    status.note = 'CLI snapshot: this process did not start the hub uplink; the running node reports the live state via GET /api/v1/status';
  }
  return status;
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
  // A HubLink exists even when hub mode is off so that "dshlink hub enroll" can use it; it only
  // starts heartbeating when cmdServe calls start() and cfg.hub.enabled is true.
  const hubLogger = { info: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a), debug: () => {} };
  const hubLink = createHubLink({ cfg, logger: hubLogger, save: async (next) => { await saveConfig(next); } });
  const ops = createOps({ cfg, store, roots, dsh, commands, presence, hubLink });
  return { cfg, store, roots, ops, dsh, commands, presence, hubLink, sections: { dsh: dshSection, capabilities: capabilitySection } };
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
  // `commands` must be in scope for the reload callback below: without it a config change
  // updated cfg.dsh / cfg.capabilities but left the queue's startup allowlist in place.
  const { cfg, store, roots, ops, dsh, commands, hubLink, sections } = await loadCtx(args, {
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
  // The gateway is opt-in (config: "gateway": { "enabled": true }). It fronts the same node API on
  // a loopback token-checked port, so an frp/STCP-forwarded phone request cannot ride in on the
  // node's localhost trust. A configured gateway that cannot start is a hard error: silently
  // serving without the token check it was meant to add would be worse than not starting.
  let gateway = null;
  let gatewayInfo = null;
  if (cfg.gateway?.enabled === true) {
    gateway = createGateway({ cfg, getConfig: () => cfg, logger });
    try {
      gatewayInfo = await gateway.listen({ port: cfg.gateway.port, bind: cfg.gateway.bind });
    } catch (err) {
      await gateway.close();
      await link.close();
      throw new LinkError(2, 'gateway_listen_failed', `gateway could not listen on ${cfg.gateway.bind}:${cfg.gateway.port}: ${err?.message ?? String(err)}`);
    }
  }
  const autoSyncSec = Number(flagString(args['auto-sync']) ?? 0);
  console.log(`dsh-link node "${cfg.name}" listening on ${info.url}`);
  console.log(`  MCP endpoint : ${info.url}/mcp`);
  console.log(`  peers        : ${cfg.peers.length} configured`);
  console.log(`  roots        : ${roots.describe().map((r) => `${r.name}(${r.read ? 'r' : '-'}${r.write ? 'w' : '-'})`).join(', ') || '(none)'}`);
  if (persisted) console.log(`  sealed ${persisted} plaintext token(s) in the config file`);
  console.log(`  DSH view     : ${cfg.dsh.enabled ? `on (workspaces ${cfg.dsh.exposeWorkspaces ? 'yes' : 'no'}, transcripts ${cfg.dsh.exposeTranscripts ? 'yes' : 'no'}, home ${cfg.dsh.home || process.env.DSH_HOME || '(auto)'})` : 'off (set "dsh": { "enabled": true } or run: dshlink dsh enable)'}`);
  console.log(`  capabilities : ${cfg.capabilities.enabled ? `on (${cfg.capabilities.methods.length} method(s))` : 'off'}`);
  if (gatewayInfo) console.log(`  gateway      : ${gatewayInfo.url} -> ${gatewayInfo.upstream} (${GATEWAY_POLICY_SUMMARY})`);
  console.log(`  config       : ${cfg.configPath} (${watcher ? `hot-reload every ${watcher.intervalMs}ms` : 'reload disabled'})`);
  let tunnel = null;
  if (cfg.tunnel.enabled && cfg.tunnel.autoStart) {
    tunnel = new TunnelManager(cfg, { log: logger });
    const result = await tunnel.relaunch();
    console.log(`  tunnel       : ${result.running ? `frpc pid ${result.pid}` : `not running (${result.reason ?? 'unknown'})`}`);
  }
  if (hubLink.enabled) {
    hubLink.onOnline = async () => {
      try {
        const flushed = await ops.flush({});
        if (flushed.attempted) logger.info(`[hub] flushed ${flushed.attempted} queued message(s) after the link came up`);
      } catch (error) {
        logger.warn('[hub] flushing the outbox after reconnect failed: ' + (error?.message ?? error));
      }
    };
    hubLink.start();
    const hubState = hubLink.status();
    console.log(`  hub          : ${hubState.url} (${hubState.state})`);
  } else if (cfg.hub?.url) {
    console.log(`  hub          : ${cfg.hub.url} (not enrolled; run "dshlink hub enroll")`);
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
    if (hubLink.enabled) hubLink.stop();
    if (gateway) await gateway.close();
    await link.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ------------------------------------------------------------------ hub ---
// The hub is a separate process (dshlink hub serve) with its own config. Node-side commands
// (enroll/status --node/reconnect) reuse the normal node config through loadCtx.
function hubOptions(args) {
  return {
    configPath: flagString(args.config) ?? process.env.DSHLINK_HUB_CONFIG,
    dataDir: flagString(args['data-dir']) ?? process.env.DSHLINK_HUB_HOME
  };
}

async function loadHubCtx(args) {
  const opts = hubOptions(args);
  const cfg = await loadHubConfig(opts);
  cfg.configPath = hubConfigPathFor({ configPath: opts.configPath, dataDir: cfg.dataDir });
  const store = await new HubStore(cfg.dataDir).init();
  return { cfg, store };
}

function hubPhoneGatewayUrl(cfg) {
  return 'https://' + cfg.phoneGateway.bind + ':' + cfg.phoneGateway.port;
}

/** Build the phone-facing stack used by "hub serve": CA + mTLS gateway + phone-frps tunnel. */
async function createHubPhoneStack({ cfg, store, logger }) {
  const gatewayEnabled = cfg.phoneGateway?.enabled === true;
  const tunnelEnabled = cfg.phoneFrp?.enabled === true;
  if (!gatewayEnabled && !tunnelEnabled) return null;
  let ca = null;
  let gateway = null;
  if (gatewayEnabled) {
    if (!cfg.phoneGateway.hubToken) {
      throw new LinkError(2, 'phone_gateway_not_configured', 'phoneGateway.hubToken is missing; run: dshlink hub phone setup');
    }
    ca = await openPhoneCA({ dir: cfg.phoneGateway.caDir, opensslPath: cfg.phoneGateway.opensslPath ?? null, log: logger });
    gateway = createPhoneGateway({ cfg, ca, store, logger });
  }
  const tunnel = tunnelEnabled ? new PhoneTunnelManager(cfg, { log: logger }) : null;
  return { ca, gateway, tunnel };
}

function phoneDeviceRows(devices) {
  return devices.map((d) => ({
    id: d.id,
    label: d.label,
    device: d.deviceId ?? '',
    status: d.status ?? 'active',
    created: d.createdAt ?? '',
    seen: d.lastSeenAt ?? '',
    fingerprint: (d.fingerprint ?? '').slice(0, 23)
  }));
}

async function cmdHubPhone(args, { cfg, store, logger, asJson }) {
  const action = args._[1] ?? 'status';
  const phone = cfg.phoneGateway ?? {};
  const tunnelCfg = cfg.phoneFrp ?? {};

  if (action === 'setup') {
    phone.enabled = true;
    phone.bind = flagString(args.bind) ?? phone.bind ?? '127.0.0.1';
    phone.port = Number(flagString(args.port) ?? phone.port ?? 8791);
    const openssl = flagString(args.openssl) ?? phone.opensslPath;
    if (openssl) phone.opensslPath = path.resolve(openssl);
    phone.caDir = path.resolve(flagString(args['ca-dir']) ?? phone.caDir ?? path.join(cfg.dataDir, 'phone-ca'));

    // One long-lived device-role token for the gateway; the phone never sees it.
    let createdToken = null;
    if (flagBool(args['reset-hub-token']) && phone.hubToken) {
      const hash = sha256Hex(phone.hubToken);
      cfg.auth.tokens = (cfg.auth.tokens ?? []).filter((t) => t.hash !== hash && t.token !== phone.hubToken);
      phone.hubToken = null;
    }
    if (!phone.hubToken) {
      const token = createHubToken(cfg, 'phone-gateway', { role: 'device' });
      phone.hubToken = token.token;
      createdToken = token;
    }

    const frpServer = flagString(args['phone-frp-server']);
    if (frpServer) {
      tunnelCfg.enabled = true;
      tunnelCfg.serverAddr = frpServer;
      const frpPort = flagString(args['phone-frp-port']);
      if (frpPort) tunnelCfg.serverPort = Number(frpPort);
      const frpToken = flagString(args['phone-frp-token']);
      if (frpToken) tunnelCfg.token = frpToken;
      const frpUser = flagString(args['phone-frp-user']);
      if (frpUser) tunnelCfg.user = frpUser;
      const cert = flagString(args['phone-frp-cert']);
      if (cert) tunnelCfg.certFile = path.resolve(cert);
      const key = flagString(args['phone-frp-key']);
      if (key) tunnelCfg.keyFile = path.resolve(key);
      const caFile = flagString(args['phone-frp-ca']);
      if (caFile) tunnelCfg.trustedCaFile = path.resolve(caFile);
      const provider = flagString(args['phone-frp-provider']);
      if (provider) tunnelCfg.provider.name = provider;
      const bindPort = flagString(args['phone-frp-bind-port']);
      if (bindPort) tunnelCfg.bindPort = Number(bindPort);
    }
    if (flagBool(args['no-tunnel'])) tunnelCfg.enabled = false;
    const frpcPath = flagString(args['frpc-path']);
    if (frpcPath) {
      cfg.phoneFrp.frpcPath = path.resolve(frpcPath);
      if (!cfg.frp.frpcPath) cfg.frp.frpcPath = cfg.phoneFrp.frpcPath;
    }
    if (tunnelCfg.enabled && !tunnelCfg.serverAddr) {
      throw new LinkError(2, 'phone_frp_not_configured', 'phone-frps needs --phone-frp-server <host> (or keep the tunnel off with --no-tunnel)');
    }
    if (tunnelCfg.enabled && !tunnelCfg.provider.secretKey) tunnelCfg.provider.secretKey = randomToken(24);

    const ca = await openPhoneCA({ dir: phone.caDir, opensslPath: phone.opensslPath ?? null, log: logger });
    await saveHubConfig(cfg);
    const tunnel = new PhoneTunnelManager(cfg, { log: logger });
    const tunnelStatus = await tunnel.status();
    const lines = [
      'phone access configured for hub "' + cfg.name + '"',
      '  config       : ' + cfg.configPath,
      '  CA           : ' + phone.caDir,
      '  CA sha256    : ' + ca.caFingerprint(),
      '  gateway      : ' + hubPhoneGatewayUrl(cfg) + ' (HTTPS, mutual TLS)',
      '  device token : ' + (createdToken ? createdToken.token + '   (shown once; id ' + createdToken.id + ')' : '(already configured; use --reset-hub-token to rotate)'),
      '  phone-frps   : ' + (tunnelStatus.enabled
        ? tunnelStatus.serverAddr + ':' + tunnelStatus.serverPort + ' (provider ' + tunnelStatus.provider?.name + ', secretKey ' + (tunnelStatus.provider?.secretKeySet ? 'set' : 'missing') + ', visitor bind 127.0.0.1:' + tunnelStatus.bindPort + ')'
        : 'off (phones must reach the gateway over LAN/VPN)'),
      '',
      'next:',
      '  dshlink hub serve',
      '  dshlink hub phone bootstrap --label pixel-9 --ttl-hours 2 --out phone-code.txt',
      '  import that dshlink2: code in the Android app (0.6.0+)'
    ];
    out({
      gateway: { enabled: true, url: hubPhoneGatewayUrl(cfg), caDir: phone.caDir, caFingerprint: ca.caFingerprint() },
      hubToken: createdToken ? { id: createdToken.id, token: createdToken.token } : null,
      phoneFrp: tunnelStatus,
      config: cfg.configPath
    }, asJson, lines.join('\n'));
    return;
  }

  if (action === 'bootstrap') {
    if (!phone.enabled) throw new LinkError(2, 'phone_gateway_disabled', 'the phone gateway is off; run: dshlink hub phone setup');
    const ca = await openPhoneCA({ dir: phone.caDir, opensslPath: phone.opensslPath ?? null, log: logger });
    const created = await buildPhoneBootstrap(cfg, ca, store, {
      label: flagString(args.label) ?? 'phone',
      ttlHours: Number(flagString(args['ttl-hours']) ?? 2),
      maxUses: Number(flagString(args['max-uses']) ?? 1),
      bindPort: Number(flagString(args['bind-port']) ?? tunnelCfg.bindPort ?? PHONE_BOOTSTRAP_DEFAULT_BIND_PORT),
      tunnel: !flagBool(args['no-tunnel']),
      url: flagString(args.url) ?? null,
      note: flagString(args.note) ?? null
    });
    await saveHubConfig(cfg);
    const outFile = flagString(args.out);
    let saved = null;
    if (outFile) {
      saved = path.resolve(outFile);
      await fs.mkdir(path.dirname(saved), { recursive: true });
      await fs.writeFile(saved, created.code + '\n', 'utf8');
    }
    const summary = created.summary;
    const lines = [
      'one-time phone bootstrap code for hub "' + summary.entry.name + '"',
      '  label      : ' + summary.label,
      '  entry      : ' + summary.entry.url + ' (mTLS phone gateway)',
      '  tunnel     : ' + (created.tunnel ? 'embedded phone-frps STCP (visitor bind 127.0.0.1:' + summary.tunnelBindPort + ')' : 'none'),
      '  expires    : ' + summary.expiresAt,
      '  CA sha256  : ' + summary.caFingerprint,
      saved ? '  file       : ' + saved : null,
      '',
      'The phone generates its own key pair and exchanges this one-time code for a client certificate.',
      'The code does not contain the hub token, the CA private key, or any other phone certificate.',
      '',
      'code:',
      created.code
    ].filter((line) => line !== null).join('\n');
    out({ code: created.code, file: saved, summary, bootstrapId: created.bootstrapId, expiresAt: created.expiresAt, tunnel: created.tunnel }, asJson, lines);
    return;
  }

  if (action === 'devices') {
    const devices = await store.listPhones();
    const rows = phoneDeviceRows(devices);
    out({ count: devices.length, devices }, asJson, table(rows, [
      { header: 'ID', key: 'id' }, { header: 'LABEL', key: 'label' }, { header: 'DEVICE', key: 'device' },
      { header: 'STATUS', key: 'status' }, { header: 'CREATED', key: 'created' }, { header: 'LAST SEEN', key: 'seen' }, { header: 'FINGERPRINT', key: 'fingerprint' }
    ]));
    return;
  }

  if (action === 'revoke') {
    const target = args._[2] ?? flagString(args.device) ?? flagString(args.id);
    if (!target) throw new LinkError(2, 'missing_argument', 'hub phone revoke needs a device id or certificate fingerprint');
    const revoked = await store.revokePhone(target, flagString(args.reason) ?? 'revoked from CLI');
    if (!revoked) throw new LinkError(404, 'not_found', 'no such phone: ' + target);
    await store.audit({ event: 'hub_phone_revoked', deviceId: revoked.deviceId, fingerprint: revoked.fingerprint, source: 'cli' });
    out({ revoked: { id: revoked.id, deviceId: revoked.deviceId, fingerprint: revoked.fingerprint } }, asJson,
      'revoked phone ' + (revoked.deviceId ?? revoked.id) + ' (' + (revoked.fingerprint ?? '').slice(0, 23) + '); the next TLS handshake is refused');
    return;
  }

  if (action === 'status') {
    let caFingerprint = null;
    let caError = null;
    if (phone.enabled) {
      try {
        const ca = await openPhoneCA({ dir: phone.caDir, opensslPath: phone.opensslPath ?? null, log: logger });
        caFingerprint = ca.caFingerprint();
      } catch (err) {
        caError = err instanceof Error ? err.message : String(err);
      }
    }
    const devices = await store.listPhones();
    const bootstraps = await store.listPhoneBootstraps(20);
    const tunnelStatus = await new PhoneTunnelManager(cfg, { log: logger }).status();
    const value = {
      gateway: {
        enabled: phone.enabled === true,
        bind: phone.bind,
        port: phone.port,
        url: phone.enabled ? hubPhoneGatewayUrl(cfg) : null,
        caDir: phone.caDir,
        caFingerprint,
        caError,
        hubTokenSet: Boolean(phone.hubToken),
        allowNewDevices: phone.allowNewDevices !== false,
        maxDevices: phone.maxDevices,
        devices: { total: devices.length, active: devices.filter((d) => d.status === 'active').length },
        bootstraps: { total: bootstraps.length, active: bootstraps.filter((b) => b.status === 'active').length }
      },
      phoneFrp: tunnelStatus
    };
    out(value, asJson, [
      'phone gateway : ' + (value.gateway.enabled ? value.gateway.url + ' (mTLS, CA ' + (caFingerprint ?? 'unavailable: ' + caError) + ')' : 'off'),
      '  devices     : ' + value.gateway.devices.active + ' active / ' + value.gateway.devices.total + ' total (max ' + value.gateway.maxDevices + ')',
      '  bootstraps  : ' + value.gateway.bootstraps.active + ' active / ' + value.gateway.bootstraps.total + ' recent',
      '  hub token   : ' + (value.gateway.hubTokenSet ? 'set' : 'missing'),
      '  ca dir      : ' + (value.gateway.caDir ?? '-'),
      'phone-frps    : ' + (tunnelStatus.enabled ? (tunnelStatus.running ? 'running pid ' + tunnelStatus.pid : 'enabled, not running') + ' ' + (tunnelStatus.serverAddr ?? '') : 'off')
    ].join('\n'));
    return;
  }

  throw new LinkError(2, 'unknown_subcommand', 'unknown: hub phone ' + action + ' (try: setup | bootstrap | devices | revoke | status)');
}

async function cmdHub(args) {
  const sub = args._[0] ?? 'status';
  const asJson = flagBool(args.json);
  const logger = cliLogger(asJson);
  const opts = hubOptions(args);

  if (sub === 'init') {
    const dataDir = path.resolve(opts.dataDir ?? defaultHubDataDir());
    const cfg = defaultHubConfig({
      dataDir,
      name: flagString(args.name) ?? 'hub',
      bind: flagString(args.bind) ?? '127.0.0.1',
      port: Number(flagString(args.port) ?? 8790),
      publicUrl: flagString(args['public-url']) ?? null
    });
    const file = hubConfigPathFor({ configPath: opts.configPath, dataDir });
    cfg.configPath = file;
    if (!cfg.frp.provider.secretKey || flagBool(args['reset-provider'])) cfg.frp.provider.secretKey = randomToken(24);
    const frpServer = flagString(args['frp-server']);
    if (frpServer) {
      cfg.frp.enabled = true;
      cfg.frp.serverAddr = frpServer;
      const frpPort = flagString(args['frp-port']);
      if (frpPort) cfg.frp.serverPort = Number(frpPort);
      const frpToken = flagString(args['frp-token']);
      if (frpToken) cfg.frp.token = frpToken;
      const frpProvider = flagString(args['frp-provider']);
      if (frpProvider) cfg.frp.provider.name = frpProvider;
      const frpCert = flagString(args['frp-cert']);
      if (frpCert) cfg.frp.certFile = path.resolve(frpCert);
      const frpKey = flagString(args['frp-key']);
      if (frpKey) cfg.frp.keyFile = path.resolve(frpKey);
      const frpCa = flagString(args['frp-ca']);
      if (frpCa) cfg.frp.trustedCaFile = path.resolve(frpCa);
      const frpcPath = flagString(args['frpc-path']);
      if (frpcPath) cfg.frp.frpcPath = path.resolve(frpcPath);
    }
    const admin = createHubToken(cfg, 'admin', { role: 'admin' });
    await saveHubConfig(cfg);
    out({ config: file, dataDir: cfg.dataDir, url: 'http://' + cfg.bind + ':' + cfg.port, name: cfg.name, adminToken: admin.token, adminTokenId: admin.id, frp: cfg.frp }, asJson, [
      'dsh-link hub initialised: ' + cfg.name,
      '  config      ' + file,
      '  data dir    ' + cfg.dataDir,
      '  listen      http://' + cfg.bind + ':' + cfg.port,
      '  frp         ' + (cfg.frp.enabled ? cfg.frp.serverAddr + ' (provider ' + cfg.frp.provider.name + ', secretKey ' + cfg.frp.provider.secretKey + ')' : 'off (set --frp-server to publish through frps)'),
      '  admin token ' + admin.token + '   (id ' + admin.id + '; shown once)',
      '',
      'next:',
      '  dshlink hub serve',
      '  dshlink hub token new --role enroll --ttl-hours 2   # one-time token for a node',
      '  on each node: dshlink hub enroll --url <hub url> --token <enroll token>'
    ].join('\n'));
    return;
  }

  if (sub === 'invite') {
    if (!flagBool(args.phone)) {
      throw new LinkError(2, 'usage', 'hub invite currently supports --phone (a connect code for the Android control app)');
    }
    const { cfg } = await loadHubCtx(args);
    const maxUses = flagString(args['max-uses']) ? Number(flagString(args['max-uses'])) : null;
    const created = await buildHubPhoneInvite(cfg, {
      label: flagString(args.label) ?? 'phone',
      ttlHours: Number(flagString(args['ttl-hours']) ?? 2),
      maxUses,
      visitorPort: Number(flagString(args['visitor-port']) ?? PHONE_TUNNEL_BIND_PORT),
      tunnel: !flagBool(args['no-tunnel']),
      url: flagString(args.url) ?? null,
      note: flagString(args.note) ?? null
    });
    await saveHubConfig(cfg);
    const outFile = flagString(args.out);
    let saved = null;
    if (outFile) {
      saved = path.resolve(outFile);
      await fs.mkdir(path.dirname(saved), { recursive: true });
      await fs.writeFile(saved, created.code + '\n', 'utf8');
    }
    const summary = created.summary;
    const lines = [
      'mobile connect profile for hub "' + summary.entry.name + '"',
      '  label      ' + summary.label,
      '  entry      ' + summary.entry.url + ' (kind ' + summary.entry.kind + ')',
      '  tunnel     ' + (summary.hasTunnel
        ? 'embedded STCP (visitor bind 127.0.0.1:' + summary.tunnelBindPort + ')'
        : 'none - the phone must reach the entry URL directly'),
      '  token      ' + summary.tokenId + ' (device) expires ' + (summary.expiresAt ?? 'never'),
      saved ? '  file       ' + saved : null,
      '',
      'on the phone (dsh-link 控制端 0.5.0+): 导入连接串 → 粘贴下面的 code，或导入已保存的文件',
      summary.hasTunnel
        ? '  keep the STCP toggle checked; the app writes the embedded frpc config itself (the APK has no built-in secret)'
        : '  no STCP in this profile: connect the phone to ' + summary.entry.url + ' over LAN/VPN',
      '',
      'code:',
      created.code,
      '',
      'revoke: dshlink hub token rm --id ' + summary.tokenId
    ].filter((line) => line !== null).join('\n');
    out({ code: created.code, file: saved, summary, tokenId: created.tokenId, expiresAt: created.expiresAt, tunnel: created.tunnel }, asJson, lines);
    return;
  }

  if (sub === 'phone') {
    const { cfg, store } = await loadHubCtx(args);
    await cmdHubPhone(args, { cfg, store, logger, asJson });
    return;
  }

  if (sub === 'serve') {
    const { cfg, store } = await loadHubCtx(args);
    const phone = await createHubPhoneStack({ cfg, store, logger });
    const hub = createHub({ cfg, store, logger, phone, saveConfig: async (next) => { await saveHubConfig(next); } });
    const info = await hub.listen({ port: cfg.port, bind: cfg.bind });
    const nodes = await store.listNodes();
    console.log('dsh-link hub "' + cfg.name + '" listening on ' + info.url);
    console.log('  console      : ' + (cfg.publicUrl ?? info.url).replace(/\/+$/, '') + '/ui');
    console.log('  nodes        : ' + nodes.length + ' enrolled');
    console.log('  enrollment   : ' + (cfg.enrollment.enabled ? 'on (mode ' + cfg.enrollment.mode + ', autoApprove ' + cfg.enrollment.autoApprove + ', max ' + cfg.enrollment.maxNodes + ')' : 'off'));
    console.log('  files        : ' + (cfg.files.enabled ? 'on via hub proxy (max ' + formatBytes(cfg.files.maxBytes) + ')' : 'off'));
    console.log('  frp          : ' + (cfg.frp.enabled ? cfg.frp.serverAddr + ':' + (cfg.frp.serverPort ?? 7000) + ' (provider ' + cfg.frp.provider.name + ')' : 'off (static node URLs only)'));
    if (phone?.gateway) {
      const phoneStatus = await phone.gateway.status();
      console.log('  phone gateway: https://' + phoneStatus.bind + ':' + phoneStatus.port + ' (mTLS, CA ' + phoneStatus.caFingerprint + ', ' + phoneStatus.devices.active + ' active phone(s))');
    }
    if (phone?.tunnel) {
      const phoneTunnel = await phone.tunnel.status();
      console.log('  phone-frps   : ' + (phoneTunnel.enabled ? phoneTunnel.serverAddr + ':' + phoneTunnel.serverPort + ' (provider ' + phoneTunnel.provider?.name + ')' : 'off'));
    }
    console.log('  config       : ' + cfg.configPath);
    const shutdown = async (signal) => {
      console.log('\nreceived ' + signal + ', shutting down');
      await hub.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  if (sub === 'enroll') {
    const { cfg, hubLink } = await loadCtx(args);
    const url = flagString(args.url) ?? flagString(args._[1]);
    const token = flagString(args.token) ?? flagString(args['enroll-token']);
    if (!url) throw new LinkError(2, 'missing_argument', 'hub enroll needs --url <hub url>');
    if (!token) throw new LinkError(2, 'missing_argument', 'hub enroll needs --token <enrollment token>');
    const result = await hubLink.enroll({ url, token, downlinkUrl: flagString(args['downlink-url']) ?? null });
    const enrolled = cfg.hub.enrolled ?? null;
    const lines = [
      'enrolled with hub ' + (result.hub?.name ?? '?') + ' as ' + (enrolled?.nodeName ?? cfg.name),
      '  hub url     ' + cfg.hub.url,
      '  status      ' + (enrolled?.status ?? 'active'),
      '  visitor     ' + (enrolled?.visitorPort ?? '-')
    ];
    if (cfg.hub.frp?.serverName) lines.push('', 'next: dshlink tunnel sync   # publish the to-hub visitor (bind 127.0.0.1:' + (cfg.hub.visitorPort ?? 18790) + ')');
    lines.push('then restart the node: dshlink serve');
    out({ hub: result.hub, node: result.result?.node ?? null, enrolled, hubConfig: cfg.hub }, asJson, lines.join('\n'));
    return;
  }

  if (sub === 'status' && flagBool(args.node)) {
    const { ops } = await loadCtx(args);
    const status = markHubSnapshot(await ops.hubStatus());
    out(status, asJson, [
      'hub ' + (status.enabled ? (status.snapshot ? 'unknown (CLI snapshot; the live state is on the running node)' : status.state) : 'disabled') + (status.url ? ' ' + status.url : ''),
      '  last heartbeat ' + (status.lastHeartbeatAt ?? '-'),
      '  last error     ' + (status.lastError ?? '-'),
      '  queued         ' + (status.pendingOutbox ?? 0) + ' message(s)',
      '  enrolled as    ' + (status.enrolled?.hubName ?? '-') + ' / ' + (status.enrolled?.nodeName ?? '-')
    ].join('\n'));
    return;
  }

  if (sub === 'reconnect') {
    const { hubLink } = await loadCtx(args);
    const status = await hubLink.reconnect();
    out(status, asJson, 'hub reconnect: ' + status.state + (status.url ? ' ' + status.url : ''));
    return;
  }

  if (sub === 'flush') {
    const { cfg, store } = await loadHubCtx(args);
    const hub = createHub({ cfg, store, logger, saveConfig: async (next) => { await saveHubConfig(next); } });
    const result = await hub.flushPending({ force: true });
    out(result, asJson, 'flush attempted ' + result.attempted + ', delivered ' + result.delivered + ', failed ' + result.failed + ', pending ' + result.pending);
    return;
  }

  const { cfg, store } = await loadHubCtx(args);

  if (sub === 'status') {
    const hub = createHub({ cfg, store, logger, saveConfig: async (next) => { await saveHubConfig(next); } });
    const status = await hub.status();
    out(status, asJson, [
      'hub ' + status.hub.name + ' (' + status.hub.nodeId + ')',
      '  version    ' + status.hub.softwareVersion,
      '  nodes      ' + status.nodes.length + ' registered',
      '  outbox     ' + (status.counts?.outboxPending ?? 0) + ' pending',
      '  enrollment ' + (status.enrollment?.enabled ? 'on (autoApprove ' + status.enrollment.autoApprove + ')' : 'off'),
      '  frp        ' + (status.frp?.enabled ? (status.frp.running ? 'running pid ' + status.frp.pid : 'not running (' + (status.frp.reason ?? 'unknown') + ')') : 'off'),
      '  phone      ' + (status.phone?.gateway?.enabled
        ? 'gateway https://' + status.phone.gateway.bind + ':' + status.phone.gateway.port + ' (' + (status.phone.gateway.devices?.active ?? 0) + ' active phone(s)); phone-frps ' + (status.phone.tunnel?.enabled ? (status.phone.tunnel.running ? 'running' : 'stopped') : 'off')
        : 'off'),
      '  console    ' + (cfg.publicUrl ?? ('http://' + cfg.bind + ':' + cfg.port)).replace(/\/+$/, '') + '/ui',
      '  config     ' + cfg.configPath
    ].join('\n'));
    return;
  }

  if (sub === 'nodes') {
    const nodes = await store.listNodes();
    const rows = nodes.map((n) => ({
      name: n.name,
      status: n.status ?? 'active',
      url: n.url ?? '',
      visitor: n.visitorPort ?? '',
      heartbeat: n.lastHeartbeatAt ?? '',
      version: n.softwareVersion ?? ''
    }));
    out({ count: nodes.length, nodes }, asJson, table(rows, [
      { header: 'NAME', key: 'name' }, { header: 'STATUS', key: 'status' }, { header: 'URL', key: 'url' },
      { header: 'VISITOR', key: 'visitor' }, { header: 'LAST HEARTBEAT', key: 'heartbeat' }, { header: 'VERSION', key: 'version' }
    ]));
    return;
  }

  if (sub === 'token') {
    const action = args._[1] ?? 'list';
    if (action === 'new') {
      const role = flagString(args.role) ?? 'admin';
      const peer = flagString(args.peer) ?? undefined;
      const hours = Number(flagString(args['ttl-hours']) ?? (role === 'enroll' ? 2 : 0));
      const maxUses = flagString(args['max-uses']) ? Number(flagString(args['max-uses'])) : (role === 'enroll' ? 1 : undefined);
      const label = flagString(args.label) ?? role;
      const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : undefined;
      const token = createHubToken(cfg, label, { role, peer, expiresAt, maxUses });
      await saveHubConfig(cfg);
      out({ id: token.id, token: token.token, label: token.label, role: token.role, peer: token.peer, expiresAt: token.expiresAt, maxUses: token.maxUses }, asJson, [
        'hub token created',
        '  id       ' + token.id,
        '  role     ' + token.role + (token.peer ? ' peer=' + token.peer : ''),
        '  expires  ' + (token.expiresAt ?? 'never'),
        '  token    ' + token.token + '   (shown once)'
      ].join('\n'));
      return;
    }
    if (action === 'rm') {
      const id = flagString(args.id);
      const before = cfg.auth.tokens.length;
      cfg.auth.tokens = cfg.auth.tokens.filter((t) => t.id !== id);
      if (cfg.auth.tokens.length === before) throw new LinkError(404, 'not_found', 'no hub token ' + id);
      await saveHubConfig(cfg);
      out({ removed: id }, asJson, 'removed hub token ' + id);
      return;
    }
    const rows = cfg.auth.tokens.map((t) => ({ id: t.id, label: t.label, role: t.role, peer: t.peer ?? '', expiresAt: t.expiresAt ?? '' }));
    out({ count: rows.length, tokens: cfg.auth.tokens.map((t) => ({ id: t.id, label: t.label, role: t.role, peer: t.peer, expiresAt: t.expiresAt, maxUses: t.maxUses })) }, asJson, table(rows, [
      { header: 'ID', key: 'id' }, { header: 'LABEL', key: 'label' }, { header: 'ROLE', key: 'role' },
      { header: 'PEER', key: 'peer' }, { header: 'EXPIRES', key: 'expiresAt' }
    ]));
    return;
  }

  if (sub === 'outbox') {
    const pendingOnly = flagBool(args.pending);
    const limit = Math.min(500, Math.max(1, Number(flagString(args.limit) ?? 50) || 50));
    const result = await store.listOutbox({ limit, pendingOnly });
    const messages = result.messages ?? [];
    const rows = messages.map((r) => ({ ts: r.ts, id: r.id, to: r.to, thread: r.thread ?? '', state: r.delivery?.state ?? '' }));
    out({ count: messages.length, total: result.total ?? messages.length, pendingOnly, messages }, asJson, table(rows, [
      { header: 'TIME', key: 'ts' }, { header: 'ID', key: 'id' }, { header: 'TO', key: 'to' },
      { header: 'THREAD', key: 'thread' }, { header: 'STATE', key: 'state' }
    ]));
    return;
  }

  if (sub === 'revoke') {
    const name = args._[1] ?? flagString(args.name);
    if (!name) throw new LinkError(2, 'missing_argument', 'hub revoke needs the node name');
    const removed = await store.removeNode(name);
    if (!removed) throw new LinkError(404, 'not_found', 'no such node: ' + name);
    await store.audit({ event: 'hub_node_revoked', node: name });
    out({ removed: name }, asJson, 'revoked node ' + name + ' (its uplink token still exists: dshlink hub token rm --id <id>)');
    return;
  }

  throw new LinkError(2, 'unknown_subcommand', 'unknown: hub ' + sub + ' (try: init | serve | invite | enroll | status | reconnect | nodes | token | outbox | flush | revoke)');
}

async function cmdStatus(args) {
  const { cfg, ops } = await loadCtx(args);
  const status = await ops.status({ probe: flagBool(args.probe) });
  markHubSnapshot(status.hub);
  out(status, flagBool(args.json), [
    `node ${status.node.name} (${status.node.nodeId})`,
    `  url        ${status.node.url}`,
    `  data dir   ${status.node.dataDir}`,
    `  mailbox    inbox ${status.stats.inbox} (${status.stats.inboxUnread} unread) / outbox ${status.stats.outbox} (${status.stats.outboxPending} pending)`,
    `  roots      ${status.roots.map(rootLabel).join(', ') || '(none)'}`,
    `  upload     ${status.allowUpload ? 'allowed' : 'disabled'}`,
    `  hub        ${status.hub?.enabled ? `enrolled ${status.hub.enrolled?.hubName ?? '?'}${status.hub.snapshot ? ' (state unknown from this CLI snapshot; see the running node)' : ' · ' + status.hub.state}` : 'disabled'}`,
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
    const rows = cfg.auth.tokens.map((t) => ({
      id: t.id, label: t.label, role: t.role ?? 'admin', peer: t.peer ?? null, expiresAt: t.expiresAt ?? null, createdAt: t.createdAt
    }));
    return out(rows, asJson,
      table(rows, [{ key: 'id', header: 'ID' }, { key: 'label', header: 'LABEL' }, { key: 'role', header: 'ROLE' },
        { key: 'peer', header: 'PEER' }, { key: 'expiresAt', header: 'EXPIRES' }, { key: 'createdAt', header: 'CREATED' }]));
  }
  if (sub === 'new') {
    const role = flagString(args.role) ?? (flagString(args.peer) ? 'peer' : undefined);
    const peer = flagString(args.peer);
    const days = Number(flagString(args['ttl-days']) ?? 0);
    const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined;
    const label = flagString(args.label) ?? (role === 'peer' && peer ? `peer:${peer}` : `${role ?? 'admin'}:${cfg.name}`);
    const created = createInboundToken(cfg, label, { role, peer, expiresAt });
    await saveConfig(cfg);
    const scope = `role ${created.role ?? 'admin'}${created.peer ? `, peer ${created.peer}` : ''}${created.expiresAt ? `, expires ${created.expiresAt}` : ''}`;
    return out(created, asJson, `token ${created.id} created (label ${created.label}; ${scope}):\n${created.token}\nGive this to the peer; it is stored hashed and will not be shown again.`);
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
    targetSession: flagString(args['target-session']),
    originSession: flagString(args['origin-session']),
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

async function cmdBind(args) {
  const { ops } = await loadCtx(args);
  const asJson = flagBool(args.json);
  const thread = flagString(args.thread) ?? args._[0];
  if (!thread) throw new LinkError(2, 'usage', 'bind --thread <thread-id> [--session <session-id>] [--peer P]');
  const sessionId = flagString(args.session);
  if (!sessionId) {
    const result = await ops.binding({ thread });
    return out(result, asJson, result.binding
      ? `${result.binding.thread} -> ${result.binding.sessionId}${result.binding.peer ? ` (peer ${result.binding.peer})` : ''} updated ${result.binding.updatedAt}`
      : `no binding for ${thread}`);
  }
  const result = await ops.bindSession({ thread, sessionId, peer: flagString(args.peer) });
  return out(result, asJson, `${result.binding.thread} -> ${result.binding.sessionId} (bound)`);
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
    message.targetSession ? `target  ${message.targetSession}` : null,
    message.originSession ? `origin  ${message.originSession}` : null,
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
    note: flagString(args.note),
    role: flagString(args.role),
    peer: flagString(args.peer)
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
  const report = await runDoctor({ cfg, store, roots, ops, token: flagString(args.token) ?? process.env.DSHLINK_TOKEN });
  process.exitCode = report.ok ? 0 : 1;
  const human = [
    `dsh-link doctor — ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    table(report.checks, [
      { key: 'status', header: 'STATUS' }, { key: 'name', header: 'CHECK' }, { key: 'detail', header: 'DETAIL' }
    ])
  ].join('\n');
  return out(report, flagBool(args.json), human);
}

async function cmdHarden(args) {
  const asJson = flagBool(args.json);
  const write = flagBool(args.write);
  const { cfg } = await loadCtx(args);
  const actions = [];
  const warnings = [];
  if (cfg.auth.trustLocalhost) {
    actions.push({ action: 'trustLocalhost', from: true, to: false, why: 'loopback-forwarded tunnels (frp/STCP) can otherwise call the whole API without a token' });
    if (write) cfg.auth.trustLocalhost = false;
  }
  const hasRole = (role, peer = null) => (cfg.auth.tokens ?? []).some((t) => t.role === role && (peer === null || t.peer === peer));
  let adminToken = null;
  let bridgeToken = null;
  if (!hasRole('admin')) {
    actions.push({ action: 'mint-token', role: 'admin', label: 'mcp-admin', why: 'the local MCP client and CLI need a credential when trustLocalhost is off' });
    if (write) adminToken = createInboundToken(cfg, 'mcp-admin', { role: 'admin' }).token;
  }
  if (!hasRole('bridge')) {
    actions.push({ action: 'mint-token', role: 'bridge', label: 'bridge', why: 'the auto-wake bridge needs its own bridge token for the loopback control plane' });
    if (write) bridgeToken = createInboundToken(cfg, 'bridge', { role: 'bridge' }).token;
  }
  for (const peer of cfg.peers ?? []) {
    if (!hasRole('peer', peer.name)) warnings.push('peer ' + JSON.stringify(peer.name) + ' has no dedicated inbound peer token; mint one on THIS node and give it to that node: dshlink token new --role peer --peer ' + peer.name);
  }
  if ((cfg.auth.tokens ?? []).some((t) => !t.role)) warnings.push('some tokens predate roles (treated as admin); rotate them: dshlink token new --role admin, then dshlink token rm --id <old>');
  const applied = write && actions.length > 0;
  if (applied) await saveConfig(cfg);
  const installCmd = 'dshlink install-dsh --write --token ' + (adminToken ?? '<admin-token>') + (bridgeToken ? ' --bridge-token ' + bridgeToken : ' --bridge-token <bridge-token>');
  const human = [
    'dsh-link harden — ' + (write ? (applied ? 'applied' : 'nothing to change') : 'preview (add --write to apply)'),
    actions.length ? table(actions, [{ key: 'action', header: 'ACTION' }, { key: 'role', header: 'ROLE' }, { key: 'label', header: 'LABEL' }, { key: 'why', header: 'WHY' }]) : 'nothing to change',
    adminToken ? '\nadmin token (MCP/CLI, shown once): ' + adminToken : null,
    bridgeToken ? 'bridge token (auto-wake bridge, shown once): ' + bridgeToken : null,
    actions.length ? '\nnext: ' + installCmd : null,
    actions.length && !write ? 'then restart the node and the DSH host, and run: dshlink doctor --token <admin-token>' : null,
    warnings.length ? '\nwarnings:\n' + warnings.map((w) => '- ' + w).join('\n') : null
  ].filter((line) => line !== null).join('\n');
  return out({ trustedLocalhost: cfg.auth.trustLocalhost, actions, warnings, adminToken, bridgeToken, written: applied }, asJson, human);
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
    bridgeCooldownSeconds: Number(flagString(args['bridge-cooldown']) ?? 30),
    token: flagString(args.token) ?? '',
    bridgeToken: flagString(args['bridge-token']) ?? ''
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
    if (!sessionId) throw new LinkError(2, 'missing_argument', 'usage: dshlink dsh transcript <sessionId> [--peer P] [--limit N] [--tail] [--since-seq N]');
    const sinceFlag = flagString(args['since-seq']);
    const result = await ops.dshTranscript({
      peer,
      sessionId,
      limit: Number(flagString(args.limit) ?? 100),
      offset: Number(flagString(args.offset) ?? 0),
      tail: flagBool(args.tail),
      sinceSeq: sinceFlag === undefined ? undefined : Number(sinceFlag)
    });
    const lines = (result.messages ?? []).map((m) => `--- [${m.seq ?? '?'}] ${m.role ?? ''} ${m.kind ?? ''}\n${m.text ?? ''}`);
    const cursor = result.sinceSeq === null || result.sinceSeq === undefined ? '' : `, after seq ${result.sinceSeq}`;
    return out(result, asJson, `${result.session?.title ?? sessionId} — ${result.messages?.length ?? 0}/${result.total ?? '?'} message(s) on ${result.peer} (latest seq ${result.latestSeq ?? '?'}${cursor})\n${lines.join('\n')}`);
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
  send: cmdSend, bind: cmdBind, inbox: cmdInbox, show: cmdShow, sync: cmdSync, flush: cmdFlush, outbox: cmdOutbox,
  ls: cmdLs, pull: cmdPull, push: cmdPush, audit: cmdAudit, tunnel: cmdTunnel,
  invite: cmdInvite, doctor: cmdDoctor, harden: cmdHarden, 'install-dsh': cmdInstallDsh, dsh: cmdDsh, hub: cmdHub,
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
