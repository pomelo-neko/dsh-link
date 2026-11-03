// dsh-link: inbound HTTP API. Peer-to-peer surface for messages and files.
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { API_PREFIX, DSHLINK_VERSION, LinkError, badRequest, notFound, nowIso, toInt, unauthorized } from './util.mjs';
import { publicInfo, verifyToken } from './config.mjs';
import { MCP_DEFAULT_PROTOCOL, MCP_PROTOCOL_VERSIONS, handleMcpMessage } from './mcp.mjs';

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const OPEN_PATHS = new Set(['/healthz']);

// Role-based authorisation (v0.5.0). A route without an explicit role list is admin-only, so a
// newly added route cannot accidentally become world-readable. Legacy tokens have no role and
// are treated as admin by verifyToken(); loopback/open (trustLocalhost) callers are admin too.
const ALL_ROLES = ['admin', 'bridge', 'peer', 'device'];
const READ_ROLES = ['admin', 'bridge', 'peer'];
const DSH_ROLES = ['admin', 'peer', 'device'];
const BRIDGE_ROLES = ['admin', 'bridge'];

function roleOf(auth) {
  if (auth?.token?.role) return auth.token.role;
  return auth?.via === 'localhost' || auth?.via === 'open' ? 'admin' : 'anonymous';
}

