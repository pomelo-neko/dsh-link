// dsh-link: configuration + identity. Config lives in the data dir as dshlink.config.json.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DSHLINK_VERSION, LinkError, badRequest, expandEnv, isPlainObject, newId, randomToken, safeEqual, sha256Hex } from './util.mjs';
import { normalizeDshViewConfig } from './dshview.mjs';
import { normalizeCapabilityConfig } from './capabilities.mjs';

export const CONFIG_FILENAME = 'dshlink.config.json';

export function defaultDataDir() {
  if (process.env.DSHLINK_HOME) return path.resolve(expandEnv(process.env.DSHLINK_HOME));
  return path.join(os.homedir(), '.dshlink');
}

export function defaultNodeName() {
  const host = os.hostname().split('.')[0];
  const user = (process.env.USERNAME || process.env.USER || 'dsh').replace(/[^A-Za-z0-9_-]/g, '');
  return `${user}@${host}`.slice(0, 48);
}

export function slugName(value, fallback = 'node') {
  const s = String(value ?? '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_.@-]/g, '');
  return (s || fallback).slice(0, 48);
}

export const DEFAULT_DENY = [
  '**/.env', '**/.env.*', '**/.credentials.yaml', '**/.credentials.yml',
  '**/.ssh/**', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519*',
  '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/credentials.json'
];

export const DEFAULT_LIMITS = {
  maxBodyBytes: 32 * 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxInlineAttachmentBytes: 512 * 1024,
  maxListEntries: 2000,
  requestTimeoutMs: 60_000,
  // Requests per minute per token (or per source IP for unauthenticated/local calls), across all
  // routes. 0 disables the limiter. Keeps a leaked or hostile peer token from hammering the node.
  maxRequestsPerMinute: 1200
};

// Loopback token gateway: a separate 127.0.0.1 listener that always requires a token before it
// proxies to the real node API. It exists because a request that reaches the API through an
// frp/STCP tunnel arrives from 127.0.0.1, and an old config with auth.trustLocalhost: true would
// otherwise let it through without a token (src/server.mjs authorize). The gateway never trusts
// the source address: no valid token, no request.
// Optional STCP provider for the gateway: when set, the generated frpc.toml publishes the gateway
// port (not the plain API port) under this name, so a phone/remote controller can reach the
// token-checking listener without opening a new public port. The phone's visitor must use the same
// secretKey; leave secretKey null to skip generating the provider.
export const DEFAULT_GATEWAY_PROVIDER = { name: 'dshlink-phone', secretKey: null };

export const DEFAULT_GATEWAY = {
  enabled: false,
  bind: '127.0.0.1',
  port: 8788,
  upstream: 'http://127.0.0.1:8787',
  maxBodyBytes: 2 * 1024 * 1024,
  timeoutMs: 60_000,
  provider: { ...DEFAULT_GATEWAY_PROVIDER }
};

/** True for loopback addresses: 127.0.0.0/8, ::1 and IPv4-mapped IPv6 loopback. */
export function isLoopbackAddress(value) {
  const address = String(value ?? '').trim().toLowerCase();
  if (!address) return false;
  if (address === 'localhost' || address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = v4.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function gatewayInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const n = Math.trunc(parsed);
  return n >= min && n <= max ? n : fallback;
}

function normalizeGatewayProvider(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const name = typeof source.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(source.name.trim())
    ? source.name.trim()
    : DEFAULT_GATEWAY_PROVIDER.name;
  const secret = typeof source.secretKey === 'string' ? source.secretKey.trim() : '';
  const secretKey = secret && secret !== 'CHANGE_ME' ? secret : DEFAULT_GATEWAY_PROVIDER.secretKey;
  return { name, secretKey };
}

function normalizeGatewayUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_GATEWAY.upstream;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_GATEWAY.upstream;
    // The gateway forwards the request path as-is, so upstream is an origin (no base path).
    return url.origin;
  } catch {
    return DEFAULT_GATEWAY.upstream;
  }
}

/**
 * Normalize the gateway config section. Tolerant by design: a typo must not keep the node from
 * booting, so every invalid value falls back to the safe default instead of throwing. The bind
 * address is forced to loopback (the gateway is not meant to be reachable directly).
 */
