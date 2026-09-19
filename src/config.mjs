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
  requestTimeoutMs: 60_000
};

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
    auth: { trustLocalhost: true, tokens: [] },
    limits: { ...DEFAULT_LIMITS },
    files: { allowUpload: false, roots: [], deny: [...DEFAULT_DENY] },
    dsh: normalizeDshViewConfig({}),
    capabilities: normalizeCapabilityConfig({}),
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
      trustLocalhost: raw.auth?.trustLocalhost !== false,
      tokens: (raw.auth?.tokens ?? []).map((t) => ({
        id: t.id ?? newId('tok'),
        label: String(t.label ?? 'token').slice(0, 64),
        hash: t.hash ? String(t.hash) : undefined,
        token: t.token ? expandEnv(String(t.token)) : undefined,
        createdAt: t.createdAt ?? new Date().toISOString(),
        note: t.note
      }))
    },
    limits: { ...defaults.limits, ...(raw.limits ?? {}) },
    dsh: normalizeDshViewConfig(raw.dsh ?? {}),
    capabilities: normalizeCapabilityConfig(raw.capabilities ?? {}),
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

/** Create an inbound token; the plaintext is returned once and stored hashed. */
export function createInboundToken(cfg, label = 'peer') {
  const token = randomToken(32);
  const entry = {
    id: newId('tok'),
    label: String(label).slice(0, 64),
    hash: sha256Hex(token),
    createdAt: new Date().toISOString()
  };
  cfg.auth.tokens.push(entry);
  return { id: entry.id, token, label: entry.label };
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
    if (t.hash && safeEqual(t.hash, digest)) return { id: t.id, label: t.label };
    if (t.token && safeEqual(t.token, presented)) return { id: t.id, label: t.label };
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
    peers: cfg.peers.map((p) => ({ name: p.name, url: p.url, hasToken: !!p.token }))
  };
}