function routeRoleTable() {
  return new Map([
    ['GET /healthz', null],
    ['GET ' + API_PREFIX + '/info', ALL_ROLES],
    ['GET ' + API_PREFIX + '/peers', ['admin']],
    ['GET ' + API_PREFIX + '/status', ['admin']],
    ['POST ' + API_PREFIX + '/messages', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/messages', READ_ROLES],
    ['GET ' + API_PREFIX + '/messages/:id', READ_ROLES],
    ['POST ' + API_PREFIX + '/messages/read', READ_ROLES],
    ['POST ' + API_PREFIX + '/messages/:id/read', READ_ROLES],
    ['GET ' + API_PREFIX + '/outbox', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/files', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/files/stat', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/files/hash', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/files/download', ['admin', 'peer']],
    ['POST ' + API_PREFIX + '/files/upload', ['admin', 'peer']],
    ['GET ' + API_PREFIX + '/audit', ['admin']],
    ['GET ' + API_PREFIX + '/dsh/workspaces', DSH_ROLES],
    ['GET ' + API_PREFIX + '/dsh/sessions', DSH_ROLES],
    ['GET ' + API_PREFIX + '/dsh/sessions/:id', DSH_ROLES],
    ['GET ' + API_PREFIX + '/dsh/sessions/:id/transcript', DSH_ROLES],
    ['GET ' + API_PREFIX + '/dsh/capabilities', DSH_ROLES],
    ['POST ' + API_PREFIX + '/dsh/call', DSH_ROLES],
    ['GET ' + API_PREFIX + '/dsh/call/:id', DSH_ROLES],
    ['GET ' + API_PREFIX + '/bridge/status', BRIDGE_ROLES],
    ['GET ' + API_PREFIX + '/bridge/commands', BRIDGE_ROLES],
    ['POST ' + API_PREFIX + '/bridge/commands/:id/result', BRIDGE_ROLES],
    ['POST ' + API_PREFIX + '/bridge/heartbeat', BRIDGE_ROLES],
    ['POST ' + API_PREFIX + '/bridge/bind', BRIDGE_ROLES],
    ['GET ' + API_PREFIX + '/bridge/bind', BRIDGE_ROLES],
    ['POST /mcp', ['admin']],
    ['GET /mcp', ['admin']],
    ['DELETE /mcp', ['admin']]
  ]);
}
const ROUTE_ROLES = routeRoleTable();

function compileRoute(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) { names.push(segment.slice(1)); return '([^/]+)'; }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${source}/?$`), names };
}

export function createLinkServer({ cfg, store, roots, ops, logger, refresh, runtime }) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const routes = [];
  const authFailures = new Map();
  const requestWindows = new Map();
  const sessions = new Set();

  const add = (method, pattern, handler, opts = {}) => {
    const { re, names } = compileRoute(pattern);
    const key = method + ' ' + pattern;
    const roles = opts.auth === false ? null : (opts.roles ?? ROUTE_ROLES.get(key) ?? ['admin']);
    routes.push({ method, re, names, handler, auth: opts.auth !== false, audit: opts.audit ?? null, roles });
  };

  function clientIp(req) {
    return (req.socket.remoteAddress ?? '').replace('::ffff:', '');
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
      const match = verifyToken(cfg, token);
      if (match) return { ok: true, via: 'token', token: match, ip };
    }
    if (cfg.auth.trustLocalhost && (LOCAL_ADDRESSES.has(req.socket.remoteAddress ?? '') || LOCAL_ADDRESSES.has(ip))) {
      return { ok: true, via: 'localhost', token: null, ip };
    }
    const now = Date.now();
    const record = authFailures.get(ip) ?? { count: 0, firstAt: now };
    if (now - record.firstAt > 60_000) { record.count = 0; record.firstAt = now; }
    record.count += 1;
    authFailures.set(ip, record);
    return { ok: false, via: 'none', token: null, ip, failures: record.count, throttled: record.count > 20 };
  }

  async function readBody(req, maxBytes) {
    const declared = toInt(req.headers['content-length'], -1);
    if (declared > maxBytes) throw new LinkError(413, 'payload_too_large', `body is ${declared} bytes; limit is ${maxBytes}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw new LinkError(413, 'payload_too_large', `body exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req, maxBytes = cfg.limits.maxBodyBytes) {
    const buffer = await readBody(req, maxBytes);
    if (!buffer.length) return {};
    try {
      const parsed = JSON.parse(buffer.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw badRequest('a JSON object body is required');
      return parsed;
    } catch (err) {
      if (err instanceof LinkError) throw err;
      throw badRequest('body is not valid JSON');
    }
  }

  function sendJson(res, status, payload, headers = {}) {
    const body = Buffer.from(JSON.stringify(payload, null, status >= 400 ? 2 : 0) + '\n', 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...headers });
    res.end(body);
  }

  function sendError(res, err) {
    const status = err instanceof LinkError ? err.status : 500;
    const code = err instanceof LinkError ? err.code : 'internal_error';
    if (status >= 500) log.error('request failed:', err?.stack ?? String(err));
    const headers = {};
    const retryAfter = Number(err?.details?.retryAfterSeconds);
    if (status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) headers['retry-after'] = String(Math.ceil(retryAfter));
    sendJson(res, status === 2 ? 400 : status, { error: { code, message: err?.message ?? String(err), details: err?.details ?? undefined } }, headers);
  }

  const audit = (entry) => { store.audit({ ...entry, ts: nowIso() }).catch(() => {}); };

  // A peer token is bound to exactly one peer name by config; it may only present messages as
  // that peer and only read that peer's traffic. A peer token without a binding can never be
  // created by createInboundToken(), but hand-edited configs are rejected here too.
  function boundPeer(auth) {
    if (roleOf(auth) !== 'peer') return null;
    const peer = auth?.token?.peer;
    if (!peer) throw new LinkError(403, 'peer_unbound', 'this peer token is not bound to a peer identity');
    return peer;
  }

  function rateLimit(auth) {
    const limit = Number(cfg.limits.maxRequestsPerMinute ?? 0);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const window = 60_000;
    const now = Date.now();
    const key = auth?.token?.id ? 'token:' + auth.token.id : 'ip:' + (auth?.ip ?? 'unknown');
    let record = requestWindows.get(key);
    if (!record || now - record.start >= window) {
      record = { start: now, count: 0 };
      requestWindows.set(key, record);
    }
    record.count += 1;
    if (record.count > limit) {
      throw new LinkError(429, 'too_many_requests', 'request rate limit exceeded; retry later', {
        limit,
        windowSeconds: 60,
        retryAfterSeconds: Math.max(1, Math.ceil((window - (now - record.start)) / 1000))
      });
    }
    if (requestWindows.size > 5000) {
      for (const [key, value] of requestWindows) if (now - value.start >= window) requestWindows.delete(key);
    }
  }

  // ---------------------------------------------------------------- routes ---
  add('GET', '/healthz', async (ctx) => {
    sendJson(ctx.res, 200, { ok: true, name: cfg.name, nodeId: cfg.nodeId, software: 'dsh-link', version: DSHLINK_VERSION, time: nowIso() });
  }, { auth: false });

  add('GET', `${API_PREFIX}/info`, async (ctx) => {
    sendJson(ctx.res, 200, { ...publicInfo(cfg), limits: { maxBodyBytes: cfg.limits.maxBodyBytes, maxMessageBytes: cfg.limits.maxMessageBytes, maxInlineAttachmentBytes: cfg.limits.maxInlineAttachmentBytes } });
  });

  add('GET', `${API_PREFIX}/peers`, async (ctx) => {
    const result = await ops.peers({ probe: ctx.url.searchParams.get('probe') === '1' });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/status`, async (ctx) => {
    const status = await ops.status({ probe: ctx.url.searchParams.get('probe') === '1' });
    sendJson(ctx.res, 200, runtime ? { ...status, runtime: runtime() } : status);
  });

  add('POST', `${API_PREFIX}/messages`, async (ctx) => {
    const record = await readJson(ctx.req, cfg.limits.maxMessageBytes);
    const peer = boundPeer(ctx.auth);
    if (peer) {
      if (!record || typeof record !== 'object') throw badRequest('a message record is required');
      const claimed = String(record.from?.name ?? '').trim();
      if (claimed && claimed !== peer) throw new LinkError(403, 'identity_mismatch', `this token belongs to peer "${peer}", not "${claimed}"`);
      record.from = { ...(record.from ?? {}), name: peer };
      const to = String(record.to ?? '');
      const local = ops.isSelf(to) || to === '*' || to === '';
      if (!local && roleOf(ctx.auth) !== 'admin') {
        throw new LinkError(403, 'relay_not_allowed', 'only an admin token may relay a message to a third node');
      }
    }
    const result = await ops.acceptMessage(record);
    audit({ event: 'message_received', id: result.id, from: record.from?.name, to: record.to, stored: result.stored, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost', role: roleOf(ctx.auth), duplicate: !!result.duplicate });
    sendJson(ctx.res, 202, result);
  });

  add('GET', `${API_PREFIX}/messages`, async (ctx) => {
    const q = ctx.url.searchParams;
    const bound = boundPeer(ctx.auth);
    const result = await store.list('inbox', {
      since: q.get('since') ?? undefined,
      limit: toInt(q.get('limit'), 50, { min: 1, max: 1000 }),
      unreadOnly: q.get('unread') === '1',
      thread: q.get('thread') ?? undefined,
      from: bound ?? (q.get('from') ?? undefined),
      order: q.get('order') === 'asc' ? 'asc' : 'desc'
    });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/messages/:id`, async (ctx) => {
    const message = await store.get('inbox', ctx.params.id);
    if (!message) throw notFound(`no message ${ctx.params.id}`);
    const bound = boundPeer(ctx.auth);
    if (bound && message.from?.name !== bound) throw new LinkError(403, 'not_your_message', 'this message belongs to another peer');
    sendJson(ctx.res, 200, message);
  });

  async function assertPeerMayRead(auth, ids) {
    const bound = boundPeer(auth);
    if (!bound) return;
    for (const id of ids) {
      const message = await store.get('inbox', id);
      if (message && message.from?.name !== bound) throw new LinkError(403, 'not_your_message', 'this message belongs to another peer');
    }
  }

  add('POST', `${API_PREFIX}/messages/read`, async (ctx) => {
    const body = await readJson(ctx.req, 1024 * 1024);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    await assertPeerMayRead(ctx.auth, ids);
    sendJson(ctx.res, 200, { marked: await store.markRead(ids) });
  });

  add('POST', `${API_PREFIX}/messages/:id/read`, async (ctx) => {
    await assertPeerMayRead(ctx.auth, [ctx.params.id]);
    sendJson(ctx.res, 200, { marked: await store.markRead([ctx.params.id]) });
  });

  add('GET', `${API_PREFIX}/outbox`, async (ctx) => {
    const q = ctx.url.searchParams;
    const bound = boundPeer(ctx.auth);
    const requested = q.get('to') ?? undefined;
    if (bound && requested && requested !== bound) throw new LinkError(403, 'not_your_traffic', 'a peer token may only read its own outbox');
    const to = bound ?? requested;
    const all = await store.list('outbox', {
      since: q.get('since') ?? undefined,
      limit: toInt(q.get('limit'), 200, { min: 1, max: 1000 }),
      order: q.get('order') === 'desc' ? 'desc' : 'asc'
    });
    const messages = to ? all.messages.filter((m) => m.to === to || m.to === '*') : all.messages;
    sendJson(ctx.res, 200, { ...all, count: messages.length, messages });
  });

  add('GET', `${API_PREFIX}/files`, async (ctx) => {
    const q = ctx.url.searchParams;
    const result = await roots.listDir(q.get('root') ?? undefined, q.get('path') ?? '', {
      limit: toInt(q.get('limit'), cfg.limits.maxListEntries, { min: 1, max: cfg.limits.maxListEntries })
    });
    audit({ event: 'file_list', root: result.root, path: result.path, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/files/stat`, async (ctx) => {
    const q = ctx.url.searchParams;
    sendJson(ctx.res, 200, await roots.statPath(q.get('root') ?? undefined, q.get('path') ?? ''));
  });

  add('GET', `${API_PREFIX}/files/hash`, async (ctx) => {
    const q = ctx.url.searchParams;
    sendJson(ctx.res, 200, await roots.hashFile(q.get('root') ?? undefined, q.get('path') ?? ''));
  });

  add('GET', `${API_PREFIX}/files/download`, async (ctx) => {
    const q = ctx.url.searchParams;
    const { abs, stat, displayPath, root, rel } = await roots.openRead(q.get('root') ?? undefined, q.get('path') ?? '');
    audit({ event: 'file_download', root: root.name, path: rel, size: stat.size, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${encodeURIComponent(path.basename(abs))}"`,
      'x-dshlink-path': encodeURIComponent(displayPath),
      'last-modified': stat.mtime.toUTCString()
    };
    const range = ctx.req.headers.range;
    if (typeof range === 'string') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const size = stat.size;
        let start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
        let end = match[2] === '' || match[1] === '' ? size - 1 : Number(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
          ctx.res.writeHead(416, { 'content-range': `bytes */${size}` });
          ctx.res.end();
          return;
        }
        end = Math.min(end, size - 1);
        headers['content-range'] = `bytes ${start}-${end}/${size}`;
        headers['content-length'] = String(end - start + 1);
        ctx.res.writeHead(206, headers);
        createReadStream(abs, { start, end }).pipe(ctx.res);
        return;
      }
    }
    const hash = await roots.hashFile(root.name, rel);
    headers['content-length'] = String(stat.size);
    headers['x-dshlink-sha256'] = hash.sha256;
    ctx.res.writeHead(200, headers);
    createReadStream(abs).pipe(ctx.res);
  });

  add('POST', `${API_PREFIX}/files/upload`, async (ctx) => {
    const q = ctx.url.searchParams;
    const buffer = await readBody(ctx.req, cfg.limits.maxBodyBytes);
    const result = await roots.writeFile(q.get('root') ?? undefined, q.get('path') ?? '', buffer);
    audit({ event: 'file_upload', root: result.root, path: result.path, size: result.size, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    sendJson(ctx.res, 201, result);
  });

  add('GET', `${API_PREFIX}/audit`, async (ctx) => {
    sendJson(ctx.res, 200, { entries: await store.recentAudit(toInt(ctx.url.searchParams.get('limit'), 50, { min: 1, max: 500 })) });
  });

  // ------------------------------------------- DSH view + capability channel ---
  // Every route below is off unless the node config enables it; the capability channel is
  // additionally enforced per peer inside ops (see src/capabilities.mjs).
  function requireBridge(ctx) {
    // The bridge channel used to be loopback-only. With trustLocalhost now defaulting to false,
    // the local bridge authenticates with a dedicated "bridge" token instead of relying on the
    // source address (which frp/STCP can forge by making a remote connection appear as 127.0.0.1).
    const via = ctx.auth?.via;
    const role = roleOf(ctx.auth);
    // Local callers (an in-process or same-machine bridge) and dedicated bridge tokens only.
    // An admin token is deliberately not enough: a remote admin has root through the normal
    // API, and the bridge channel should stay a this-machine control plane.
    if (via !== 'localhost' && via !== 'open' && role !== 'bridge') {
      throw new LinkError(403, 'bridge_forbidden', 'the bridge channel is only available to the local bridge or a bridge token');
    }
  }

  add('GET', `${API_PREFIX}/dsh/workspaces`, async (ctx) => {
    const result = await ops.dshWorkspaces({});
    audit({ event: 'dsh_view_workspaces', count: result.count, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/dsh/sessions`, async (ctx) => {
    const q = ctx.url.searchParams;
    const result = await ops.dshSessions({
      workspace: q.get('workspace') ?? undefined,
      includeArchived: q.get('includeArchived') === '1' || q.get('archived') === '1',
      query: q.get('query') ?? undefined,
      limit: toInt(q.get('limit'), 100, { min: 1, max: 1000 })
    });
    audit({ event: 'dsh_view_sessions', count: result.count, workspace: q.get('workspace') ?? null, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/dsh/sessions/:id`, async (ctx) => {
    sendJson(ctx.res, 200, await ops.dshSession({ sessionId: ctx.params.id }));
  });

  add('GET', `${API_PREFIX}/dsh/sessions/:id/transcript`, async (ctx) => {
    const q = ctx.url.searchParams;
    const sinceSeq = q.get('sinceSeq');
    const result = await ops.dshTranscript({
      sessionId: ctx.params.id,
      limit: toInt(q.get('limit'), 100, { min: 1, max: 1000 }),
      offset: toInt(q.get('offset'), 0, { min: 0, max: 1000000 }),
      tail: q.get('tail') === '1',
      sinceSeq: sinceSeq === null || sinceSeq === '' ? undefined : toInt(sinceSeq, 0, { min: 0 })
    });
    audit({ event: 'dsh_view_transcript', sessionId: ctx.params.id, messages: Array.isArray(result.messages) ? result.messages.length : 0, ip: ctx.auth.ip, token: ctx.auth.token?.label ?? 'localhost' });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/dsh/capabilities`, async (ctx) => {
    sendJson(ctx.res, 200, await ops.dshCapabilities({}));
  });

  add('POST', `${API_PREFIX}/dsh/call`, async (ctx) => {
    const body = await readJson(ctx.req, 1024 * 1024);
    const role = roleOf(ctx.auth);
    const origin = {
      peer: ctx.auth.token?.peer ?? ctx.auth.token?.label ?? ctx.auth.ip ?? 'unknown',
      ip: ctx.auth.ip,
      label: ctx.auth.token?.label ?? 'localhost',
      role,
      tokenId: ctx.auth.token?.id ?? null
    };
    const target = body.peer && body.peer !== cfg.name && body.peer !== 'self' ? String(body.peer) : '';
    if (target && role !== 'admin') {
      throw new LinkError(403, 'relay_not_allowed', 'only an admin token may forward a capability call to another node');
    }
    const result = target
      ? await ops.dshCall({ peer: target, method: body.method, params: body.params, waitSeconds: body.waitSeconds })
      : await ops.dshCallLocal({ method: body.method, params: body.params, waitSeconds: body.waitSeconds, origin });
    audit({ event: 'dsh_call', method: body.method, forPeer: target || null, commandId: result.commandId ?? null, status: result.status ?? null, ip: ctx.auth.ip, token: origin.label, role });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/dsh/call/:id`, async (ctx) => {
    const result = await ops.dshCallResult({ id: ctx.params.id });
    const role = roleOf(ctx.auth);
    if (role !== 'admin' && role !== 'bridge') {
      const origin = result?.origin ?? {};
      const sameToken = ctx.auth.token?.id && origin.tokenId === ctx.auth.token.id;
      const samePeer = ctx.auth.token?.peer && origin.peer === ctx.auth.token.peer;
      if (!sameToken && !samePeer) throw new LinkError(403, 'not_your_command', 'this command was issued by another client');
    }
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/bridge/status`, async (ctx) => {
    requireBridge(ctx);
    sendJson(ctx.res, 200, await ops.bridgeStatus());
  });

  add('GET', `${API_PREFIX}/bridge/commands`, async (ctx) => {
    requireBridge(ctx);
    const q = ctx.url.searchParams;
    const result = await ops.claimCommands({
      limit: toInt(q.get('limit'), 5, { min: 1, max: 25 }),
      bridge: q.get('bridge') ?? 'bridge'
    });
    if (result.count) audit({ event: 'bridge_commands_claimed', count: result.count, methods: result.commands.map((command) => command.method) });
    sendJson(ctx.res, 200, result);
  });

  add('POST', `${API_PREFIX}/bridge/commands/:id/result`, async (ctx) => {
    requireBridge(ctx);
    const body = await readJson(ctx.req, Math.max(1024 * 1024, Number(cfg.capabilities?.maxResultBytes ?? 0) + 65536));
    const result = await ops.completeCommand(ctx.params.id, body);
    audit({ event: 'bridge_result', commandId: ctx.params.id, method: result.method, status: result.status, ok: result.ok });
    sendJson(ctx.res, 200, result);
  });

  add('POST', `${API_PREFIX}/bridge/heartbeat`, async (ctx) => {
    requireBridge(ctx);
    const body = await readJson(ctx.req, 256 * 1024);
    sendJson(ctx.res, 200, await ops.bridgeBeat(body));
  });

  // Directed session bindings (v0.4). The local bridge records "peer thread -> local Session"
  // before prompting that Session, so the next outbound message can carry `originSession`
  // even when the model does not pass one explicitly.
  add('POST', `${API_PREFIX}/bridge/bind`, async (ctx) => {
    requireBridge(ctx);
    const body = await readJson(ctx.req, 64 * 1024);
    const result = await ops.bindSession({ thread: body.thread, sessionId: body.sessionId, peer: body.peer });
    audit({ event: 'bridge_bind', thread: result.binding.thread, sessionId: result.binding.sessionId, peer: result.binding.peer ?? null });
    sendJson(ctx.res, 200, result);
  });

  add('GET', `${API_PREFIX}/bridge/bind`, async (ctx) => {
    requireBridge(ctx);
    sendJson(ctx.res, 200, await ops.binding({ thread: ctx.url.searchParams.get('thread') ?? '' }));
  });

  add('POST', '/mcp', async (ctx) => {
    const body = await readJson(ctx.req, cfg.limits.maxBodyBytes);
    const sessionId = ctx.req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') sessions.add(sessionId);
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of messages) {
      const response = await handleMcpMessage(message, { ops, sessionId });
      if (response) responses.push(response);
    }
    if (!responses.length) { ctx.res.writeHead(202); ctx.res.end(); return; }
    const payload = Array.isArray(body) ? responses : responses[0];
    const headers = {};
    if (typeof sessionId === 'string' && sessions.has(sessionId)) headers['mcp-session-id'] = sessionId;
    sendJson(ctx.res, 200, payload, headers);
  }, { audit: 'mcp' });

  add('GET', '/mcp', async (ctx) => {
    // No server-initiated stream in this implementation; the spec allows 405 here.
    sendJson(ctx.res, 405, { error: { code: 'method_not_allowed', message: 'dsh-link does not offer a server-initiated SSE stream; POST JSON-RPC instead' } }, { allow: 'POST, DELETE' });
  });

  add('DELETE', '/mcp', async (ctx) => {
    const sessionId = ctx.req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') sessions.delete(sessionId);
    sendJson(ctx.res, 200, { ok: true });
  });

  // --------------------------------------------------------------- dispatch ---
  async function handle(req, res) {
    const started = Date.now();
    // Pick up config-file changes (peers, tokens, roots) before serving the request, so a
    // node never answers from a configuration the user has already replaced on disk.
    if (refresh) {
      try { await refresh(); } catch (err) { log.warn('config reload failed:', err?.message ?? String(err)); }
    }
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendError(res, badRequest('malformed request URL'));
      return;
    }
    const pathname = url.pathname;
    const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!route) {
      sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${req.method} ${pathname}` } });
      return;
    }
    const ctx = { req, res, url, params: {}, auth: null };
    if (route.re.test(pathname)) {
      const match = route.re.exec(pathname);
      route.names.forEach((name, index) => { ctx.params[name] = decodeURIComponent(match[index + 1]); });
    }
    try {
      if (!OPEN_PATHS.has(pathname)) {
        const auth = authorize(req);
        if (!auth.ok) {
          audit({ event: 'auth_failed', ip: auth.ip, path: pathname, throttled: !!auth.throttled });
          if (auth.throttled) throw new LinkError(429, 'too_many_failures', 'too many failed authentication attempts; slow down');
          throw unauthorized();
        }
        ctx.auth = auth;
        rateLimit(auth);
        const role = roleOf(auth);
        if (Array.isArray(route.roles) && !route.roles.includes(role)) {
          audit({ event: 'role_forbidden', role, path: pathname, token: auth.token?.label ?? 'localhost' });
          throw new LinkError(403, 'role_forbidden', `this route is not available to role "${role}"`);
        }
      } else {
        ctx.auth = { via: 'open', ip: clientIp(req), token: null };
      }
      await route.handler(ctx);
      if (route.audit && route.audit !== 'mcp') audit({ event: route.audit, ip: ctx.auth.ip });
      log.debug(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      sendError(res, err);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('unhandled request error:', err?.stack ?? String(err));
      if (!res.headersSent) sendError(res, err);
    });
  });
  server.requestTimeout = cfg.limits.requestTimeoutMs;
  server.headersTimeout = cfg.limits.requestTimeoutMs + 5000;
  server.keepAliveTimeout = 5000;

  return {
    server,
    routes,
    mcpProtocolVersions: MCP_PROTOCOL_VERSIONS,
    mcpDefaultProtocol: MCP_DEFAULT_PROTOCOL,
    async listen({ port = cfg.port, bind = cfg.bind } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind, () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      cfg.port = actualPort;
      return { port: actualPort, bind, url: `http://${bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind}:${actualPort}` };
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}