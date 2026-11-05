// dsh-link hub (0.8): configuration for the central hub process.
//
// The hub is a separate process with its own config/data directory. It does not run a DSH host
// and does not expose /mcp or /api/v1/bridge/*; it is a message switchboard, a file proxy and a
// DSH-view/capability proxy for the nodes that enrolled with it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DSHLINK_VERSION, expandEnv, isPlainObject, newId, randomToken, sha256Hex
} from './util.mjs';
import {
  DEFAULT_TOKEN_ROLE, normalizeTokenRole, verifyToken
} from './config.mjs';

export const HUB_CONFIG_FILENAME = 'dshlink-hub.config.json';
export const HUB_VERSION = 1;

export const DEFAULT_HUB_LIMITS = {
  maxBodyBytes: 32 * 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxInlineAttachmentBytes: 512 * 1024,
  requestTimeoutMs: 60_000,
  maxRequestsPerMinute: 2400
};

export const DEFAULT_HUB_ENROLLMENT = {
  enabled: true,
  mode: 'token',
  autoApprove: true,
  maxNodes: 32,
  maxUsesPerToken: 1,
  rateLimitPerMinute: 6,
  tokenTtlHours: 2
};

export const DEFAULT_HUB_FILES = {
  enabled: true,
  maxBytes: 256 * 1024 * 1024,
  maxConcurrent: 4,
  transport: 'hub'
};

export const DEFAULT_HUB_FRP = {
  enabled: false,
  frpcPath: null,
  configPath: null,
  logDir: null,
  adminPort: 7401,
  visitorPortBase: 19110,
  serverAddr: null,
  serverPort: 7000,
  user: 'dsh-link',
  token: null,
  tls: true,
  // Optional mutual-TLS files for an frps that requires client certificates (same semantics as
  // frpc's transport.tls.{certFile,keyFile,trustedCaFile}).
  certFile: null,
  keyFile: null,
  trustedCaFile: null,
  provider: { name: 'dshlink-hub', secretKey: null }
};

export function defaultHubDataDir() {
  const fromEnv = process.env.DSHLINK_HUB_HOME;
  return path.resolve(fromEnv && fromEnv.trim() ? expandEnv(fromEnv.trim()) : path.join(os.homedir(), '.dshlink-hub'));
}

function hubInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  const n = Math.trunc(parsed);
  return n >= min && n <= max ? n : fallback;
}

