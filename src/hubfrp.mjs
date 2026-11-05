// dsh-link hub (0.8): the hub's own frpc process.
//
// The hub publishes its HTTP port as one STCP provider and creates one STCP visitor per enrolled
// node. Nodes publish their own API port as a provider at enrollment time; the hub then reaches
// each node at 127.0.0.1:<visitorPort> without any inbound port on the node side.
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LinkError, randomToken } from './util.mjs';
import { findFrpc, parseFrpcTomlSummary } from './tunnel.mjs';

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

// frpc accepts both separators on Windows; forward slashes keep the generated TOML readable and
// avoid JSON/TOML double-escaping of backslashes.
function tomlPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function podName(node) {
  return `to-${String(node.name ?? '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 48)}`;
}

export function hubFrpConfigToml(cfg, nodes = []) {
  const f = cfg.frp ?? {};
  if (!f.serverAddr) throw new LinkError(3, 'frp_not_configured', 'hub frp.serverAddr is not set');
  const provider = f.provider ?? {};
  if (!provider.secretKey) throw new LinkError(3, 'frp_not_configured', 'hub frp.provider.secretKey is not set');
  const lines = [
    `serverAddr = ${tomlString(f.serverAddr)}`,
    `serverPort = ${Number(f.serverPort ?? 7000)}`,
    `user = ${tomlString(f.user ?? 'dsh-link')}`,
    'loginFailExit = false',
    '',
    `auth.token = ${tomlString(f.token ?? '')}`,
    // frps only accepts STCP work connections when the token is attached to the NewWorkConns
    // scope; without this the provider fails every visitor with "invalid NewWorkConn".
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    '',
    `transport.tls.enable = ${f.tls !== false}`,
    `transport.tls.disableCustomTLSFirstByte = false`,
    ...(f.certFile ? [`transport.tls.certFile = ${tomlString(tomlPath(f.certFile))}`] : []),
    ...(f.keyFile ? [`transport.tls.keyFile = ${tomlString(tomlPath(f.keyFile))}`] : []),
    ...(f.trustedCaFile ? [`transport.tls.trustedCaFile = ${tomlString(tomlPath(f.trustedCaFile))}`] : []),
    '',
    `webServer.addr = "127.0.0.1"`,
    `webServer.port = ${Number(f.adminPort ?? 7401)}`,
    '',
    '[[proxies]]',
    `name = ${tomlString(provider.name ?? 'dshlink-hub')}`,
    'type = "stcp"',
    `secretKey = ${tomlString(provider.secretKey)}`,
    'allowUsers = ["dsh-link"]',
    'localIP = "127.0.0.1"',
    `localPort = ${Number(cfg.port)}`,
    'transport.useEncryption = true',
    'transport.useCompression = false'
  ];
  for (const node of nodes) {
    if (!node.provider?.serverName || !node.provider?.secretKey || !node.visitorPort) continue;
    lines.push(
      '',
      '[[visitors]]',
      `name = ${tomlString(podName(node))}`,
      'type = "stcp"',
      `serverName = ${tomlString(node.provider.serverName)}`,
      `secretKey = ${tomlString(node.provider.secretKey)}`,
      'bindAddr = "127.0.0.1"',
      `bindPort = ${Number(node.visitorPort)}`,
      'transport.useEncryption = true',
      'transport.useCompression = false'
    );
  }
  return lines.join('\n') + '\n';
}

async function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

