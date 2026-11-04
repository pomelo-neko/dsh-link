// dsh-link: network topology discovery. A node can walk its configured peers and ask each
// reachable peer for its own view of the network, so a phone (or an agent) sees every node that
// is reachable through the trust graph, not just the node it connected to.
import { DSHLINK_VERSION, nowIso, toInt } from './util.mjs';

export const NETWORK_DEFAULTS = { depth: 2, maxNodes: 20, timeoutMs: 2500 };
export const NETWORK_MAX_DEPTH = 3;
export const NETWORK_MAX_NODES = 50;

export function normalizeNetworkOptions(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    depth: toInt(source.depth, NETWORK_DEFAULTS.depth, { min: 1, max: NETWORK_MAX_DEPTH }),
    maxNodes: toInt(source.maxNodes, NETWORK_DEFAULTS.maxNodes, { min: 1, max: NETWORK_MAX_NODES }),
    timeoutMs: toInt(source.timeoutMs, NETWORK_DEFAULTS.timeoutMs, { min: 200, max: 10_000 })
  };
}

export function normalizeNodeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function text(value, max = 200) {
  const out = String(value ?? '').trim();
  return out ? out.slice(0, max) : null;
}

function pickDsh(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    enabled: source.enabled === true,
    workspaces: source.workspaces === true,
    transcripts: source.transcripts === true
  };
}

function pickCapabilities(value) {
  const source = value && typeof value === 'object' ? value : {};
  const methods = Array.isArray(source.methods)
    ? source.methods.map((m) => text(m, 120)).filter(Boolean).slice(0, 100)
    : [];
  return { enabled: source.enabled === true, methods };
}

function pickPeers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((peer) => ({
      name: text(peer?.name, 120),
      url: peer?.url ? String(peer.url).replace(/\/+$/, '') : null
    }))
    .filter((peer) => peer.name || peer.url)
    .slice(0, 100);
}

function cleanNode(node) {
  const source = node && typeof node === 'object' ? node : {};
  const latency = Number(node?.latencyMs);
  return {
    name: text(source.name, 120),
    nodeId: text(source.nodeId, 200),
    url: source.url ? String(source.url).replace(/\/+$/, '') : null,
    reachable: source.reachable === true,
    self: source.self === true,
    latencyMs: Number.isFinite(latency) ? Math.max(0, Math.round(latency)) : null,
    version: source.version ?? null,
    software: text(source.software, 80),
    softwareVersion: text(source.softwareVersion, 80),
    dsh: pickDsh(source.dsh),
    capabilities: pickCapabilities(source.capabilities),
    directPeers: pickPeers(source.directPeers),
    via: Array.isArray(source.via) ? source.via.map((v) => text(v, 120)).filter(Boolean).slice(0, 10) : [],
    error: text(source.error, 300) ?? undefined
  };
}

export function nodeKey(node) {
  if (node?.nodeId) return 'id:' + String(node.nodeId).toLowerCase();
  const url = normalizeNodeUrl(node?.url);
  if (url) return 'url:' + url;
  const name = text(node?.name, 120);
  return name ? 'name:' + name.toLowerCase() : null;
}

function unionPeers(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const peer of Array.isArray(list) ? list : []) {
      const key = (normalizeNodeUrl(peer?.url) ?? '') + '|' + String(peer?.name ?? '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: text(peer?.name, 120), url: peer?.url ? String(peer.url).replace(/\/+$/, '') : null });
      if (out.length >= 100) return out;
    }
  }
  return out;
}

function unionStrings(...lists) {
  const out = [];
  for (const list of lists) {
    for (const value of Array.isArray(list) ? list : []) {
      const item = text(value, 120);
      if (item && !out.includes(item)) out.push(item);
      if (out.length >= 10) return out;
    }
  }
  return out;
}

/** Insert or merge one node into the discovery table. Tokens and unknown fields never leak. */
export function mergeNode(table, node) {
  if (!table || typeof table.delete !== 'function') return null;
  const clean = cleanNode(node);
  const key = nodeKey(clean);
  if (!key) return null;

  let existingKey = null;
  let existing = null;
  for (const [candidateKey, candidate] of table) {
    const sameId = clean.nodeId && candidate.nodeId && clean.nodeId === candidate.nodeId;
    const sameUrl = normalizeNodeUrl(clean.url) && normalizeNodeUrl(clean.url) === normalizeNodeUrl(candidate.url);
    const sameName = clean.name && candidate.name && clean.name === candidate.name;
    if (sameId || sameUrl || sameName) { existingKey = candidateKey; existing = candidate; break; }
  }
  if (!existing) {
    table.set(key, clean);
    return clean;
  }

  const merged = cleanNode({
    ...existing,
    ...clean,
    self: existing.self === true || clean.self === true,
    reachable: existing.reachable === true || clean.reachable === true,
    latencyMs: clean.latencyMs ?? existing.latencyMs,
    directPeers: unionPeers(existing.directPeers, clean.directPeers),
    via: unionStrings(existing.via, clean.via)
  });
  if (existingKey !== key) table.delete(existingKey);
  table.set(key, merged);
  return merged;
}

