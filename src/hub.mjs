// dsh-link hub (0.8): the central switchboard for a dsh-link network.
//
// Topology (one channel per node):
//   node --POST /api/v1/messages--> hub --POST /api/v1/messages--> target node
// The hub authenticates the sender by its uplink token, stores every accepted message in a
// durable outbox, and delivers it through the target node's STCP visitor (or a static URL). It
// also proxies the read-only DSH view, capability calls and files so a phone only needs one
// connection. It never runs a DSH host, never exposes /mcp, and never trusts loopback addresses.
import http from 'node:http';
import { Readable } from 'node:stream';
import {
  API_PREFIX, DSHLINK_VERSION, LinkError, badRequest, conflict, forbidden, notFound,
  nowIso, toInt, unauthorized
} from './util.mjs';
import { LinkClient } from './client.mjs';
import { verifyHubToken, createHubToken, saveHubConfig, hubPublicInfo } from './hubconfig.mjs';
import { HubTunnelManager } from './hubfrp.mjs';
import { hubUiHtml } from './hubui.mjs';

const ALL_ROLES = ['admin', 'peer', 'device'];
const DSH_ROLES = ['admin', 'peer', 'device'];
const FILE_ROLES = ['admin', 'peer'];
const ENROLL_ROLES = ['enroll'];

function roleOf(auth) {
  if (auth?.token?.role) return auth.token.role;
  return 'anonymous';
}

function compileRoute(pattern) {
  const names = [];
  const source = pattern.split('/').map((segment) => {
    if (segment.startsWith(':')) { names.push(segment.slice(1)); return '([^/]+)'; }
    return segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  }).join('/');
  return { re: new RegExp('^' + source + '/?$'), names };
}

function localUrl(cfg) {
  const bind = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
  return cfg.publicUrl ?? 'http://' + bind + ':' + cfg.port;
}

function nodeSlug(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
}

function nodeOnline(record, cfg, now = Date.now()) {
  if (!record || record.status === 'disabled' || record.status === 'pending') return false;
  const stamp = record.lastHeartbeatAt ?? record.enrolledAt;
  if (!stamp) return false;
  return now - Date.parse(stamp) <= (cfg.offlineAfterSeconds ?? 90) * 1000 + (record.lastHeartbeatAt ? 0 : 120_000);
}

function nodeView(record, cfg) {
  return {
    name: record.name,
    kind: 'node',
    role: 'node',
    nodeId: record.nodeId ?? null,
    software: 'dsh-link',
    softwareVersion: record.softwareVersion ?? null,
    url: record.url ?? null,
    provider: record.provider?.serverName ?? null,
    visitorPort: record.visitorPort ?? null,
    status: nodeOnline(record, cfg) ? 'online' : (record.status ?? 'offline'),
    enrolledAt: record.enrolledAt ?? null,
    lastHeartbeatAt: record.lastHeartbeatAt ?? null,
    reachable: nodeOnline(record, cfg),
    latencyMs: record.latencyMs ?? null,
    dsh: { enabled: true, workspaces: true, transcripts: true },
    directPeers: [],
    via: []
  };
}