async function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export class HubTunnelManager {
  constructor(cfg, nodes = [], { log = console, spawnImpl = nodeSpawn } = {}) {
    this.cfg = cfg;
    this.nodes = nodes;
    this.log = log;
    this.spawn = spawnImpl;
    this.dir = cfg.frp?.logDir ?? path.join(cfg.dataDir, 'frp');
    this.configPath = cfg.frp?.configPath ?? path.join(this.dir, 'hub-frpc.toml');
    this.pidPath = path.join(this.dir, 'hub-frpc.pid');
    this.logPath = path.join(this.dir, 'hub-frpc.log');
  }

  _frpcCfg() {
    // findFrpc() reads cfg.tunnel.frpcPath; adapt the hub section to that shape.
    return { dataDir: this.cfg.dataDir, tunnel: { frpcPath: this.cfg.frp?.frpcPath ?? null } };
  }

  async writeConfig(nodes = this.nodes) {
    const toml = hubFrpConfigToml(this.cfg, nodes);
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, toml, 'utf8');
    return { path: this.configPath, toml, summary: parseFrpcTomlSummary(toml) };
  }

  async readPid() {
    try {
      const pid = Number.parseInt((await fs.readFile(this.pidPath, 'utf8')).trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch { return null; }
  }

  async status(nodes = this.nodes) {
    const pid = await this.readPid();
    const running = await pidAlive(pid);
    let logTail = null;
    try { logTail = (await fs.readFile(this.logPath, 'utf8')).split('\n').slice(-12).join('\n'); } catch { /* no log */ }
    return {
      enabled: this.cfg.frp?.enabled === true,
      serverAddr: this.cfg.frp?.serverAddr ?? null,
      serverPort: this.cfg.frp?.serverPort ?? null,
      frpcPath: await findFrpc(this._frpcCfg()),
      configPath: this.configPath,
      running,
      pid: running ? pid : null,
      reason: running ? null : (pid ? `pid ${pid} is not alive` : 'not started'),
      provider: this.cfg.frp?.provider ?? null,
      visitors: nodes.filter((n) => n.visitorPort).map((n) => ({ node: n.name, port: n.visitorPort, serverName: n.provider?.serverName ?? null })),
      logTail
    };
  }

  async allocateVisitorPort(nodes = this.nodes, base) {
    const start = base ?? this.cfg.frp?.visitorPortBase ?? 19110;
    const taken = new Set(nodes.map((n) => Number(n.visitorPort)).filter(Boolean));
    taken.add(this.cfg.port);
    let port = start;
    while (taken.has(port) || port > 65535) port += 1;
    while (!(await portFree(port))) port += 1;
    return port;
  }

  async adminPortAvailable(port) {
    return portFree(port);
  }

  async ensureAdminPort() {
    const base = this.cfg.frp?.adminPort ?? 7401;
    if (await portFree(base)) return base;
    for (let port = base + 1; port < Math.min(base + 250, 65535); port += 1) {
      if (await portFree(port)) {
        this.cfg.frp.adminPort = port;
        this.log.warn?.( `dsh-link hub: admin port ${base} is taken; using ${port}`);
        return port;
      }
    }
    throw new LinkError(3, 'no_admin_port', `no free frpc admin port near ${base}`);
  }

  async _waitAdminPortFree(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    const busy = (port) => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(300, () => done(true));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    while (Date.now() < deadline) {
      if (!(await busy(this.cfg.frp?.adminPort ?? 7401))) return true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async start(nodes = this.nodes) {
    if (!this.cfg.frp?.enabled) throw LinkError(3, 'frp_disabled', 'hub frp is disabled');
    const existing = await this.readPid();
    if (await pidAlive(existing)) return { running: true, pid: existing, configPath: this.configPath, reused: true };
    const frpc = await findFrpc(this._frpcCfg());
    if (!frpc) throw LinkError(3, 'frpc_missing', 'frpc binary not found; set frp.frpcPath or DSHLINK_FRPC');
    await this.ensureAdminPort();
    await this.writeConfig(nodes);
    await fs.mkdir(this.dir, { recursive: true });
    await this._waitAdminPortFree();
    const fd = openSync(this.logPath, 'a');
    let child;
    try {
      child = this.spawn(frpc, ['-c', this.configPath], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    } finally {
      closeSync(fd);
    }
    child.unref?.();
    await fs.writeFile(this.pidPath, String(child.pid) + '\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (!(await pidAlive(child.pid))) {
      let tail = '';
      try { tail = (await fs.readFile(this.logPath, 'utf8')).split('\n').slice(-8).join('\n'); } catch { /* ignore */ }
      await fs.rm(this.pidPath, { force: true });
      throw new LinkError(3, 'frpc_failed', `hub frpc exited immediately — check ${this.logPath}\n${tail}`);
    }
    this.log.info?.( `dsh-link hub: frpc started (pid ${child.pid}) with ${this.configPath}`);
    return { running: true, pid: child.pid, configPath: this.configPath, frpcPath: frpc, started: true };
  }

  async stop() {
    const pid = await this.readPid();
    if (!(await pidAlive(pid))) { await fs.rm(this.pidPath, { force: true }); return { stopped: false, reason: 'not running' }; }
    try { process.kill(pid); } catch (err) { return { stopped: false, reason: err.message }; }
    for (let i = 0; i < 30; i += 1) {
      if (!(await pidAlive(pid))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this._waitAdminPortFree();
    await fs.rm(this.pidPath, { force: true });
    return { stopped: true, pid };
  }

  /**
   * Bring the generated config in line with the current node list. Restarts frpc only when the
   * config actually changed, so re-enrolling a node with the same provider/visitor port never
   * tears down the very tunnel that carries the enrollment response.
   */
  async sync(nodes = this.nodes) {
    if (!this.cfg.frp?.enabled) return { running: false, reason: 'frp disabled', changed: false, configPath: this.configPath };
    let current = null;
    try { current = await fs.readFile(this.configPath, 'utf8'); } catch { /* first run */ }
    const next = hubFrpConfigToml(this.cfg, nodes);
    const pid = await this.readPid();
    const alive = await pidAlive(pid);
    if (alive && current === next) return { running: true, pid, changed: false, reused: true, configPath: this.configPath };
    return { ...(await this.relaunch(nodes)), changed: true };
  }

  /** Rebuild the visitor list and restart frpc. Failures are reported, never thrown. */
  async relaunch(nodes = this.nodes, { force = false } = {}) {
    await this.stop();
    if (!this.cfg.frp?.enabled) return { running: false, reason: 'frp disabled', configPath: this.configPath };
    try { return await this.start(nodes); } catch (err) {
      if (force) throw err;
      return { running: false, reason: err.message, configPath: this.configPath };
    }
  }

  /** Create or rotate the hub's own STCP provider secret. */
  ensureProvider() {
    const f = this.cfg.frp;
    if (!f.provider) f.provider = { name: 'dshlink-hub', secretKey: null };
    if (!f.provider.name) f.provider.name = 'dshlink-hub';
    if (!f.provider.secretKey) f.provider.secretKey = randomToken(24);
    return f.provider;
  }
}