/** The local node as it appears in a network scan (never includes secrets). */
export function selfNetworkNode(cfg) {
  return cleanNode({
    name: cfg.name,
    nodeId: cfg.nodeId,
    url: cfg.publicUrl ?? null,
    reachable: true,
    self: true,
    latencyMs: 0,
    version: cfg.version,
    software: 'dsh-link',
    softwareVersion: DSHLINK_VERSION,
    dsh: {
      enabled: cfg.dsh?.enabled === true,
      workspaces: cfg.dsh?.enabled === true && cfg.dsh?.exposeWorkspaces === true,
      transcripts: cfg.dsh?.enabled === true && cfg.dsh?.exposeTranscripts === true
    },
    capabilities: {
      enabled: cfg.capabilities?.enabled === true,
      methods: cfg.capabilities?.enabled === true ? cfg.capabilities.methods : []
    },
    directPeers: (Array.isArray(cfg.peers) ? cfg.peers : []).map((peer) => ({ name: peer.name, url: peer.url })),
    via: []
  });
}

export function nodeFromInfo(info, peer, latencyMs) {
  return cleanNode({
    name: info?.name ?? peer?.name,
    nodeId: info?.nodeId ?? null,
    url: info?.publicUrl ?? peer?.url ?? null,
    reachable: true,
    self: false,
    latencyMs,
    version: info?.version ?? null,
    software: info?.software ?? 'dsh-link',
    softwareVersion: info?.softwareVersion ?? null,
    dsh: info?.dsh,
    capabilities: info?.capabilities,
    directPeers: info?.peers,
    via: []
  });
}

function withVia(node, via) {
  return { ...node, self: false, via: unionStrings(via, node?.via) };
}

/**
 * Discover the network reachable from this node.
 * depth 1 = this node + directly configured peers; depth 2 adds their peers, and so on.
 */
export async function scanNetwork({ cfg, clientFor, logger, options = {} } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const settings = normalizeNetworkOptions(options);
  const nodes = new Map();
  const errors = [];
  let partial = false;

  mergeNode(nodes, selfNetworkNode(cfg));
  const peers = Array.isArray(cfg?.peers) ? cfg.peers : [];

  await Promise.all(peers.map(async (peer) => {
    const started = Date.now();
    let client;
    try {
      client = clientFor(peer.name, { timeoutMs: settings.timeoutMs });
    } catch (err) {
      mergeNode(nodes, { name: peer.name, url: peer.url, reachable: false, self: false, error: err?.message ?? String(err) });
      errors.push({ peer: peer.name, error: err?.message ?? String(err) });
      return;
    }

    let info;
    try {
      info = await client.info();
    } catch (err) {
      const message = err?.message ?? String(err);
      mergeNode(nodes, { name: peer.name, url: peer.url, reachable: false, self: false, error: message });
      errors.push({ peer: peer.name, error: message });
      return;
    }

    mergeNode(nodes, nodeFromInfo(info, peer, Date.now() - started));
    if (settings.depth <= 1) return;

    try {
      const sub = await client.networkNodes({
        depth: settings.depth - 1,
        maxNodes: settings.maxNodes,
        timeoutMs: settings.timeoutMs
      });
      for (const node of Array.isArray(sub?.nodes) ? sub.nodes : []) {
        mergeNode(nodes, withVia(node, [peer.name]));
      }
      if (sub?.partial === true) partial = true;
      for (const item of Array.isArray(sub?.errors) ? sub.errors : []) {
        errors.push({ peer: item?.peer ? peer.name + '/' + item.peer : peer.name, error: item?.error ?? 'remote scan error' });
      }
    } catch (err) {
      partial = true;
      errors.push({ peer: peer.name, error: 'network scan failed: ' + (err?.message ?? String(err)) });
    }
  }));

  const all = [...nodes.values()].sort((left, right) => {
    if (left.self !== right.self) return left.self ? -1 : 1;
    if (left.reachable !== right.reachable) return left.reachable ? -1 : 1;
    return String(left.name ?? '').localeCompare(String(right.name ?? ''));
  });
  const visible = all.slice(0, settings.maxNodes);
  if (all.length > visible.length) partial = true;
  log.debug?.('network scan: ' + visible.length + '/' + all.length + ' node(s), depth ' + settings.depth + ', ' + errors.length + ' error(s)');

  return {
    self: all.find((node) => node.self) ?? null,
    nodes: visible,
    count: visible.length,
    total: all.length,
    depth: settings.depth,
    partial,
    truncated: all.length > visible.length,
    errors: errors.slice(0, 20),
    scannedAt: nowIso()
  };
}
