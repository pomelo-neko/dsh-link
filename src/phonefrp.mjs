// dsh-link 0.10 (B4): a dedicated frps tenant for phones.
//
// Phones receive the visitor side of an STCP proxy that points at the phone gateway. This tunnel is
// deliberately separate from the node/hub frps: its token, mTLS certificates and provider secret
// can be rotated (or abandoned) without touching the machine-to-machine network.
import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { LinkError, randomToken } from './util.mjs';
import { findFrpc, parseFrpcTomlSummary } from './tunnel.mjs';

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function tomlPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function phoneFrpConfigToml(cfg) {
  const f = cfg.phoneFrp ?? {};
  if (!f.serverAddr) throw new LinkError(3, 'phone_frp_not_configured', 'hub phoneFrp.serverAddr is not set');
  const provider = f.provider ?? {};
  if (!provider.secretKey) throw new LinkError(3, 'phone_frp_not_configured', 'hub phoneFrp.provider.secretKey is not set');
  const lines = [
    `serverAddr = ${tomlString(f.serverAddr)}`,
    `serverPort = ${Number(f.serverPort ?? 7000)}`,
    `user = ${tomlString(f.user ?? 'dsh-link-phone')}`,
    'loginFailExit = false',
    '',
    `auth.token = ${tomlString(f.token ?? '')}`,
    // Required for STCP providers; without it frps rejects every NewWorkConn.
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    '',
    `transport.tls.enable = ${f.tls !== false}`,
    'transport.tls.disableCustomTLSFirstByte = false',
    ...(f.certFile ? [`transport.tls.certFile = ${tomlString(tomlPath(f.certFile))}`] : []),
    ...(f.keyFile ? [`transport.tls.keyFile = ${tomlString(tomlPath(f.keyFile))}`] : []),
    ...(f.trustedCaFile ? [`transport.tls.trustedCaFile = ${tomlString(tomlPath(f.trustedCaFile))}`] : []),
    '',
    'webServer.addr = "127.0.0.1"',
    `webServer.port = ${Number(f.adminPort ?? 7402)}`,
    '',
    '[[proxies]]',
    `name = ${tomlString(provider.name ?? 'dshlink-phone')}`,
    'type = "stcp"',
    `secretKey = ${tomlString(provider.secretKey)}`,
    `allowUsers = [${tomlString(f.user ?? 'dsh-link-phone')}]`,
    'localIP = "127.0.0.1"',
    `localPort = ${Number(cfg.phoneGateway?.port ?? 8791)}`,
    'transport.useEncryption = true',
    'transport.useCompression = false'
  ];
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

export class PhoneTunnelManager {
  constructor(cfg, { log = console, spawnImpl = nodeSpawn } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.spawn = spawnImpl;
    this.dir = cfg.phoneFrp?.logDir ?? path.join(cfg.dataDir, 'phone-frp');
    this.configPath = cfg.phoneFrp?.configPath ?? path.join(this.dir, 'phone-frpc.toml');
    this.pidPath = path.join(this.dir, 'phone-frpc.pid');
    this.logPath = path.join(this.dir, 'phone-frpc.log');
  }

  _frpcCfg() {
    return {
      dataDir: this.cfg.dataDir,
      tunnel: { frpcPath: this.cfg.phoneFrp?.frpcPath ?? this.cfg.frp?.frpcPath ?? null }
    };
  }

  async writeConfig() {
    const toml = phoneFrpConfigToml(this.cfg);
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

  async status() {
    const pid = await this.readPid();
    const running = await pidAlive(pid);
    let logTail = null;
    try { logTail = (await fs.readFile(this.logPath, 'utf8')).split('\n').slice(-12).join('\n'); } catch { /* no log */ }
    return {
      enabled: this.cfg.phoneFrp?.enabled === true,
      serverAddr: this.cfg.phoneFrp?.serverAddr ?? null,
      serverPort: this.cfg.phoneFrp?.serverPort ?? null,
      frpcPath: await findFrpc(this._frpcCfg()),
      configPath: this.configPath,
      running,
      pid: running ? pid : null,
      reason: running ? null : (pid ? `pid ${pid} is not alive` : 'not started'),
      provider: this.cfg.phoneFrp?.provider ? { name: this.cfg.phoneFrp.provider.name, secretKeySet: !!this.cfg.phoneFrp.provider.secretKey } : null,
      bindPort: this.cfg.phoneFrp?.bindPort ?? null,
      gatewayPort: this.cfg.phoneGateway?.port ?? null,
      logTail
    };
  }

  async ensureAdminPort() {
    const base = this.cfg.phoneFrp?.adminPort ?? 7402;
    if (await portFree(base)) return base;
    for (let port = base + 1; port < Math.min(base + 250, 65535); port += 1) {
      if (await portFree(port)) {
        this.cfg.phoneFrp.adminPort = port;
        this.log.warn?.(`dsh-link hub: phone frpc admin port ${base} is taken; using ${port}`);
        return port;
      }
    }
    throw new LinkError(3, 'no_admin_port', `no free phone frpc admin port near ${base}`);
  }

  async start() {
    if (!this.cfg.phoneFrp?.enabled) throw LinkError(3, 'phone_frp_disabled', 'hub phoneFrp is disabled');
    const existing = await this.readPid();
    if (await pidAlive(existing)) return { running: true, pid: existing, configPath: this.configPath, reused: true };
    const frpc = await findFrpc(this._frpcCfg());
    if (!frpc) throw LinkError(3, 'frpc_missing', 'frpc binary not found; set phoneFrp.frpcPath, frp.frpcPath or DSHLINK_FRPC');
    await this.ensureAdminPort();
    await this.writeConfig();
    await fs.mkdir(this.dir, { recursive: true });
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
      throw new LinkError(3, 'frpc_failed', `phone frpc exited immediately — check ${this.logPath}\n${tail}`);
    }
    this.log.info?.(`dsh-link hub: phone frpc started (pid ${child.pid}) with ${this.configPath}`);
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
    await fs.rm(this.pidPath, { force: true });
    return { stopped: true, pid };
  }

  async sync() {
    if (!this.cfg.phoneFrp?.enabled) return { running: false, reason: 'phone frp disabled', changed: false, configPath: this.configPath };
    let current = null;
    try { current = await fs.readFile(this.configPath, 'utf8'); } catch { /* first run */ }
    const next = phoneFrpConfigToml(this.cfg);
    const pid = await this.readPid();
    const alive = await pidAlive(pid);
    if (alive && current === next) return { running: true, pid, changed: false, reused: true, configPath: this.configPath };
    await this.stop();
    try { return { ...(await this.start()), changed: true }; } catch (err) { return { running: false, reason: err.message, changed: true, configPath: this.configPath }; }
  }

  ensureProvider() {
    const f = this.cfg.phoneFrp;
    if (!f.provider) f.provider = { name: 'dshlink-phone', secretKey: null };
    if (!f.provider.name) f.provider.name = 'dshlink-phone';
    if (!f.provider.secretKey) f.provider.secretKey = randomToken(24);
    return f.provider;
  }
}
