// dsh-link: node operations shared by the CLI and the MCP tools.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MessageStore } from './store.mjs';
import { clientForPeer } from './client.mjs';
import { DSHLINK_VERSION, LinkError, badRequest, clampText, newId, notFound, nowIso, tooLarge } from './util.mjs';
import { CAPABILITY_METHODS, authorizeCall } from './capabilities.mjs';

const MAX_SUBJECT = 300;

export function createOps({ cfg, store, roots, logger, dsh = null, commands = null, presence = null }) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };

  function peerOrNull(name) {
    if (!name) return null;
    const wanted = String(name).trim();
    if (!wanted || wanted === cfg.name || wanted === 'self' || wanted === 'local') return null;
    return cfg.peers.find((p) => p.name === wanted) ?? null;
  }

  function requirePeer(name) {
    const peer = peerOrNull(name);
    if (!peer) {
      if (name && (name === cfg.name || name === 'self' || name === 'local')) {
        throw badRequest(`"${name}" is this node ("${cfg.name}"); use a peer name for remote operations`);
      }
      throw notFound(`unknown peer: ${name}`, { known: cfg.peers.map((p) => p.name) });
    }
    return peer;
  }

  function isSelf(name) {
    return !name || name === cfg.name || name === 'self' || name === 'local';
  }

  function clientFor(name, opts = {}) {
    const peer = requirePeer(name);
    if (!peer.token) throw new LinkError(401, 'peer_token_missing', `peer "${peer.name}" has no token configured; run: dshlink peers add --name ${peer.name} --url ${peer.url} --token <token>`);
    return clientForPeer(peer, { timeoutMs: opts.timeoutMs ?? cfg.limits.requestTimeoutMs });
  }

  function localUrl() {
    const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
    return cfg.publicUrl ?? `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}`;
  }

  async function buildAttachments(specs = []) {
    const out = [];
    let total = 0;
    for (const spec of specs) {
      if (!spec || typeof spec !== 'object') throw badRequest('each attachment needs {name, path} or {name, contentBase64}');
      let buffer;
      let name = spec.name ? path.basename(String(spec.name)) : null;
      if (spec.contentBase64) {
        buffer = Buffer.from(String(spec.contentBase64), 'base64');
        name ??= 'attachment.bin';
      } else if (spec.localRoot || spec.path) {
        const resolved = await roots.resolve(spec.localRoot ?? spec.root, spec.path ?? spec.name);
        buffer = await fs.readFile(resolved.abs);
        name ??= path.basename(resolved.rel);
      } else {
        throw badRequest('attachment needs contentBase64 or path');
      }
      if (buffer.length > cfg.limits.maxInlineAttachmentBytes) {
        throw tooLarge(`attachment "${name}" is ${buffer.length} bytes; inline limit is ${cfg.limits.maxInlineAttachmentBytes} — push it with the file API instead`, { name, size: buffer.length });
      }
      total += buffer.length;
      out.push({
        name,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        encoding: 'base64',
        contentBase64: buffer.toString('base64')
      });
    }
    return { attachments: out, total };
  }

  function buildMessage(input = {}) {
    const to = String(input.to ?? '').trim();
    if (!to) throw badRequest('a recipient (to) is required');
    const body = String(input.body ?? '');
    if (!body && !(input.attachments ?? []).length) throw badRequest('a message needs a body or an attachment');
    return {
      id: input.id ?? newId('msg'),
      ts: input.ts ?? nowIso(),
      from: { nodeId: cfg.nodeId, name: cfg.name, url: cfg.publicUrl ?? localUrl() },
      to,
      thread: input.thread ?? null,
      replyTo: input.replyTo ?? null,
      kind: input.kind ?? 'message',
      subject: clampText(input.subject ?? '', MAX_SUBJECT),
      body,
      attachments: [],
      meta: input.meta ?? undefined
    };
  }

  async function deliver(record, { via } = {}) {
    if (isSelf(record.to)) {
      await store.append('inbox', { ...record, via: 'local' });
      await store.setDelivery(record.id, { state: 'delivered', via: 'local' });
      return { state: 'delivered', via: 'local' };
    }
    const candidates = [];
    const direct = peerOrNull(record.to);
    if (direct) candidates.push(direct);
    else if (cfg.peers.length && cfg.relay.enabled) candidates.push(...cfg.peers);
    if (!candidates.length) {
      await store.setDelivery(record.id, { state: 'pending', error: `unknown peer: ${record.to}` });
      return { state: 'pending', error: `unknown peer: ${record.to}` };
    }
    let lastError = null;
    for (const peer of candidates) {
      if (!peer.token) { lastError = `peer "${peer.name}" has no token configured`; continue; }
      try {
        const result = await clientFor(peer.name).deliverMessage(record);
        const info = { state: 'delivered', via: peer.name, remote: result ?? null };
        await store.setDelivery(record.id, info);
        return info;
      } catch (err) {
        lastError = err.message;
        log.warn(`delivery to ${peer.name} failed:`, err.message);
      }
    }
    await store.setDelivery(record.id, { state: 'pending', error: lastError });
    return { state: 'pending', error: lastError };
  }

  async function sendMessage(input = {}) {
    const { attachments, total } = await buildAttachments(input.attachments ?? []);
    const record = buildMessage(input);
    record.attachments = attachments;
    record.thread ??= record.replyTo ? (await store.get('inbox', record.replyTo))?.thread ?? record.replyTo : record.id;
    const payload = Buffer.byteLength(JSON.stringify(record), 'utf8');
    if (payload > cfg.limits.maxMessageBytes) {
      throw tooLarge(`message is ${payload} bytes; limit is ${cfg.limits.maxMessageBytes}`, { size: payload });
    }
    await store.append('outbox', record);
    await store.setDelivery(record.id, { state: 'pending', attempts: 1, bytes: payload, attachmentBytes: total });
    const delivery = await deliver(record);
    return { message: record, delivery, bytes: payload };
  }

  async function flush({ to } = {}) {
    const pending = await store.pendingOutbox();
    const targets = to ? pending.filter((m) => m.to === to) : pending;
    const results = [];
    for (const record of targets) {
      const delivery = await deliver(record);
      results.push({ id: record.id, to: record.to, ...delivery });
    }
    return { attempted: targets.length, delivered: results.filter((r) => r.state === 'delivered').length, pending: results.filter((r) => r.state !== 'delivered').length, results };
  }

  /**
   * Give up on queued messages (dead peer, target node gone). Unlike relay failures these
   * are never retried again, so a stuck queue does not keep doctor/flush complaining forever.
   */
  async function dropOutbox({ id, ids, to } = {}) {
    const wanted = new Set([...(ids ?? []), id].filter(Boolean));
    if (!wanted.size && !to) throw badRequest('pass --id <message id> or --to <peer> (refusing to drop the whole queue silently)');
    const pending = await store.pendingOutbox();
    const targets = pending.filter((m) => (wanted.size ? wanted.has(m.id) : m.to === to));
    for (const record of targets) {
      await store.setDelivery(record.id, { state: 'dropped', error: 'dropped by operator (dshlink outbox drop)' });
    }
    return { dropped: targets.length, ids: targets.map((m) => m.id), remaining: (await store.pendingOutbox()).length };
  }

  async function inbox(query = {}) {
    const limit = Math.min(Number(query.limit ?? 50) || 50, 1000);
    const result = await store.list('inbox', {
      since: query.since,
      limit,
      unreadOnly: query.unreadOnly === true || query.unread === true,
      thread: query.thread,
      peer: query.peer,
      order: query.order === 'asc' ? 'asc' : 'desc',
      markRead: query.markRead === true
    });
    return result;
  }

  async function readMessage({ id, box = 'inbox' } = {}) {
    if (!id) throw badRequest('an id is required');
    const message = await store.get(box, id);
    if (!message) throw notFound(`no message ${id} in ${box}`);
    if (box === 'inbox') await store.markRead([id]);
    return message;
  }

  async function sync({ peer, limit = 200, since } = {}) {
    const targets = peer ? [requirePeer(peer)] : cfg.peers.filter((p) => p.token);
    if (!targets.length) return { peers: [], imported: 0, skipped: 0 };
    const results = [];
    for (const target of targets) {
      try {
        const remote = await clientFor(target.name).outbox({ to: cfg.name, since, limit });
        const imported = await store.importMessages(remote?.messages ?? [], target.name);
        results.push({ peer: target.name, fetched: remote?.count ?? 0, imported: imported.imported, skipped: imported.skipped });
      } catch (err) {
        results.push({ peer: target.name, error: err.message });
      }
    }
    return {
      peers: results,
      imported: results.reduce((n, r) => n + (r.imported ?? 0), 0),
      skipped: results.reduce((n, r) => n + (r.skipped ?? 0), 0)
    };
  }

  async function peers({ probe = false } = {}) {
    const list = [];
    for (const peer of cfg.peers) {
      const entry = { name: peer.name, url: peer.url, hasToken: !!peer.token, autoSync: !!peer.autoSync };
      if (probe) {
        const started = Date.now();
        try {
          const info = await clientForPeer(peer, { timeoutMs: 5000 }).info();
          entry.reachable = true;
          entry.remote = { name: info.name, nodeId: info.nodeId, software: info.software, softwareVersion: info.softwareVersion };
          entry.roots = info.roots;
        } catch (err) {
          entry.reachable = false;
          entry.error = err.message;
        }
        entry.latencyMs = Date.now() - started;
      }
      list.push(entry);
    }
    return { self: cfg.name, count: list.length, peers: list };
  }

  async function status({ probe = false } = {}) {
    const stats = await store.stats();
    return {
      node: {
        name: cfg.name,
        nodeId: cfg.nodeId,
        url: localUrl(),
        bind: cfg.bind,
        port: cfg.port,
        dataDir: cfg.dataDir,
        configPath: cfg.configPath ?? null,
        software: 'dsh-link',
        version: DSHLINK_VERSION
      },
      stats,
      roots: roots.describe(),
      allowUpload: roots.allowUpload,
      inboundTokens: cfg.auth.tokens.length,
      peers: (await peers({ probe })).peers
    };
  }

  async function listFiles({ peer, root, path: relPath = '', limit } = {}) {
    if (isSelf(peer)) return { peer: cfg.name, ...(await roots.listDir(root, relPath, { limit })) };
    const result = await clientFor(peer).listFiles({ root, path: relPath, limit });
    return { peer: peer, ...result };
  }

  async function statFile({ peer, root, path: relPath } = {}) {
    if (isSelf(peer)) return { peer: cfg.name, ...(await roots.statPath(root, relPath)) };
    return { peer, ...(await clientFor(peer).statFile({ root, path: relPath })) };
  }

  async function pullFile({ peer, root, path: remotePath, out, localRoot } = {}) {
    if (!remotePath) throw badRequest('a remote path is required');
    if (isSelf(peer)) {
      const source = await roots.openRead(root, remotePath);
      const target = out
        ? path.resolve(out)
        : path.join(store.paths.inboxFiles, path.basename(source.abs));
      const hash = createHash('sha256');
      const buffer = await fs.readFile(source.abs);
      hash.update(buffer);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, buffer);
      return { peer: cfg.name, from: source.displayPath, path: target, size: buffer.length, sha256: hash.digest('hex'), verified: true, localCopy: true };
    }
    const client = clientFor(peer);
    const filename = path.basename(String(remotePath)) || 'download.bin';
    let target;
    if (out) target = path.resolve(out);
    else if (localRoot) {
      const resolved = await roots.resolve(localRoot, filename, { forWrite: true });
      target = resolved.abs;
    } else {
      target = path.join(store.paths.inboxFiles, filename);
    }
    const info = await client.download({ root, path: remotePath }, target);
    return { peer, remote: { root: root ?? null, path: remotePath }, ...info };
  }

  async function pushFile({ peer, root, path: remotePath, file, localRoot } = {}) {
    if (!file && !(localRoot && remotePath)) throw badRequest('push needs a local file (--file) or --local-root/--local-path');
    if (isSelf(peer)) throw badRequest('cannot push to this node; copy locally instead');
    let buffer;
    let name;
    if (localRoot) {
      const resolved = await roots.resolve(localRoot, file ?? remotePath);
      buffer = await fs.readFile(resolved.abs);
      name = path.basename(resolved.rel);
    } else {
      const abs = path.resolve(file);
      buffer = await fs.readFile(abs);
      name = path.basename(abs);
    }
    const targetPath = remotePath ?? name;
    const result = await clientFor(peer).upload({ root, path: targetPath }, buffer);
    return { peer, target: { root: root ?? null, path: targetPath }, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), remote: result };
  }

  /** Inbound delivery handling for POST /api/v1/messages. */
  async function acceptMessage(record) {
    if (!record || typeof record !== 'object') throw badRequest('a message object is required');
    const id = String(record.id ?? '');
    if (!id) throw badRequest('the message needs an id');
    const to = String(record.to ?? '');
    const existing = await store.get('inbox', id);
    if (existing) return { accepted: true, stored: 'inbox', duplicate: true, id };
    if (isSelf(to) || to === '*' || to === '') {
      await store.append('inbox', { ...record, id, to: to || cfg.name, via: 'push', receivedAt: nowIso() });
      return { accepted: true, stored: 'inbox', id };
    }
    if (!cfg.relay.enabled) throw new LinkError(409, 'relay_disabled', `message for "${to}" was not accepted and this node does not relay`);
    const target = peerOrNull(to);
    if (!target) throw notFound(`unknown recipient: ${to}`, { known: [cfg.name, ...cfg.peers.map((p) => p.name)] });
    const result = await clientFor(target.name).deliverMessage(record);
    await store.append('outbox', { ...record, id, relayedBy: cfg.name, via: target.name });
    return { accepted: true, stored: 'relayed', id, via: target.name, remote: result ?? null };
  }

  // ------------------------------------------------------------- DSH view ----
  // Read-only projection of the local DSH installation (workspaces, conversations,
  // transcripts). The peer-facing routes call these; every one of them is gated by
  // the "dsh" config section, which is off by default.
  function requireDsh() {
    if (cfg.dsh?.enabled !== true) {
      throw new LinkError(403, 'dsh_disabled', 'the DSH view is disabled on this node (set "dsh": { "enabled": true })');
    }
    if (!dsh) throw new LinkError(503, 'dsh_unavailable', 'this node was started without the DSH view');
    return dsh;
  }

  function dshGuard(kind) {
    const view = requireDsh();
    if (kind === 'workspaces' && cfg.dsh.exposeWorkspaces !== true) {
      throw new LinkError(403, 'dsh_workspaces_disabled', 'listing workspaces and conversations is disabled (dsh.exposeWorkspaces)');
    }
    if (kind === 'transcripts' && cfg.dsh.exposeTranscripts !== true) {
      throw new LinkError(403, 'dsh_transcripts_disabled', 'reading conversations is disabled (dsh.exposeTranscripts)');
    }
    return view;
  }

  function visibleWorkspaces(list) {
    const excluded = (cfg.dsh?.excludeWorkspaces ?? []).map((value) => String(value).toLowerCase());
    if (!excluded.length) return list;
    const normalize = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase();
    return list.filter((workspace) => !excluded.some((needle) => (
      String(workspace.id).toLowerCase() === needle || normalize(workspace.path).endsWith('/' + needle)
    )));
  }

  async function requireViewOk(view) {
    const available = await view.available();
    if (!available || available.ok !== true) {
      throw new LinkError(503, 'dsh_unavailable', 'the DSH view is unavailable (' + ((available && available.reason) || 'unknown') + ')');
    }
    return available;
  }

  async function dshWorkspaces({ peer } = {}) {
    if (!isSelf(peer)) return { peer, ...(await clientFor(peer).dshWorkspaces()) };
    const view = dshGuard('workspaces');
    const available = await requireViewOk(view);
    const workspaces = visibleWorkspaces(await view.workspaces());
    return { peer: cfg.name, home: available.home ?? cfg.dsh.home ?? null, count: workspaces.length, workspaces };
  }

  async function dshSessions({ peer, workspace, includeArchived = false, query, limit = 100 } = {}) {
    if (!isSelf(peer)) {
      return {
        peer,
        ...(await clientFor(peer).dshSessions({
          workspace,
          includeArchived: includeArchived ? 1 : undefined,
          query,
          limit
        }))
      };
    }
    const view = dshGuard('workspaces');
    await requireViewOk(view);
    const allowed = new Set(visibleWorkspaces(await view.workspaces()).map((entry) => entry.id));
    const sessions = (await view.sessions({ workspace, includeArchived, query, limit }))
      .filter((session) => allowed.has(session.workspaceId));
    return { peer: cfg.name, count: sessions.length, sessions };
  }

  async function dshSession({ peer, sessionId } = {}) {
    if (!sessionId) throw badRequest('a sessionId is required');
    if (!isSelf(peer)) return { peer, ...(await clientFor(peer).dshSession(sessionId)) };
    const view = dshGuard('workspaces');
    await requireViewOk(view);
    const session = await view.session(sessionId);
    if (!session) throw notFound('no session ' + sessionId);
    const allowed = new Set(visibleWorkspaces(await view.workspaces()).map((entry) => entry.id));
    if (!allowed.has(session.workspaceId)) throw notFound('no session ' + sessionId);
    return { peer: cfg.name, session };
  }

  async function dshTranscript({ peer, sessionId, limit, offset = 0, tail = false } = {}) {
    if (!sessionId) throw badRequest('a sessionId is required');
    if (!isSelf(peer)) {
      return { peer, ...(await clientFor(peer).dshTranscript(sessionId, { limit, offset, tail: tail ? 1 : undefined })) };
    }
    const view = dshGuard('transcripts');
    await requireViewOk(view);
    const session = await view.session(sessionId);
    if (!session) throw notFound('no session ' + sessionId);
    const allowed = new Set(visibleWorkspaces(await view.workspaces()).map((entry) => entry.id));
    if (!allowed.has(session.workspaceId)) throw notFound('no session ' + sessionId);
    const maxMessages = Math.max(1, Number(cfg.dsh.transcriptMaxMessages) || 200);
    return {
      peer: cfg.name,
      ...(await view.transcript(sessionId, {
        limit: Math.max(1, Math.min(Number(limit) || maxMessages, maxMessages)),
        offset: Math.max(0, Number(offset) || 0),
        tail: tail === true,
        maxChars: Math.max(200, Number(cfg.dsh.transcriptMaxChars) || 8000)
      }))
    };
  }

  // ----------------------------------------------------- capability channel ----
  // Peer -> this node -> command queue -> the local DSH bridge plugin -> DSH services.
  function capabilityConfig() {
    return cfg.capabilities ?? {};
  }

  function requireCommands() {
    if (!commands) throw new LinkError(503, 'capabilities_unavailable', 'this node was started without the capability channel');
    return commands;
  }

  function summarizeCommand(command) {
    if (!command) return null;
    return {
      commandId: command.id,
      method: command.method,
      status: command.status,
      ok: command.status === 'done',
      origin: command.origin ?? null,
      createdAt: command.createdAt ?? null,
      finishedAt: command.finishedAt ?? null,
      result: command.result ?? null,
      error: command.error ?? null
    };
  }

  async function dshCapabilities({ peer } = {}) {
    if (!isSelf(peer)) return { peer, ...(await clientFor(peer).dshCapabilities()) };
    const config = capabilityConfig();
    const info = presence ? await presence.read() : null;
    let queue = null;
    try { queue = commands ? await commands.stats() : null; } catch { queue = null; }
    return {
      peer: cfg.name,
      enabled: config.enabled === true,
      methods: config.enabled === true ? [...config.methods] : [],
      catalog: Object.entries(CAPABILITY_METHODS).map(([method, meta]) => ({ method, kind: meta.kind, description: meta.description })),
      bridge: info
        ? { version: info.version ?? null, at: info.at ?? null, node: info.node ?? null, sessions: info.sessions ?? null, stale: presence.staleness ? !(await presence.staleness()).fresh : null }
        : null,
      queue
    };
  }

  async function dshCall({ peer, method, params, waitSeconds } = {}) {
    if (!method) throw badRequest('a method is required');
    if (!isSelf(peer)) {
      const config = capabilityConfig();
      const wait = Math.max(0, Math.min(Number(waitSeconds ?? config.maxWaitSeconds ?? 30) || 0, 120));
      const client = clientFor(peer, { timeoutMs: (wait + 15) * 1000 });
      return { peer, ...(await client.dshCall({ method, params: params ?? {}, waitSeconds: wait })) };
    }
    return dshCallLocal({ method, params, waitSeconds, origin: { peer: cfg.name, ip: 'loopback', label: 'localhost' } });
  }

  async function dshCallLocal({ method, params = {}, waitSeconds, origin } = {}) {
    if (!method) throw badRequest('a method is required');
    const queue = requireCommands();
    const config = capabilityConfig();
    const decision = authorizeCall(config, { peer: origin?.peer ?? '', method });
    if (!decision.ok) throw new LinkError(403, 'capability_denied', decision.reason);
    const command = await queue.enqueue({ method, params, origin });
    const wait = Math.max(0, Math.min(Number(waitSeconds ?? config.maxWaitSeconds ?? 30) || 0, 180));
    if (!wait) return { commandId: command.id, status: command.status, pending: true, method };
    const finished = await queue.wait(command.id, wait * 1000);
    if (!finished) return { commandId: command.id, status: 'pending', pending: true, waitedSeconds: wait, method };
    return summarizeCommand(finished);
  }

  async function dshCallResult({ peer, id } = {}) {
    if (!id) throw badRequest('a commandId is required');
    if (!isSelf(peer)) return { peer, ...(await clientFor(peer).dshCallResult(id)) };
    const command = await requireCommands().get(id);
    if (!command) throw notFound('no command ' + id);
    return summarizeCommand(command);
  }

  async function claimCommands({ limit = 5, bridge = 'bridge' } = {}) {
    const claimed = await requireCommands().claim({ limit: Math.max(1, Math.min(Number(limit) || 5, 25)), bridge });
    return { count: claimed.length, commands: claimed };
  }

  async function completeCommand(id, payload = {}) {
    if (!id) throw badRequest('a commandId is required');
    const ok = payload.ok !== false;
    const command = await requireCommands().complete(id, ok
      ? { ok: true, result: payload.result ?? null }
      : { ok: false, error: payload.error ?? { message: 'the bridge reported a failure' } });
    if (!command) throw notFound('no command ' + id);
    return summarizeCommand(command);
  }

  async function bridgeBeat(info = {}) {
    if (!presence) throw new LinkError(503, 'capabilities_unavailable', 'this node was started without the capability channel');
    await presence.beat({ ...info, at: info.at ?? nowIso() });
    return { ok: true, at: info.at ?? nowIso() };
  }

  async function bridgeStatus() {
    const info = presence ? await presence.read() : null;
    const stale = presence?.staleness ? await presence.staleness() : null;
    return {
      bridge: info,
      fresh: stale ? stale.fresh : false,
      ageMs: stale ? stale.ageMs : null,
      queue: commands ? await commands.stats() : null,
      enabled: capabilityConfig().enabled === true
    };
  }

  return {
    cfg, store, roots, log,
    isSelf, requirePeer, peerOrNull, clientFor, localUrl,
    sendMessage, flush, dropOutbox, inbox, readMessage, sync, peers, status,
    listFiles, statFile, pullFile, pushFile, acceptMessage, deliver,
    dshWorkspaces, dshSessions, dshSession, dshTranscript,
    dshCapabilities, dshCall, dshCallLocal, dshCallResult,
    claimCommands, completeCommand, bridgeBeat, bridgeStatus
  };
}