export function createHub({ cfg, store, logger, tunnel = null, clientFactory = null, saveConfig = null } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const routes = [];
  const authFailures = new Map();
  const enrollHits = new Map();
  const startedAt = Date.now();
  const clientForNode = clientFactory ?? ((record) => new LinkClient({
    baseUrl: record.url,
    token: record.token,
    timeoutMs: cfg.limits.requestTimeoutMs,
    label: 'hub->' + record.name
  }));
  let httpServer = null;
  let flushTimer = null;
  let runningRunningRefresh = null;
  let lastFlushAt = null;

  const frp = cfg.frp?.enabled === true
    ? (tunnel ?? new HubTunnelManager(cfg, [], { log }))
    : null;

  const add = (method, pattern, handler, opts = {}) => {
    const { re, names } = compileRoute(pattern);
    routes.push({
      method, re, names, handler,
      auth: opts.auth !== false,
      roles: opts.auth === false ? null : (opts.roles ?? ['admin'])
    });
  };
  function clientIp(req) {
    return String(req.socket.remoteAddress ?? '').replace('::ffff:', '');
  }

  function presentedToken(req) {
    const header = String(req.headers.authorization ?? '');
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    const alt = req.headers['x-dshlink-token'];
    if (typeof alt === 'string' && alt.trim()) return alt.trim();
    return null;
  }

  function authorize(req) {
    const ip = clientIp(req);
    const token = presentedToken(req);
    if (token) {
      const match = verifyHubToken(cfg, token);
      if (match) return { ok: true, via: 'token', token: match, ip };
    }
    // Deliberately no trustLocalhost fallback: through frp every remote request appears local.
    const now = Date.now();
    const record = authFailures.get(ip) ?? { count: 0, firstAt: now };
    if (now - record.firstAt > 60_000) { record.count = 0; record.firstAt = now; }
    record.count += 1;
    authFailures.set(ip, record);
    return { ok: false, via: 'none', token: null, ip, failures: record.count, throttled: record.count > 40 };
  }

  async function readBody(req, maxBytes) {
    const declared = toInt(req.headers['content-length'], -1);
    if (declared > maxBytes) throw new LinkError(413, 'too_large', 'body is ' + declared + ' bytes; limit is ' + maxBytes);
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new LinkError(413, 'too_large', 'body exceeds ' + maxBytes + ' bytes');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req, maxBytes = cfg.limits.maxBodyBytes) {
    const buffer = await readBody(req, maxBytes);
    if (!buffer.length) return {};
    let parsed;
    try { parsed = JSON.parse(buffer.toString('utf8')); } catch (err) { throw badRequest('body must be valid JSON'); }
    if (!parsed || typeof parsed !== 'object') throw badRequest('a JSON object body is required');
    return parsed;
  }

  function sendJson(res, status, payload, headers = {}) {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    });
    res.end(body);
  }

  function sendError(res, err) {
    const status = err instanceof LinkError ? err.status : 500;
    const payload = err instanceof LinkError
      ? { error: { code: err.code, message: err.message, details: err.details } }
      : { error: { code: 'internal_error', message: err?.message ?? String(err) } };
    if (!(err instanceof LinkError)) log.error('hub request failed:', err?.stack ?? String(err));
    sendJson(res, status, payload);
  }

  async function audit(entry) {
    try { await store.audit(entry); } catch (err) { log.warn('hub audit append failed:', err?.message ?? String(err)); }
  }

  // --------------------------------------------------------------- nodes ---
  async function nodeOrThrow(name) {
    const record = await store.getNode(name);
    if (!record) throw new LinkError(404, 'unknown_target', 'unknown target node: ' + name);
    return record;
  }

  async function activeNodes() {
    const nodes = await store.listNodes();
    return nodes.filter((n) => n.status !== 'disabled');
  }

  async function pickNode(peer) {
    const nodes = await activeNodes();
    const wanted = peer ? String(peer).trim() : (cfg.defaultNode || (nodes.length === 1 ? nodes[0].name : ''));
    if (!wanted) throw badRequest('peer is required: more than one node is enrolled and no defaultNode is configured');
    const record = nodes.find((n) => n.name === wanted);
    if (!record) throw new LinkError(404, 'unknown_target', 'unknown target node: ' + wanted);
    return record;
  }

  // --------------------------------------------------------------- deliver ---
  function retryDelay(attempts) {
    const base = Math.max(1, Number(cfg.retrySeconds ?? 5));
    return Math.min(base * 2 ** Math.min(attempts, 6), 300) * 1000;
  }

  async function deliverRecord(record) {
    if (!record?.id) return { state: 'dropped', reason: 'malformed record' };
    const existing = await store.getOutbox(record.id);
    const delivery = existing?.delivery ?? null;
    if (delivery?.state === 'delivered' || delivery?.state === 'dropped') return delivery;
    let target;
    try { target = await store.getNode(record.to); } catch (err) { target = null; }
    if (!target) {
      const next = { state: 'pending', attempts: Number(delivery?.attempts ?? 0) + 1, error: 'unknown target node', nextAttemptAt: new Date(Date.now() + 60_000).toISOString() };
      await store.setDelivery(record.id, next);
      return next;
    }
    const attempts = Number(delivery?.attempts ?? 0) + 1;
    try {
      const client = clientForNode(target);
      await client.deliverMessage(record);
      const next = { state: 'delivered', via: target.name, attempts, deliveredAt: nowIso() };
      await store.setDelivery(record.id, next);
      await store.upsertNode({ ...target, lastDeliveryAt: next.deliveredAt });
      return next;
    } catch (err) {
      const acceptedAt = Date.parse(delivery?.acceptedAt ?? record.ts ?? '') || Date.now();
      const expired = Date.now() - acceptedAt > Number(cfg.messageTtlSeconds ?? 604800) * 1000;
      const next = {
        state: expired ? 'dropped' : 'pending',
        attempts,
        error: String(err?.message ?? err).slice(0, 300),
        nextAttemptAt: expired ? null : new Date(Date.now() + retryDelay(attempts)).toISOString()
      };
      await store.setDelivery(record.id, next);
      return next;
    }
  }

  async function flushPending({ force = false } = {}) {
    const pending = await store.pendingOutbox();
    const now = Date.now();
    let delivered = 0;
    let failed = 0;
    let skipped = 0;
    for (const record of pending) {
      const nextAt = Date.parse(record.delivery?.nextAttemptAt ?? '') || 0;
      if (!force && nextAt > now) { skipped += 1; continue; }
      const result = await deliverRecord(record);
      if (result.state === 'delivered') delivered += 1; else failed += 1;
    }
    lastFlushAt = nowIso();
    return { attempted: pending.length - skipped, delivered, failed, skipped, pending: (await store.pendingOutbox()).length };
  }

  async function pendingFor(name) {
    const pending = await store.pendingOutbox();
    return pending.filter((m) => m.to === name);
  }

  // ------------------------------------------------------------- console ---
  function consoleUrl() {
    return (cfg.publicUrl ?? localUrl(cfg)).replace(/\/+$/, '') + '/ui';
  }

  function settingsView() {
    return {
      defaultNode: cfg.defaultNode ?? null,
      retrySeconds: Number(cfg.retrySeconds ?? 5),
      messageTtlSeconds: Number(cfg.messageTtlSeconds ?? 604800),
      maxPendingPerTarget: Number(cfg.maxPendingPerTarget ?? 1000),
      heartbeatSeconds: Number(cfg.heartbeatSeconds ?? 30),
      offlineAfterSeconds: Number(cfg.offlineAfterSeconds ?? 90),
      enrollment: {
        enabled: cfg.enrollment.enabled === true,
        mode: cfg.enrollment.mode,
        autoApprove: cfg.enrollment.autoApprove === true,
        maxNodes: Number(cfg.enrollment.maxNodes ?? 32),
        maxUsesPerToken: Number(cfg.enrollment.maxUsesPerToken ?? 1),
        rateLimitPerMinute: Number(cfg.enrollment.rateLimitPerMinute ?? 6),
        tokenTtlHours: Number(cfg.enrollment.tokenTtlHours ?? 2)
      },
      files: {
        enabled: cfg.files.enabled === true,
        maxBytes: Number(cfg.files.maxBytes ?? 0),
        maxConcurrent: Number(cfg.files.maxConcurrent ?? 4)
      },
      frp: {
        enabled: cfg.frp?.enabled === true,
        serverAddr: cfg.frp?.serverAddr ?? null,
        serverPort: Number(cfg.frp?.serverPort ?? 7000),
        providerName: cfg.frp?.provider?.name ?? null
      }
    };
  }

  function intSetting(value, name, min, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw badRequest(name + ' must be an integer between ' + min + ' and ' + max);
    }
    return n;
  }

  function boolSetting(value, name) {
    if (value !== true && value !== false) throw badRequest(name + ' must be a boolean');
    return value;
  }

  function assertKnownKeys(object, allowed, prefix) {
    for (const key of Object.keys(object)) {
      if (!allowed.includes(key)) throw badRequest('unknown setting: ' + prefix + key);
    }
  }

  // The console PATCH handler only accepts this whitelist: every other config field (tokens, frp
  // secrets, nodes, limits) is deliberately out of reach so the UI can never widen its own power.
  async function applySettings(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('a settings object is required');
    if (!Object.keys(body).length) throw badRequest('at least one setting is required');
    assertKnownKeys(body, [
      'defaultNode', 'retrySeconds', 'messageTtlSeconds', 'maxPendingPerTarget',
      'heartbeatSeconds', 'offlineAfterSeconds', 'enrollment', 'files'
    ], '');
    const applied = [];
    if (Object.prototype.hasOwnProperty.call(body, 'defaultNode')) {
      if (body.defaultNode === null || body.defaultNode === '') {
        cfg.defaultNode = null;
      } else {
        const wanted = String(body.defaultNode).trim();
        if (!(await store.getNode(wanted))) throw badRequest('defaultNode must be an enrolled node: ' + wanted);
        cfg.defaultNode = wanted;
      }
      applied.push('defaultNode');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'retrySeconds')) {
      cfg.retrySeconds = intSetting(body.retrySeconds, 'retrySeconds', 1, 3600);
      applied.push('retrySeconds');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'messageTtlSeconds')) {
      cfg.messageTtlSeconds = intSetting(body.messageTtlSeconds, 'messageTtlSeconds', 60, 90 * 24 * 3600);
      applied.push('messageTtlSeconds');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'maxPendingPerTarget')) {
      cfg.maxPendingPerTarget = intSetting(body.maxPendingPerTarget, 'maxPendingPerTarget', 1, 100_000);
      applied.push('maxPendingPerTarget');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'heartbeatSeconds')) {
      cfg.heartbeatSeconds = intSetting(body.heartbeatSeconds, 'heartbeatSeconds', 5, 3600);
      applied.push('heartbeatSeconds');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'offlineAfterSeconds')) {
      cfg.offlineAfterSeconds = intSetting(body.offlineAfterSeconds, 'offlineAfterSeconds', 10, 24 * 3600);
      applied.push('offlineAfterSeconds');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'enrollment')) {
      const source = body.enrollment;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw badRequest('enrollment must be an object');
      assertKnownKeys(source, [
        'enabled', 'autoApprove', 'maxNodes', 'maxUsesPerToken', 'rateLimitPerMinute', 'tokenTtlHours'
      ], 'enrollment.');
      if (Object.prototype.hasOwnProperty.call(source, 'enabled')) { cfg.enrollment.enabled = boolSetting(source.enabled, 'enrollment.enabled'); applied.push('enrollment.enabled'); }
      if (Object.prototype.hasOwnProperty.call(source, 'autoApprove')) { cfg.enrollment.autoApprove = boolSetting(source.autoApprove, 'enrollment.autoApprove'); applied.push('enrollment.autoApprove'); }
      if (Object.prototype.hasOwnProperty.call(source, 'maxNodes')) { cfg.enrollment.maxNodes = intSetting(source.maxNodes, 'enrollment.maxNodes', 1, 500); applied.push('enrollment.maxNodes'); }
      if (Object.prototype.hasOwnProperty.call(source, 'maxUsesPerToken')) { cfg.enrollment.maxUsesPerToken = intSetting(source.maxUsesPerToken, 'enrollment.maxUsesPerToken', 1, 10_000); applied.push('enrollment.maxUsesPerToken'); }
      if (Object.prototype.hasOwnProperty.call(source, 'rateLimitPerMinute')) { cfg.enrollment.rateLimitPerMinute = intSetting(source.rateLimitPerMinute, 'enrollment.rateLimitPerMinute', 1, 600); applied.push('enrollment.rateLimitPerMinute'); }
      if (Object.prototype.hasOwnProperty.call(source, 'tokenTtlHours')) { cfg.enrollment.tokenTtlHours = intSetting(source.tokenTtlHours, 'enrollment.tokenTtlHours', 1, 24 * 30); applied.push('enrollment.tokenTtlHours'); }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'files')) {
      const source = body.files;
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw badRequest('files must be an object');
      assertKnownKeys(source, ['enabled', 'maxBytes', 'maxConcurrent'], 'files.');
      if (Object.prototype.hasOwnProperty.call(source, 'enabled')) { cfg.files.enabled = boolSetting(source.enabled, 'files.enabled'); applied.push('files.enabled'); }
      if (Object.prototype.hasOwnProperty.call(source, 'maxBytes')) { cfg.files.maxBytes = intSetting(source.maxBytes, 'files.maxBytes', 1, 4 * 1024 * 1024 * 1024); applied.push('files.maxBytes'); }
      if (Object.prototype.hasOwnProperty.call(source, 'maxConcurrent')) { cfg.files.maxConcurrent = intSetting(source.maxConcurrent, 'files.maxConcurrent', 1, 32); applied.push('files.maxConcurrent'); }
    }
    if (!applied.length) throw badRequest('no setting changed');
    if (saveConfig) await saveConfig(cfg);
    return applied;
  }

  async function tokenViews() {
    const tokens = Array.isArray(cfg.auth.tokens) ? cfg.auth.tokens : [];
    return Promise.all(tokens.map(async (token) => ({
      id: token.id,
      label: token.label,
      role: token.role,
      peer: token.peer ?? null,
      expiresAt: token.expiresAt ?? null,
      createdAt: token.createdAt ?? null,
      maxUses: token.maxUses ?? null,
      uses: await store.tokenUses(token.id),
      note: token.note ?? null
    })));
  }

  // ---------------------------------------------------------- enrollment ---
  function enrollRateLimited(ip) {
    const now = Date.now();
    const record = enrollHits.get(ip) ?? { count: 0, firstAt: now };
    if (now - record.firstAt > 60_000) { record.count = 0; record.firstAt = now; }
    record.count += 1;
    enrollHits.set(ip, record);
    return record.count > Number(cfg.enrollment.rateLimitPerMinute ?? 6);
  }

  async function mergeStaticNodes() {
    for (const node of cfg.nodes ?? []) {
      const existing = await store.getNode(node.name);
      if (existing) continue;
      await store.upsertNode({
        name: node.name,
        nodeId: node.nodeId,
        softwareVersion: node.softwareVersion,
        url: node.url,
        token: node.token,
        provider: node.provider,
        visitorPort: node.visitorPort,
        status: node.url && node.token ? 'active' : 'pending',
        static: true,
        enrolledAt: node.enrolledAt ?? nowIso()
      });
    }
  }
  // Restarting frpc tears down the STCP provider that is carrying the request we are answering,
  // so a relaunch must never happen before the response has been written. Defer it just past the
  // response, and only restart when the generated config actually changed.
  function deferFrpSync(reason) {
    if (!(cfg.frp?.enabled && frp)) return;
    const timer = setTimeout(() => {
      activeNodes()
        .then((nodes) => frp.sync(nodes))
        .then((result) => { if (result?.changed) log.info('dsh-link hub: frpc restarted after ' + reason); })
        .catch((err) => log.warn('hub frp sync after ' + reason + ' failed:', err?.message ?? String(err)));
    }, 500);
    timer.unref?.();
  }

  async function enroll(body, auth) {
    if (!cfg.enrollment.enabled) throw forbidden('enrollment is disabled on this hub');
    if (enrollRateLimited(auth.ip)) throw new LinkError(429, 'rate_limited', 'too many enrollment attempts; wait a minute');
    const token = auth.token;
    const uses = await store.tokenUses(token.id);
    const maxUses = Number(token.maxUses ?? cfg.enrollment.maxUsesPerToken ?? 1);
    if (uses >= maxUses) throw forbidden('this enrollment token has already been used');
    const name = nodeSlug(body.name);
    if (!name) throw badRequest('a node name is required');
    if (name === cfg.name || name === 'hub' || name === 'self') throw badRequest('a node cannot be called ' + name);
    const existing = await store.getNode(name);
    // Re-enrolling the same node is allowed: when a node loses the enrollment response (for
    // example because the hub restarted frpc mid-request) it must be able to enroll again and
    // receive fresh tokens instead of being locked out by a 409.
    const reenroll = Boolean(existing && body.nodeId && existing.nodeId && String(existing.nodeId) === String(body.nodeId));
    if (existing && !reenroll) throw conflict('node_exists', 'a node named ' + name + ' is already enrolled');
    const nodes = await activeNodes();
    if (!reenroll && nodes.length >= cfg.enrollment.maxNodes) throw new LinkError(429, 'max_nodes', 'the hub already has ' + nodes.length + ' nodes');
    if (!body.downlinkToken || typeof body.downlinkToken !== 'string') {
      throw badRequest('downlinkToken is required: the node must create a peer token for the hub first');
    }
    let visitorPort = null;
    let downlinkUrl = body.downlinkUrl ? String(body.downlinkUrl).replace(/\/+$/, '') : null;
    if (cfg.frp?.enabled) {
      if (!body.provider?.serverName || !body.provider?.secretKey) {
        throw badRequest('provider {serverName, secretKey} is required when hub frp is enabled');
      }
      const active = await activeNodes();
      visitorPort = frp ? await frp.allocateVisitorPort(active) : null;
      if (!visitorPort) throw new LinkError(503, 'frp_unavailable', 'could not allocate a visitor port');
      // Keep the port the node already had, so a re-enroll leaves the generated frpc config
      // unchanged and the running visitor connection survives.
      if (reenroll && existing.visitorPort) visitorPort = existing.visitorPort;
      downlinkUrl = 'http://127.0.0.1:' + visitorPort;
    } else if (!downlinkUrl) {
      throw new LinkError(409, 'downlink_url_required', 'hub frp is disabled; pass downlinkUrl in the enroll request');
    }
    const provider = body.provider?.serverName
      ? { serverName: String(body.provider.serverName), secretKey: String(body.provider.secretKey) }
      : null;
    const autoApprove = cfg.enrollment.autoApprove === true;
    const record = {
      name,
      nodeId: body.nodeId ? String(body.nodeId) : null,
      softwareVersion: body.softwareVersion ? String(body.softwareVersion) : null,
      url: downlinkUrl,
      token: body.downlinkToken,
      provider,
      visitorPort,
      status: autoApprove ? 'active' : 'pending',
      enrolledAt: existing?.enrolledAt ?? nowIso(),
      enrolledBy: token.label,
      lastHeartbeatAt: null
    };
    await store.upsertNode(record);
    await store.recordEnrollUse(token.id);
    deferFrpSync('enrollment');
    if (!autoApprove) {
      await audit({ event: 'hub_enroll_pending', node: name, by: token.label, ip: auth.ip });
      return { pending: true, node: { name, status: 'pending' } };
    }
    const uplink = createHubToken(cfg, 'node:' + name, { role: 'peer', peer: name });
    if (saveConfig) await saveConfig(cfg);
    await audit({ event: 'hub_enroll', node: name, visitorPort, by: token.label, ip: auth.ip });
    log.info('dsh-link hub: enrolled node ' + name + (visitorPort ? ' (visitor port ' + visitorPort + ')' : ''));
    return {
      pending: false,
      reenrolled: reenroll,
      node: { name, status: 'active', visitorPort, downlinkUrl, enrolledAt: record.enrolledAt },
      hub: { name: cfg.name, url: cfg.publicUrl ?? localUrl(cfg), version: DSHLINK_VERSION },
      frp: cfg.frp?.enabled ? {
        serverAddr: cfg.frp.serverAddr ?? null,
        serverPort: cfg.frp.serverPort ?? 7000,
        serverName: cfg.frp.provider?.name ?? 'dshlink-hub',
        secretKey: cfg.frp.provider?.secretKey ?? null,
        visitorPort
      } : null,
      uplinkToken: uplink.token,
      uplink: { tokenId: uplink.id, label: uplink.label, role: uplink.role, peer: uplink.peer },
      enrollment: { autoApprove: true, enrolledAt: record.enrolledAt }
    };
  }

  // --------------------------------------------------------- running sessions ---
  async function refreshRunningFor(record) {
    try {
      const client = clientForNode(record);
      const pending = await client.dshCall({ method: 'sessions.list', params: {}, waitSeconds: 0 });
      const commandId = pending?.commandId;
      if (!commandId) throw new Error('the node did not queue a sessions.list command');
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const result = await client.dshCallResult(commandId);
        if (result?.status === 'done') {
          const sessions = Array.isArray(result.result?.sessions) ? result.result.sessions : [];
          const rows = sessions.map((s) => ({
            sessionId: s.sessionId,
            workspaceId: s.workspaceId ?? null,
            title: s.title ?? null,
            updatedAt: s.updatedAt ?? null,
            running: s.running === true
          }));
          await store.rememberRunning(record.name, { status: 'ok', sessions: rows, commandId });
          return rows;
        }
        if (result?.status === 'error' || result?.status === 'failed') throw new Error(result.error ?? 'command failed');
      }
      throw new Error('timed out waiting for sessions.list');
    } catch (err) {
      await store.rememberRunning(record.name, { status: 'unknown', error: String(err?.message ?? err).slice(0, 200), sessions: [] });
      return [];
    }
  }

  async function runningSessions() {
    const nodes = await activeNodes();
    const cache = await store.runningCache();
    if (!runningRunningRefresh) {
      runningRunningRefresh = (async () => {
        for (const node of nodes.filter((n) => nodeOnline(n, cfg))) {
          const cached = cache[node.name];
          const age = cached?.at ? Date.now() - Date.parse(cached.at) : Infinity;
          if (age < 25_000) continue;
          await refreshRunningFor(node);
        }
      })().finally(() => { runningRunningRefresh = null; });
    }
    await Promise.race([runningRunningRefresh, new Promise((resolve) => setTimeout(resolve, 3500))]);
    const after = await store.runningCache();
    return {
      hub: cfg.name,
      count: nodes.length,
      nodes: nodes.map((node) => {
        const cached = after[node.name];
        const sessions = cached?.payload?.sessions ?? [];
        return {
          name: node.name,
          online: nodeOnline(node, cfg),
          status: cached?.payload?.status ?? 'unknown',
          updatedAt: cached?.at ?? null,
          running: sessions.filter((s) => s.running === true).length,
          sessions
        };
      })
    };
  }
  // ------------------------------------------------------------- routing ---
  add('GET', '/healthz', async (ctx) => {
    sendJson(ctx.res, 200, { ok: true, name: cfg.name, role: 'hub', version: DSHLINK_VERSION });
  }, { auth: false });

  add('GET', API_PREFIX + '/info', async (ctx) => {
    const nodes = await activeNodes();
    const queued = await store.pendingOutbox();
    sendJson(ctx.res, 200, hubPublicInfo(cfg, {
      nodes: nodes.map((node) => nodeView(node, cfg)),
      nodesOnline: nodes.filter((n) => nodeOnline(n, cfg)).length,
      queued: queued.length,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    }));
  }, { roles: [...ALL_ROLES, 'enroll'] });

  add('GET', API_PREFIX + '/network/nodes', async (ctx) => {
    const nodes = await activeNodes();
    const views = nodes.map((node) => nodeView(node, cfg));
    const self = {
      name: cfg.name,
      nodeId: cfg.nodeId,
      kind: 'hub',
      role: 'hub',
      software: 'dsh-link-hub',
      softwareVersion: DSHLINK_VERSION,
      url: cfg.publicUrl ?? localUrl(cfg),
      reachable: true,
      self: true,
      dsh: { enabled: true, workspaces: true, transcripts: true },
      directPeers: nodes.map((n) => n.name),
      via: []
    };
    sendJson(ctx.res, 200, {
      self,
      nodes: [self, ...views],
      count: nodes.length + 1,
      total: nodes.length + 1,
      depth: 1,
      partial: false,
      truncated: false,
      errors: [],
      scannedAt: nowIso()
    });
  }, { roles: DSH_ROLES });

  add('GET', API_PREFIX + '/hub/status', async (ctx) => {
    const nodes = await store.listNodes();
    const counts = await store.counts();
    sendJson(ctx.res, 200, {
      hub: hubPublicInfo(cfg),
      frp: frp ? await frp.status(nodes) : { enabled: false, running: false, reason: 'disabled' },
      counts,
      nodes: nodes.map((node) => nodeView(node, cfg)),
      enrollment: cfg.enrollment,
      files: cfg.files,
      limits: cfg.limits,
      lastFlushAt,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      now: nowIso()
    });
  }, { roles: ['admin', 'device'] });

  add('GET', API_PREFIX + '/hub/nodes', async (ctx) => {
    const nodes = await store.listNodes();
    sendJson(ctx.res, 200, { count: nodes.length, nodes: nodes.map((node) => nodeView(node, cfg)) });
  }, { roles: ['admin', 'device'] });

  add('POST', API_PREFIX + '/hub/nodes/:name/approve', async (ctx) => {
    const name = ctx.params.name;
    const record = await nodeOrThrow(name);
    if (record.status !== 'pending') throw conflict('node_not_pending', 'node ' + name + ' is not pending approval');
    let visitorPort = record.visitorPort ?? null;
    let url = record.url ?? null;
    if (cfg.frp?.enabled && frp) {
      visitorPort = await frp.allocateVisitorPort(await activeNodes());
      url = 'http://127.0.0.1:' + visitorPort;
    } else if (!url) {
      throw new LinkError(409, 'downlink_url_required', 'hub frp is disabled; pass downlinkUrl before approving');
    }
    const updated = { ...record, status: 'active', visitorPort, url, enrolledAt: record.enrolledAt ?? nowIso() };
    await store.upsertNode(updated);
    deferFrpSync('approval');
    const uplink = createHubToken(cfg, 'node:' + name, { role: 'peer', peer: name });
    if (saveConfig) await saveConfig(cfg);
    await audit({ event: 'hub_node_approved', node: name, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, 200, {
      node: nodeView(updated, cfg),
      uplinkToken: uplink.token,
      uplink: { tokenId: uplink.id, role: uplink.role, peer: uplink.peer },
      frp: cfg.frp?.enabled ? {
        serverAddr: cfg.frp.serverAddr ?? null,
        serverPort: cfg.frp.serverPort ?? 7000,
        serverName: cfg.frp.provider?.name ?? 'dshlink-hub',
        secretKey: cfg.frp.provider?.secretKey ?? null,
        visitorPort
      } : null
    });
  }, { roles: ['admin'] });

  add('DELETE', API_PREFIX + '/hub/nodes/:name', async (ctx) => {
    const name = ctx.params.name;
    const record = await nodeOrThrow(name);
    await store.removeNode(name);
    deferFrpSync('removal');
    await audit({ event: 'hub_node_removed', node: name, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, 200, { removed: true, name, hadStatus: record.status ?? null });
  }, { roles: ['admin'] });

  add('GET', API_PREFIX + '/hub/outbox', async (ctx) => {
    const limit = Math.min(500, Math.max(1, toInt(ctx.url.searchParams.get('limit'), 100)));
    const result = await store.listOutbox({ limit, pendingOnly: ctx.url.searchParams.get('pending') === '1' });
    const messages = result.messages ?? [];
    sendJson(ctx.res, 200, {
      count: messages.length,
      total: result.total ?? messages.length,
      messages: messages.map((m) => ({ id: m.id, to: m.to, from: m.from?.name ?? null, thread: m.thread, subject: m.subject, ts: m.ts, delivery: m.delivery ?? null }))
    });
  }, { roles: ['admin'] });

  add('POST', API_PREFIX + '/hub/enroll', async (ctx) => {
    const body = await readJson(ctx.req, 256 * 1024);
    const result = await enroll(body, ctx.auth);
    sendJson(ctx.res, result.pending ? 202 : 200, result);
  }, { roles: ENROLL_ROLES });

  add('POST', API_PREFIX + '/hub/heartbeat', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024);
    const auth = ctx.auth;
    const name = String(body.name ?? auth.token?.peer ?? '').trim();
    const record = await store.getNode(name);
    if (!record) throw notFound('unknown node: ' + name);
    if (auth.token?.role === 'peer' && auth.token.peer && auth.token.peer !== name) {
      throw forbidden('a peer token may only report for its own node');
    }
    const updated = {
      ...record,
      status: record.status === 'pending' ? 'pending' : 'active',
      nodeId: body.nodeId ? String(body.nodeId) : record.nodeId,
      softwareVersion: body.softwareVersion ? String(body.softwareVersion) : record.softwareVersion,
      url: body.downlinkUrl ? String(body.downlinkUrl).replace(/\/+$/, '') : record.url,
      lastHeartbeatAt: nowIso(),
      pendingLocal: Number(body.pendingLocal ?? 0) || 0
    };
    await store.upsertNode(updated);
    const flushed = await flushPending();
    sendJson(ctx.res, 200, {
      ok: true,
      at: updated.lastHeartbeatAt,
      hub: { name: cfg.name, url: cfg.publicUrl ?? localUrl(cfg), version: DSHLINK_VERSION },
      node: nodeView(updated, cfg),
      queued: (await pendingFor(name)).length,
      defaultNode: cfg.defaultNode ?? null,
      flushed
    });
  }, { roles: ['peer', 'admin'] });

  add('POST', API_PREFIX + '/messages', async (ctx) => {
    const body = await readJson(ctx.req, cfg.limits.maxMessageBytes + 65536);
    if (!body?.id || typeof body.id !== 'string') throw badRequest('id is required');
    if (!body.to || typeof body.to !== 'string') throw badRequest('to is required');
    if (!body.from || typeof body.from !== 'object' || !body.from.name) throw badRequest('from.name is required');
    const token = ctx.auth.token;
    if (token.role === 'peer' && token.peer && body.from.name !== token.peer) {
      throw new LinkError(403, 'identity_mismatch', 'a peer token may only send as its own node (' + token.peer + ')');
    }
    const sender = await store.getNode(body.from.name);
    if (!sender) throw new LinkError(404, 'unknown_target', 'sender ' + body.from.name + ' is not enrolled on this hub');
    const target = await store.getNode(body.to);
    if (!target) throw new LinkError(404, 'unknown_target', 'target node ' + body.to + ' is not enrolled on this hub');
    const duplicate = await store.getOutbox(body.id);
    if (duplicate) { sendJson(ctx.res, 202, { accepted: true, duplicate: true, id: body.id, to: body.to, queued: true }); return; }
    const pending = await pendingFor(body.to);
    if (pending.length >= Number(cfg.maxPendingPerTarget ?? 1000)) throw new LinkError(429, 'queue_full', 'too many pending messages for ' + body.to);
    const record = { ...body, hubReceivedAt: nowIso() };
    await store.appendOutbox(record);
    await audit({ event: 'hub_message_accepted', id: record.id, from: record.from.name, to: record.to, thread: record.thread ?? null, targetSession: record.targetSession ?? null, by: token.label, ip: ctx.auth.ip });
    const delivery = await deliverRecord(record);
    sendJson(ctx.res, 202, { accepted: true, id: record.id, to: record.to, queued: delivery.state !== 'delivered', delivery });
  }, { roles: ['peer', 'admin'] });
  // --------------------------------------------------------- DSH proxies ---
  const dshGet = (pathname, call) => {
    add('GET', API_PREFIX + '/dsh/' + pathname, async (ctx) => {
      const record = await pickNode(ctx.url.searchParams.get('peer'));
      const client = clientForNode(record);
      const result = await call(client, ctx.url);
      await audit({ event: 'hub_dsh_view', path: pathname, peer: record.name, by: ctx.auth.token?.label ?? null });
      sendJson(ctx.res, 200, { ...result, peer: record.name });
    }, { roles: DSH_ROLES });
  };

  dshGet('workspaces', async (client) => client.dshWorkspaces());
  dshGet('capabilities', async (client) => client.dshCapabilities());
  dshGet('sessions', async (client, url) => {
    const params = {};
    for (const key of ['workspace', 'includeArchived', 'query', 'limit']) {
      if (url.searchParams.has(key)) params[key] = url.searchParams.get(key);
    }
    return client.dshSessions(params);
  });
  dshGet('sessions/:id', async (client, url) => client.dshSession(decodeURIComponent(url.pathname.split('/').pop())));
  dshGet('sessions/:id/transcript', async (client, url) => {
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts[parts.length - 2]);
    const params = {};
    for (const key of ['sinceSeq', 'limit', 'offset', 'tail']) {
      if (url.searchParams.has(key)) params[key] = url.searchParams.get(key);
    }
    return client.dshTranscript(id, params);
  });

  add('POST', API_PREFIX + '/dsh/call', async (ctx) => {
    const body = await readJson(ctx.req, 1024 * 1024);
    const method = String(body.method ?? '').trim();
    if (!method) throw badRequest('method is required');
    const record = await pickNode(body.peer);
    const client = clientForNode(record);
    const waitSeconds = Math.min(180, Math.max(0, toInt(body.waitSeconds, 0)));
    const result = await client.dshCall({ method, params: body.params ?? {}, waitSeconds });
    if (result?.commandId) await store.rememberCommand(result.commandId, record.name);
    await audit({ event: 'hub_dsh_call', peer: record.name, method, commandId: result?.commandId ?? null, by: ctx.auth.token?.label ?? null, role: ctx.auth.token?.role ?? null });
    sendJson(ctx.res, 200, { ...result, peer: record.name });
  }, { roles: DSH_ROLES });

  add('GET', API_PREFIX + '/dsh/call/:id', async (ctx) => {
    const id = ctx.params.id;
    const peer = ctx.url.searchParams.get('peer') ?? await store.commandPeer(id);
    const record = await pickNode(peer);
    const client = clientForNode(record);
    const result = await client.dshCallResult(id);
    sendJson(ctx.res, 200, { ...result, peer: record.name });
  }, { roles: DSH_ROLES });

  add('GET', API_PREFIX + '/hub/sessions/running', async (ctx) => {
    const result = await runningSessions();
    sendJson(ctx.res, 200, result);
  }, { roles: DSH_ROLES });

  // --------------------------------------------------------- file proxy ---
  function nodeUrl(record, pathname, search) {
    const base = String(record.url ?? '').replace(/\/+$/, '');
    return base + pathname + (search || '');
  }

  function forwardHeaders(req) {
    const headers = {};
    const token = String(req.headers.authorization ?? '');
    if (token) headers.authorization = token;
    return headers;
  }

  add('GET', API_PREFIX + '/files', async (ctx) => {
    const record = await pickNode(ctx.url.searchParams.get('peer'));
    const client = clientForNode(record);
    const params = {};
    for (const key of ['root', 'path']) if (ctx.url.searchParams.has(key)) params[key] = ctx.url.searchParams.get(key);
    const result = await client.listFiles(params);
    sendJson(ctx.res, 200, { ...result, peer: record.name });
  }, { roles: FILE_ROLES });

  add('GET', API_PREFIX + '/files/stat', async (ctx) => {
    const record = await pickNode(ctx.url.searchParams.get('peer'));
    const client = clientForNode(record);
    const params = {};
    for (const key of ['root', 'path']) if (ctx.url.searchParams.has(key)) params[key] = ctx.url.searchParams.get(key);
    const result = await client.statFile(params);
    sendJson(ctx.res, 200, { ...result, peer: record.name });
  }, { roles: FILE_ROLES });

  add('GET', API_PREFIX + '/files/hash', async (ctx) => {
    const record = await pickNode(ctx.url.searchParams.get('peer'));
    const client = clientForNode(record);
    const params = {};
    for (const key of ['root', 'path']) if (ctx.url.searchParams.has(key)) params[key] = ctx.url.searchParams.get(key);
    const result = await client.hashFile(params);
    sendJson(ctx.res, 200, { ...result, peer: record.name });
  }, { roles: FILE_ROLES });

  add('GET', API_PREFIX + '/files/download', async (ctx) => {
    const record = await pickNode(ctx.url.searchParams.get('peer'));
    const target = nodeUrl(record, API_PREFIX + '/files/download', ctx.url.search.slice(ctx.url.search.indexOf('?') >= 0 ? ctx.url.search.indexOf('?') : 0));
    const headers = { authorization: 'Bearer ' + record.token };
    const range = ctx.req.headers.range;
    if (range) headers.range = String(range);
    const upstream = await fetch(target, { headers });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      throw new LinkError(upstream.status, 'upstream_error', text.slice(0, 300) || 'download failed');
    }
    const outHeaders = {};
    for (const key of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'content-range']) {
      const value = upstream.headers.get(key);
      if (value) outHeaders[key] = value;
    }
    ctx.res.writeHead(upstream.status, outHeaders);
    await audit({ event: 'hub_file_download', peer: record.name, path: ctx.url.searchParams.get('path') ?? null, by: ctx.auth.token?.label ?? null });
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(ctx.res); else ctx.res.end();
  }, { roles: FILE_ROLES });

  add('POST', API_PREFIX + '/files/upload', async (ctx) => {
    const record = await pickNode(ctx.url.searchParams.get('peer'));
    const declared = toInt(ctx.req.headers['content-length'], -1);
    if (declared > Number(cfg.files.maxBytes ?? 0)) throw new LinkError(413, 'too_large', 'upload exceeds ' + cfg.files.maxBytes + ' bytes');
    if (declared < 0) throw badRequest('content-length is required for uploads');
    const search = ctx.url.search.length ? '?' + ctx.url.searchParams.toString() : '';
    const target = nodeUrl(record, API_PREFIX + '/files/upload', search);
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + record.token, 'content-type': String(ctx.req.headers['content-type'] ?? 'application/octet-stream') },
      body: ctx.req,
      duplex: 'half'
    });
    const text = await upstream.text().catch(() => '');
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (err) { payload = { error: { code: 'upstream_error', message: text.slice(0, 300) } }; }
    await audit({ event: 'hub_file_upload', peer: record.name, path: ctx.url.searchParams.get('path') ?? null, bytes: declared, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, upstream.status, { ...payload, peer: record.name });
  }, { roles: FILE_ROLES });

  // --------------------------------------------------------- web console ---
  // The console page is intentionally unauthenticated: it is a login page with no hub data, and
  // every API it calls still requires an admin token (the hub never trusts loopback addresses).
  add('GET', '/', async (ctx) => {
    ctx.res.writeHead(302, { location: '/ui', 'cache-control': 'no-store' });
    ctx.res.end();
  }, { auth: false });

  add('GET', '/ui', async (ctx) => {
    ctx.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff'
    });
    ctx.res.end(hubUiHtml({ version: DSHLINK_VERSION }));
  }, { auth: false });

  add('GET', API_PREFIX + '/hub/config', async (ctx) => {
    sendJson(ctx.res, 200, {
      hub: hubPublicInfo(cfg),
      settings: settingsView(),
      console: { url: consoleUrl() }
    });
  }, { roles: ['admin'] });

  add('PATCH', API_PREFIX + '/hub/settings', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024);
    const applied = await applySettings(body);
    await audit({ event: 'hub_settings_updated', applied, by: ctx.auth.token?.label ?? null, ip: ctx.auth.ip });
    log.info('dsh-link hub: settings updated (' + applied.join(', ') + ')');
    sendJson(ctx.res, 200, { applied, hub: hubPublicInfo(cfg), settings: settingsView(), console: { url: consoleUrl() } });
  }, { roles: ['admin'] });

  add('GET', API_PREFIX + '/hub/tokens', async (ctx) => {
    const tokens = await tokenViews();
    sendJson(ctx.res, 200, { count: tokens.length, tokens });
  }, { roles: ['admin'] });

  add('POST', API_PREFIX + '/hub/tokens', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024);
    const role = String(body.role ?? 'enroll').trim();
    if (!['enroll', 'admin', 'device', 'peer'].includes(role)) {
      throw badRequest('role must be one of enroll, admin, device, peer');
    }
    const peer = role === 'peer' ? String(body.peer ?? '').trim() : null;
    if (role === 'peer' && !peer) throw badRequest('a token with role "peer" needs a peer (node name)');
    const label = String(body.label ?? '').trim().slice(0, 64) || ('ui-' + role);
    const ttlRaw = body.ttlHours;
    const ttlHours = ttlRaw === undefined || ttlRaw === null || ttlRaw === ''
      ? (role === 'enroll' ? Number(cfg.enrollment.tokenTtlHours ?? 2) : 0)
      : intSetting(ttlRaw, 'ttlHours', 0, 24 * 365);
    const expiresAt = ttlHours > 0 ? new Date(Date.now() + ttlHours * 3_600_000).toISOString() : undefined;
    const maxRaw = body.maxUses;
    const maxUses = maxRaw === undefined || maxRaw === null || maxRaw === ''
      ? (role === 'enroll' ? Number(cfg.enrollment.maxUsesPerToken ?? 1) : null)
      : intSetting(maxRaw, 'maxUses', 1, 10_000);
    if (cfg.auth.tokens.length >= 200) throw conflict('too_many_tokens', 'the hub already has 200 tokens; remove one first');
    const created = createHubToken(cfg, label, { role, peer, expiresAt, maxUses });
    const entry = cfg.auth.tokens.find((token) => token.id === created.id);
    if (saveConfig) await saveConfig(cfg);
    await audit({
      event: 'hub_token_created', id: created.id, role: created.role, label: created.label,
      peer: created.peer ?? null, maxUses: created.maxUses, expiresAt: created.expiresAt ?? null,
      by: ctx.auth.token?.label ?? null, ip: ctx.auth.ip
    });
    sendJson(ctx.res, 201, {
      token: created.token,
      entry: {
        id: created.id,
        label: created.label,
        role: created.role,
        peer: created.peer ?? null,
        expiresAt: created.expiresAt ?? null,
        createdAt: entry?.createdAt ?? nowIso(),
        maxUses: created.maxUses ?? null,
        uses: 0,
        note: null
      }
    });
  }, { roles: ['admin'] });

  add('DELETE', API_PREFIX + '/hub/tokens/:id', async (ctx) => {
    const id = ctx.params.id;
    const index = (cfg.auth.tokens ?? []).findIndex((token) => token.id === id);
    if (index < 0) throw notFound('no hub token ' + id);
    const [removed] = cfg.auth.tokens.splice(index, 1);
    const self = ctx.auth.token?.id === id;
    if (saveConfig) await saveConfig(cfg);
    await audit({
      event: 'hub_token_removed', id, role: removed.role, label: removed.label,
      self, by: ctx.auth.token?.label ?? null, ip: ctx.auth.ip
    });
    sendJson(ctx.res, 200, { removed: id, self });
  }, { roles: ['admin'] });

  add('POST', API_PREFIX + '/hub/flush', async (ctx) => {
    const result = await flushPending({ force: true });
    await audit({ event: 'hub_flush', ...result, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, 200, result);
  }, { roles: ['admin'] });

  add('POST', API_PREFIX + '/hub/outbox/:id/retry', async (ctx) => {
    const id = ctx.params.id;
    const record = await store.getOutbox(id);
    if (!record) throw notFound('no outbox message ' + id);
    await store.setDelivery(id, { state: 'pending', attempts: 0, error: null, nextAttemptAt: null });
    const delivery = await deliverRecord(record);
    await audit({ event: 'hub_outbox_retried', id, state: delivery.state, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, 200, { id, delivery });
  }, { roles: ['admin'] });

  add('DELETE', API_PREFIX + '/hub/outbox/:id', async (ctx) => {
    const id = ctx.params.id;
    const record = await store.getOutbox(id);
    if (!record) throw notFound('no outbox message ' + id);
    const dropped = { state: 'dropped', reason: 'dropped from hub console', attempts: Number(record.delivery?.attempts ?? 0), droppedAt: nowIso() };
    await store.setDelivery(id, dropped);
    await audit({ event: 'hub_outbox_dropped', id, to: record.to ?? null, by: ctx.auth.token?.label ?? null });
    sendJson(ctx.res, 200, { id, delivery: dropped });
  }, { roles: ['admin'] });

  add('GET', API_PREFIX + '/hub/sessions/running', async (ctx) => {
    sendJson(ctx.res, 200, await runningSessions());
  }, { roles: ['admin', 'device'] });

  add('GET', API_PREFIX + '/audit', async (ctx) => {
    const limit = Math.min(500, Math.max(1, toInt(ctx.url.searchParams.get('limit'), 100)));
    const entries = await store.recentAudit(limit);
    sendJson(ctx.res, 200, { count: entries.length, entries });
  }, { roles: ['admin'] });
  // -------------------------------------------------------------- server ---
  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://hub.invalid');
    } catch (err) {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'malformed request URL' } });
      return;
    }
    const route = routes.find((candidate) => candidate.method === req.method && candidate.re.test(url.pathname));
    if (!route) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'no route for ' + req.method + ' ' + url.pathname } });
      return;
    }
    let auth = { ok: true, via: 'open', token: null, ip: clientIp(req) };
    try {
      if (route.auth) {
        auth = authorize(req);
        if (!auth.ok) {
          if (auth.throttled) throw new LinkError(429, 'rate_limited', 'too many failed authentication attempts');
          throw unauthorized('missing or invalid token');
        }
      }
      const role = roleOf(auth);
      if (route.roles && !route.roles.includes(role)) {
        throw new LinkError(403, 'role_forbidden', 'this route is not available to role "' + role + '"');
      }
      const match = route.re.exec(url.pathname);
      const params = {};
      route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1] ?? ''); });
      await route.handler({ req, res, url, auth, params });
      if (!res.headersSent) sendJson(res, 204, {});
    } catch (err) {
      sendError(res, err);
    }
  }

  async function listen({ port = cfg.port, bind = cfg.bind } = {}) {
    await mergeStaticNodes();
    const nodes = await activeNodes();
    if (frp) {
      try {
        await frp.start(nodes);
        log.info('dsh-link hub: frp provider ' + (frp.status ? cfg.frp.provider.name : '') + ' -> ' + localUrl(cfg));
      } catch (err) {
        log.warn('dsh-link hub: frp did not start: ' + (err?.message ?? String(err)));
      }
    }
    httpServer = http.createServer((req, res) => { void handle(req, res); });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, bind, () => { httpServer.off('error', reject); resolve(); });
    });
    flushTimer = setInterval(() => { void flushPending().catch((err) => log.warn('hub flush failed:', err?.message ?? String(err))); }, Math.max(1000, Number(cfg.retrySeconds ?? 5) * 1000));
    flushTimer.unref?.();
    const address = httpServer.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    log.info('dsh-link hub: listening on http://' + bind + ':' + actualPort + ' (role hub)');
    return { url: 'http://' + (bind === '0.0.0.0' ? '127.0.0.1' : bind) + ':' + actualPort, port: actualPort, server: httpServer };
  }

  async function close() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (frp) { try { await frp.stop(); } catch (err) { log.warn('hub frp stop failed:', err?.message ?? String(err)); } }
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(() => resolve()));
      httpServer = null;
    }
  }

  async function status() {
    const nodes = await store.listNodes();
    const counts = await store.counts();
    return {
      hub: hubPublicInfo(cfg),
      frp: frp ? await frp.status(nodes) : { enabled: false, running: false, reason: 'disabled' },
      counts,
      nodes,
      enrollment: cfg.enrollment,
      files: cfg.files,
      lastFlushAt,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000)
    };
  }

  return {
    cfg,
    store,
    log,
    frp,
    listen,
    close,
    handle,
    status,
    flushPending,
    deliverRecord,
    enroll,
    runningSessions,
    routes
  };
}