function hubBool(value, fallback = false) {
  if (value === true) return true;
  if (value === false) return false;
  return fallback;
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(expandEnv(value.trim()));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeHubToken(raw) {
  const t = isPlainObject(raw) ? raw : {};
  const role = t.role === undefined || t.role === null || t.role === '' ? DEFAULT_TOKEN_ROLE : normalizeTokenRole(t.role);
  const peer = t.peer === undefined || t.peer === null || String(t.peer).trim() === '' ? null : String(t.peer).trim();
  if (role === 'peer' && !peer) throw new Error('a token with role "peer" must name its node (auth.tokens[].peer)');
  return {
    id: t.id ? String(t.id) : newId('tok'),
    label: String(t.label ?? 'token').slice(0, 64),
    hash: t.hash ? String(t.hash) : undefined,
    token: t.token ? expandEnv(String(t.token)) : undefined,
    role,
    peer,
    expiresAt: normalizeExpiry(t.expiresAt),
    createdAt: t.createdAt ? String(t.createdAt) : new Date().toISOString(),
    maxUses: t.maxUses === undefined || t.maxUses === null || t.maxUses === '' ? null : hubInt(t.maxUses, null, 1, 10_000),
    note: t.note
  };
}

function normalizeStaticNode(raw) {
  if (!isPlainObject(raw) || !raw.name) throw new Error('each node needs {name} plus a url/token for static mode');
  const provider = isPlainObject(raw.provider) ? raw.provider : null;
  return {
    name: String(raw.name).trim(),
    nodeId: raw.nodeId ? String(raw.nodeId) : null,
    softwareVersion: raw.softwareVersion ? String(raw.softwareVersion) : null,
    url: normalizeUrl(raw.url),
    token: raw.token ? expandEnv(String(raw.token)) : null,
    visitorPort: hubInt(raw.visitorPort, 0, 0, 65535),
    provider: provider && provider.serverName
      ? { serverName: String(provider.serverName), secretKey: provider.secretKey ? expandEnv(String(provider.secretKey)) : null }
      : null,
    note: raw.note
  };
}

export function defaultHubConfig(overrides = {}) {
  const dataDir = overrides.dataDir ? path.resolve(expandEnv(String(overrides.dataDir))) : defaultHubDataDir();
  return {
    version: HUB_VERSION,
    role: 'hub',
    name: overrides.name ?? 'hub',
    nodeId: overrides.nodeId ?? newId('hub'),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    publicUrl: overrides.publicUrl ?? null,
    dataDir,
    bind: overrides.bind ?? '127.0.0.1',
    port: Number.isFinite(Number(overrides.port)) ? Number(overrides.port) : 8790,
    defaultNode: null,
    retrySeconds: 5,
    messageTtlSeconds: 7 * 24 * 3600,
    maxPendingPerTarget: 1000,
    heartbeatSeconds: 30,
    offlineAfterSeconds: 90,
    networkCacheSeconds: 15,
    auth: { tokens: [] },
    limits: { ...DEFAULT_HUB_LIMITS },
    files: { ...DEFAULT_HUB_FILES },
    enrollment: { ...DEFAULT_HUB_ENROLLMENT },
    frp: { ...DEFAULT_HUB_FRP, provider: { ...DEFAULT_HUB_FRP.provider } },
    nodes: [],
    log: { level: 'info' }
  };
}

/**
 * Normalize a hub config file. Like the node config this is intentionally tolerant so that a
 * typo in an optional block never stops the hub from booting; only structurally invalid token
 * entries throw.
 */
export function normalizeHubConfig(raw, baseDir) {
  if (!isPlainObject(raw)) throw new Error('hub config must be a JSON object');
  const defaults = defaultHubConfig();
  const dataDir = path.resolve(baseDir ? baseDir : (raw.dataDir ? expandEnv(String(raw.dataDir)) : defaults.dataDir));
  const limitsSource = isPlainObject(raw.limits) ? raw.limits : {};
  const filesSource = isPlainObject(raw.files) ? raw.files : {};
  const enrollmentSource = isPlainObject(raw.enrollment) ? raw.enrollment : {};
  const frpSource = isPlainObject(raw.frp) ? raw.frp : {};
  const logSource = isPlainObject(raw.log) ? raw.log : {};
  const cfg = {
    ...defaults,
    ...raw,
    version: HUB_VERSION,
    role: 'hub',
    dataDir,
    auth: {
      // Unlike the node, the hub never trusts loopback: the frp visitor makes a remote connection
      // look like 127.0.0.1, so every request must carry a token (design D4).
      tokens: (raw.auth?.tokens ?? []).map(normalizeHubToken)
    },
    limits: { ...DEFAULT_HUB_LIMITS, ...limitsSource },
    files: {
      enabled: hubBool(filesSource.enabled, DEFAULT_HUB_FILES.enabled),
      maxBytes: hubInt(filesSource.maxBytes, DEFAULT_HUB_FILES.maxBytes, 1, 4 * 1024 * 1024 * 1024),
      maxConcurrent: hubInt(filesSource.maxConcurrent, DEFAULT_HUB_FILES.maxConcurrent, 1, 32),
      transport: 'hub'
    },
    enrollment: {
      enabled: hubBool(enrollmentSource.enabled, DEFAULT_HUB_ENROLLMENT.enabled),
      mode: enrollmentSource.mode === 'manual' ? 'manual' : 'token',
      autoApprove: enrollmentSource.autoApprove !== false,
      maxNodes: hubInt(enrollmentSource.maxNodes, DEFAULT_HUB_ENROLLMENT.maxNodes, 1, 500),
      maxUsesPerToken: hubInt(enrollmentSource.maxUsesPerToken, DEFAULT_HUB_ENROLLMENT.maxUsesPerToken, 1, 10_000),
      rateLimitPerMinute: hubInt(enrollmentSource.rateLimitPerMinute, DEFAULT_HUB_ENROLLMENT.rateLimitPerMinute, 1, 600),
      tokenTtlHours: hubInt(enrollmentSource.tokenTtlHours, DEFAULT_HUB_ENROLLMENT.tokenTtlHours, 1, 24 * 30)
    },
    frp: {
      enabled: hubBool(frpSource.enabled, DEFAULT_HUB_FRP.enabled),
      frpcPath: frpSource.frpcPath ? path.resolve(expandEnv(String(frpSource.frpcPath))) : null,
      configPath: frpSource.configPath ? path.resolve(expandEnv(String(frpSource.configPath))) : null,
      logDir: frpSource.logDir ? path.resolve(expandEnv(String(frpSource.logDir))) : null,
      adminPort: hubInt(frpSource.adminPort, DEFAULT_HUB_FRP.adminPort, 1, 65535),
      visitorPortBase: hubInt(frpSource.visitorPortBase, DEFAULT_HUB_FRP.visitorPortBase, 1024, 65000),
      serverAddr: frpSource.serverAddr ? expandEnv(String(frpSource.serverAddr)) : null,
      serverPort: hubInt(frpSource.serverPort, DEFAULT_HUB_FRP.serverPort, 1, 65535),
      user: frpSource.user ? String(frpSource.user) : DEFAULT_HUB_FRP.user,
      token: frpSource.token ? expandEnv(String(frpSource.token)) : null,
      tls: frpSource.tls !== false,
      certFile: frpSource.certFile ? path.resolve(expandEnv(String(frpSource.certFile))) : null,
      keyFile: frpSource.keyFile ? path.resolve(expandEnv(String(frpSource.keyFile))) : null,
      trustedCaFile: frpSource.trustedCaFile ? path.resolve(expandEnv(String(frpSource.trustedCaFile))) : null,
      provider: {
        name: typeof frpSource.provider?.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(frpSource.provider.name.trim())
          ? frpSource.provider.name.trim()
          : DEFAULT_HUB_FRP.provider.name,
        secretKey: frpSource.provider?.secretKey ? expandEnv(String(frpSource.provider.secretKey)) : null
      }
    },
    nodes: (raw.nodes ?? []).map(normalizeStaticNode),
    log: { level: logSource.level ?? 'info' }
  };
  cfg.name = String(raw.name ?? defaults.name).trim() || 'hub';
  cfg.nodeId = String(raw.nodeId ?? defaults.nodeId);
  cfg.bind = String(raw.bind ?? defaults.bind);
  cfg.port = Number(raw.port ?? defaults.port);
  cfg.publicUrl = normalizeUrl(raw.publicUrl);
  cfg.defaultNode = raw.defaultNode ? String(raw.defaultNode).trim() : null;
  cfg.retrySeconds = hubInt(raw.retrySeconds, defaults.retrySeconds, 1, 3600);
  cfg.messageTtlSeconds = hubInt(raw.messageTtlSeconds, defaults.messageTtlSeconds, 60, 90 * 24 * 3600);
  cfg.maxPendingPerTarget = hubInt(raw.maxPendingPerTarget, defaults.maxPendingPerTarget, 1, 100_000);
  cfg.heartbeatSeconds = hubInt(raw.heartbeatSeconds, defaults.heartbeatSeconds, 5, 3600);
  cfg.offlineAfterSeconds = hubInt(raw.offlineAfterSeconds, defaults.offlineAfterSeconds, 10, 24 * 3600);
  cfg.networkCacheSeconds = hubInt(raw.networkCacheSeconds, defaults.networkCacheSeconds, 0, 3600);
  delete cfg.configPath;
  return cfg;
}

export function hubConfigPathFor({ configPath, dataDir } = {}) {
  if (configPath) return path.resolve(expandEnv(configPath));
  return path.join(path.resolve(expandEnv(dataDir ?? defaultHubDataDir())), HUB_CONFIG_FILENAME);
}

export async function loadHubConfig({ configPath, dataDir, allowMissing = false } = {}) {
  const file = hubConfigPathFor({ configPath, dataDir });
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && allowMissing) {
      raw = {};
    } else if (err.code === 'ENOENT') {
      const error = new Error(`no hub config at ${file}; run "dshlink hub init" first`);
      error.code = 'hub_config_missing';
      throw error;
    } else if (err instanceof SyntaxError) {
      throw new Error(`hub config is not valid JSON: ${file}`);
    } else {
      throw err;
    }
  }
  const cfg = normalizeHubConfig(raw, path.dirname(file));
  if (!raw.dataDir) cfg.dataDir = path.dirname(file);
  cfg.configPath = file;
  return cfg;
}