export function normalizeGatewayConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const bind = typeof source.bind === 'string' && isLoopbackAddress(source.bind) ? source.bind.trim() : DEFAULT_GATEWAY.bind;
  return {
    enabled: source.enabled === true,
    bind,
    port: gatewayInt(source.port, DEFAULT_GATEWAY.port, 1, 65535),
    upstream: normalizeGatewayUpstream(source.upstream),
    maxBodyBytes: gatewayInt(source.maxBodyBytes, DEFAULT_GATEWAY.maxBodyBytes, 1, 512 * 1024 * 1024),
    timeoutMs: gatewayInt(source.timeoutMs, DEFAULT_GATEWAY.timeoutMs, 1, 3_600_000),
    provider: normalizeGatewayProvider(source.provider)
  };
}

// Inbound token roles. A token without a role is a legacy token and behaves as "admin".
//   admin  - full control (local tooling, installation)
//   bridge - only what the local dsh-link-bridge plugin needs: read inbox/read marks + bridge channel
//   peer   - another dsh-link node: send messages, read its own inbox/outbox, read DSH view
//   device - a mobile/desktop controller: read DSH view, call capabilities, send messages; no admin APIs
// 'hub' is the role a node issues to the hub it enrolled with: it may deliver messages (keeping
// the original sender's identity) and use the DSH view / file proxy, but it is not an admin token.
export const TOKEN_ROLES = ['admin', 'bridge', 'peer', 'device', 'enroll', 'hub'];
export const DEFAULT_TOKEN_ROLE = 'admin';

export function normalizeTokenRole(value, fallback = DEFAULT_TOKEN_ROLE) {
  const role = String(value ?? fallback).trim().toLowerCase();
  if (!TOKEN_ROLES.includes(role)) throw badRequest(`token role must be one of: ${TOKEN_ROLES.join(', ')}`);
  return role;
}

// ---------------------------------------------------------------- hub link (0.8) ---
// A node in hub topology keeps exactly one outbound channel to the hub. The hub section is
// tolerant (a broken hub block must not stop the node from booting); the link itself only starts
// when enabled + url + token are all present, so a half-written config stays in p2p mode.
export const DEFAULT_HUB = {
  enabled: false,
  url: null,
  token: null,
  timeoutMs: 30_000,
  heartbeatSeconds: 30,
  visitorPort: 18_790,
  reconnect: { minSeconds: 5, maxSeconds: 60 },
  enrollment: { token: null, autoEnroll: false },
  frp: { serverAddr: null, serverPort: null, serverName: null, secretKey: null },
  peersIgnored: true,
  enrolled: null
};

function hubInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const n = Math.trunc(parsed);
  return n >= min && n <= max ? n : fallback;
}

function normalizeHubUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function normalizeHubConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const url = normalizeHubUrl(source.url);
  const token = source.token ? expandEnv(String(source.token)) : null;
  const reconnectSource = isPlainObject(source.reconnect) ? source.reconnect : {};
  const enrollmentSource = isPlainObject(source.enrollment) ? source.enrollment : {};
  const frpSource = isPlainObject(source.frp) ? source.frp : {};
  const enrolledSource = isPlainObject(source.enrolled) ? source.enrolled : null;
  let enrolled = null;
  if (enrolledSource) {
    enrolled = {
      hubName: enrolledSource.hubName ? String(enrolledSource.hubName) : null,
      nodeName: enrolledSource.nodeName ? String(enrolledSource.nodeName) : null,
      enrolledAt: enrolledSource.enrolledAt ? String(enrolledSource.enrolledAt) : null,
      visitorPort: Number(enrolledSource.visitorPort ?? 0) || null,
      downlinkUrl: enrolledSource.downlinkUrl ? String(enrolledSource.downlinkUrl) : null
    };
  }
  return {
    enabled: source.enabled === true,
    url,
    token,
    timeoutMs: hubInt(source.timeoutMs, DEFAULT_HUB.timeoutMs, 1000, 600_000),
    heartbeatSeconds: hubInt(source.heartbeatSeconds, DEFAULT_HUB.heartbeatSeconds, 5, 3600),
    reconnect: {
      minSeconds: hubInt(reconnectSource.minSeconds, DEFAULT_HUB.reconnect.minSeconds, 1, 300),
      maxSeconds: hubInt(reconnectSource.maxSeconds, DEFAULT_HUB.reconnect.maxSeconds, 5, 3600)
    },
    enrollment: {
      token: enrollmentSource.token ? expandEnv(String(enrollmentSource.token)) : null,
      autoEnroll: enrollmentSource.autoEnroll === true
    },
    visitorPort: hubInt(source.visitorPort, DEFAULT_HUB.visitorPort, 1, 65535),
    frp: {
      serverAddr: frpSource.serverAddr ? String(frpSource.serverAddr) : null,
      serverPort: frpSource.serverPort ? hubInt(frpSource.serverPort, 7000, 1, 65535) : null,
      serverName: frpSource.serverName ? String(frpSource.serverName) : null,
      secretKey: frpSource.secretKey ? expandEnv(String(frpSource.secretKey)) : null
    },
    peersIgnored: source.peersIgnored !== false,
    enrolled
  };
}

function normalizeExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest('token expiresAt must be a valid ISO date or timestamp');
  return date.toISOString();
}

export function defaultConfig(overrides = {}) {
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : defaultDataDir();
  return {
    version: 1,
    name: slugName(overrides.name ?? defaultNodeName()),
    nodeId: overrides.nodeId ?? newId('node'),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    bind: overrides.bind ?? '127.0.0.1',
    port: overrides.port ?? 8787,
    publicUrl: overrides.publicUrl ?? null,
    dataDir,
    // Secure by default (0.5.0): the old default (true) let anything that reached the port through
    // a loopback-forwarding tunnel — e.g. frp/STCP visitor — call the whole API without a token.
    auth: { trustLocalhost: false, tokens: [] },
    limits: { ...DEFAULT_LIMITS },
    files: { allowUpload: false, roots: [], deny: [...DEFAULT_DENY] },
    dsh: normalizeDshViewConfig({}),
    capabilities: normalizeCapabilityConfig({}),
    gateway: normalizeGatewayConfig({}),
    hub: normalizeHubConfig({}),
    peers: [],
    relay: { enabled: true },
    log: { level: 'info' }
  };
}

export function normalizeRoot(root) {
  // A "workspaces" root is virtual: its first path segment selects a DSH workspace from the
  // local workspace registry, so one root exposes every workspace on this machine.
  if (isPlainObject(root) && (root.kind === 'workspaces' || root.kind === 'dsh-workspaces')) {
    if (!root.name) throw badRequest('a workspaces root needs a name');
    return { name: slugName(root.name), kind: 'workspaces', path: null, read: root.read !== false, write: root.write === true };
  }
  if (typeof root === 'string') {
    const eq = root.indexOf('=');
    if (eq <= 0) throw badRequest('root spec must look like: name=C:\\path[:ro|:rw]');
    const name = root.slice(0, eq);
    let p = root.slice(eq + 1);
    const modeMatch = /:(rw|ro|none|read|write)$/i.exec(p);
    const mode = (modeMatch ? p.slice(modeMatch.index + 1) : '').toLowerCase();
    if (modeMatch) p = p.slice(0, modeMatch.index);
    if (!name || !p) throw badRequest('root spec must look like: name=C:\\path[:ro|:rw]');
    return { name: slugName(name), path: path.resolve(expandEnv(p)), read: mode !== 'none', write: mode === 'rw' || mode === 'write' };
  }
  if (!isPlainObject(root) || !root.name || !root.path) throw badRequest('each file root needs {name, path}');
  return {
    name: slugName(root.name),
    kind: 'dir',
    path: path.resolve(expandEnv(String(root.path))),
    read: root.read !== false,
    write: root.write === true
  };
}