export async function saveHubConfig(cfg, file = cfg.configPath ?? hubConfigPathFor({ dataDir: cfg.dataDir })) {
  const out = { ...cfg };
  delete out.configPath;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return file;
}

/** Create a hub inbound token (admin/device/peer/enroll). */
export function createHubToken(cfg, label = 'token', opts = {}) {
  const token = randomToken(32);
  const role = normalizeTokenRole(opts.role, DEFAULT_TOKEN_ROLE);
  const peer = opts.peer === undefined || opts.peer === null || String(opts.peer).trim() === '' ? null : String(opts.peer).trim();
  if (role === 'peer' && !peer) throw new Error('a token with role "peer" needs the node name it is issued to');
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

export function verifyHubToken(cfg, presented) {
  return verifyToken(cfg, presented);
}

/** Info shape served by GET /api/v1/info. Never includes node tokens. */
export function hubPublicInfo(cfg, extra = {}) {
  return {
    name: cfg.name,
    nodeId: cfg.nodeId,
    version: cfg.version,
    role: 'hub',
    software: 'dsh-link-hub',
    softwareVersion: DSHLINK_VERSION,
    publicUrl: cfg.publicUrl,
    defaultNode: cfg.defaultNode,
    enrollment: { enabled: cfg.enrollment.enabled, mode: cfg.enrollment.mode },
    files: { enabled: cfg.files.enabled, maxBytes: cfg.files.maxBytes },
    limits: { maxMessageBytes: cfg.limits.maxMessageBytes, maxInlineAttachmentBytes: cfg.limits.maxInlineAttachmentBytes },
    ...extra
  };
}