export function normalizeConfig(raw, baseDir) {
  if (!isPlainObject(raw)) throw badRequest('config must be a JSON object');
  const defaults = defaultConfig();
  const dataDir = path.resolve(baseDir ? baseDir : (raw.dataDir ? expandEnv(String(raw.dataDir)) : defaults.dataDir));
  const cfg = {
    ...defaults,
    ...raw,
    dataDir,
    auth: {
      // Secure by default; an existing config that explicitly said true keeps that (loudly warned
      // about by `dshlink doctor` / `dshlink harden`).
      trustLocalhost: raw.auth?.trustLocalhost === true,
      tokens: (raw.auth?.tokens ?? []).map((t) => {
        const role = t.role === undefined || t.role === null || t.role === '' ? undefined : normalizeTokenRole(t.role);
        const peer = t.peer === undefined || t.peer === null || String(t.peer).trim() === '' ? null : slugName(t.peer);
        if (role === 'peer' && !peer) throw badRequest('a token with role "peer" must name its peer (auth.tokens[].peer)');
        return {
          id: t.id ?? newId('tok'),
          label: String(t.label ?? 'token').slice(0, 64),
          hash: t.hash ? String(t.hash) : undefined,
          token: t.token ? expandEnv(String(t.token)) : undefined,
          role,
          peer,
          expiresAt: normalizeExpiry(t.expiresAt),
          createdAt: t.createdAt ?? new Date().toISOString(),
          // Enrollment tokens are limited-use; the hub tracks actual uses in its state file.
          maxUses: t.maxUses === undefined || t.maxUses === null || t.maxUses === ''
            ? null
            : hubInt(t.maxUses, null, 1, 10_000),
          note: t.note
        };
      })
    },
    limits: { ...defaults.limits, ...(raw.limits ?? {}) },
    dsh: normalizeDshViewConfig(raw.dsh ?? {}),
    capabilities: normalizeCapabilityConfig(raw.capabilities ?? {}),
    gateway: normalizeGatewayConfig(raw.gateway),
    hub: normalizeHubConfig(raw.hub),
    files: {
      allowUpload: raw.files?.allowUpload === true,
      deny: Array.isArray(raw.files?.deny) ? raw.files.deny.map(String) : [...DEFAULT_DENY],
      roots: (raw.files?.roots ?? []).map(normalizeRoot)
    },
    peers: (raw.peers ?? []).map((p) => {
      if (!isPlainObject(p) || !p.name) throw badRequest('each peer needs {name, url} or {name, stcp}');
      const stcp = isPlainObject(p.stcp)
        ? {
            serverName: String(p.stcp.serverName ?? p.stcp.proxyName ?? `dshlink-${slugName(p.name)}`),
            secretKey: p.stcp.secretKey ? expandEnv(String(p.stcp.secretKey)) : null,
            visitorPort: Number(p.stcp.visitorPort ?? 0) || 0
          }
        : null;
      const url = p.url ? String(expandEnv(p.url)).replace(/\/+$/, '') : (stcp?.visitorPort ? `http://127.0.0.1:${stcp.visitorPort}` : null);
      if (!url && !stcp) throw badRequest(`peer "${p.name}" needs a url or an stcp block`);
      return {
        name: slugName(p.name),
        url,
        token: p.token ? expandEnv(String(p.token)) : undefined,
        autoSync: p.autoSync === true,
        note: p.note,
        stcp
      };
    }),
    tunnel: {
      enabled: raw.tunnel?.enabled === true,
      serverAddr: raw.tunnel?.serverAddr ? String(expandEnv(raw.tunnel.serverAddr)) : null,
      serverPort: Number(raw.tunnel?.serverPort ?? 7000),
      token: raw.tunnel?.token ? expandEnv(String(raw.tunnel.token)) : null,
      user: raw.tunnel?.user ? String(raw.tunnel.user) : 'dsh-link',
      tls: raw.tunnel?.tls !== false,
      frpcPath: raw.tunnel?.frpcPath ? path.resolve(expandEnv(String(raw.tunnel.frpcPath))) : null,
      adminPort: Number(raw.tunnel?.adminPort ?? 7400),
      visitorPortBase: Number(raw.tunnel?.visitorPortBase ?? 19100),
      logDir: raw.tunnel?.logDir ? path.resolve(expandEnv(String(raw.tunnel.logDir))) : null,
      autoStart: raw.tunnel?.autoStart === true
    },
    stcp: {
      proxyName: raw.stcp?.proxyName ? String(raw.stcp.proxyName) : `dshlink-${slugName(raw.name ?? defaults.name)}`,
      secretKey: raw.stcp?.secretKey ? expandEnv(String(raw.stcp.secretKey)) : null,
      publicAddr: raw.stcp?.publicAddr ? String(raw.stcp.publicAddr) : null
    },
    relay: { enabled: raw.relay?.enabled !== false },
    log: { level: raw.log?.level ?? 'info' }
  };
  cfg.name = slugName(raw.name ?? defaults.name);
  cfg.nodeId = String(raw.nodeId ?? defaults.nodeId);
  cfg.bind = String(raw.bind ?? defaults.bind);
  cfg.port = Number(raw.port ?? defaults.port);
  cfg.publicUrl = raw.publicUrl ? String(raw.publicUrl).replace(/\/+$/, '') : null;
  delete cfg.configPath;
  return cfg;
}

export function configPathFor({ configPath, dataDir } = {}) {
  if (configPath) return path.resolve(expandEnv(configPath));
  return path.join(path.resolve(expandEnv(dataDir ?? defaultDataDir())), CONFIG_FILENAME);
}

export async function loadConfig({ configPath, dataDir, overrides = {} } = {}) {
  const file = configPathFor({ configPath, dataDir });
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (!overrides.allowMissing) {
        throw new LinkError(2, 'no_config', `no config at ${file} — run: dshlink init --name <name>`);
      }
      raw = {};
    } else if (err instanceof SyntaxError) {
      throw badRequest(`config file is not valid JSON: ${file}`);
    } else {
      throw err;
    }
  }
  const merged = { ...raw, ...(overrides.raw ?? {}) };
  const cfg = normalizeConfig(merged, path.dirname(file));
  if (overrides.name) cfg.name = slugName(overrides.name);
  if (overrides.bind) cfg.bind = overrides.bind;
  if (overrides.port !== undefined && overrides.port !== null) cfg.port = Number(overrides.port);
  cfg.configPath = file;
  return cfg;
}

export async function saveConfig(cfg, file = cfg.configPath ?? configPathFor({ dataDir: cfg.dataDir })) {
  const out = { ...cfg };
  delete out.configPath;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return file;
}

/**
 * Create an inbound token; the plaintext is returned once and stored hashed.
 * opts.role: admin|bridge|peer|device (default admin, so existing callers keep working).
 * opts.peer: required for role "peer", binds the token to one peer identity.
 * opts.expiresAt: ISO date or timestamp after which the token stops working.
 */
export function createInboundToken(cfg, label = 'peer', opts = {}) {
  const token = randomToken(32);
  const role = normalizeTokenRole(opts.role, DEFAULT_TOKEN_ROLE);
  const peer = opts.peer === undefined || opts.peer === null || String(opts.peer).trim() === '' ? null : slugName(opts.peer);
  if (role === 'peer' && !peer) throw badRequest('a token with role "peer" needs the peer name it is issued to');
  const entry = {
    id: newId('tok'),
    label: String(label).slice(0, 64),
    hash: sha256Hex(token),
    role,
    peer,
    expiresAt: normalizeExpiry(opts.expiresAt),
    createdAt: new Date().toISOString(),
    maxUses: opts.maxUses === undefined || opts.maxUses === null ? null : hubInt(opts.maxUses, null, 1, 10_000)
  };
  cfg.auth.tokens.push(entry);
  return { id: entry.id, token, label: entry.label, role: entry.role, peer: entry.peer, expiresAt: entry.expiresAt, maxUses: entry.maxUses };
}

/** Replace any stored plaintext token with its sha256 hash. Returns count sealed. */
export function sealTokens(cfg) {
  let sealed = 0;
  for (const t of cfg.auth.tokens) {
    if (t.token && !t.hash) { t.hash = sha256Hex(t.token); t.token = undefined; sealed += 1; }
    else if (t.token && t.hash === sha256Hex(t.token)) { t.token = undefined; sealed += 1; }
  }
  return sealed;
}

export function verifyToken(cfg, presented) {
  if (typeof presented !== 'string' || presented.length === 0) return null;
  const digest = sha256Hex(presented);
  for (const t of cfg.auth.tokens) {
    const hit = (t.hash && safeEqual(t.hash, digest)) || (t.token && safeEqual(t.token, presented));
    if (!hit) continue;
    if (t.expiresAt && Date.parse(t.expiresAt) <= Date.now()) return null; // expired = unknown token
    return {
      id: t.id,
      label: t.label,
      // Legacy tokens (created before 0.5.0) carry no role; they keep full control.
      role: t.role ?? DEFAULT_TOKEN_ROLE,
      peer: t.peer ?? null,
      expiresAt: t.expiresAt ?? null,
      maxUses: t.maxUses ?? null
    };
  }
  return null;
}

export function findPeer(cfg, name) {
  const wanted = slugName(name);
  return cfg.peers.find((p) => p.name === wanted) ?? null;
}

export function publicInfo(cfg) {
  return {
    name: cfg.name,
    nodeId: cfg.nodeId,
    version: cfg.version,
    software: 'dsh-link',
    softwareVersion: DSHLINK_VERSION,
    publicUrl: cfg.publicUrl,
    roots: cfg.files.roots.map((r) => r.kind === 'workspaces'
      ? { name: r.name, kind: 'workspaces', read: r.read, write: r.write }
      : { name: r.name, read: r.read, write: r.write }),
    dsh: {
      enabled: cfg.dsh.enabled === true,
      workspaces: cfg.dsh.enabled === true && cfg.dsh.exposeWorkspaces === true,
      transcripts: cfg.dsh.enabled === true && cfg.dsh.exposeTranscripts === true
    },
    capabilities: {
      enabled: cfg.capabilities.enabled === true,
      methods: cfg.capabilities.enabled === true ? cfg.capabilities.methods : []
    },
    allowUpload: cfg.files.allowUpload,
    relay: cfg.relay.enabled,
    hub: { enabled: cfg.hub?.enabled === true, url: cfg.hub?.url ?? null, enrolled: !!cfg.hub?.enrolled },
    peers: cfg.peers.map((p) => ({ name: p.name, url: p.url, hasToken: !!p.token }))
  };
}