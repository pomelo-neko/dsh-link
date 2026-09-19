// dsh-link: capability channel policy + the on-disk command queue the DSH bridge drains.
//
// A remote peer asks this node for a DSH capability over HTTP (workspaces.list, sessions.prompt,
// ...). The node never touches DSH itself: it drops a command file into the queue, the in-process
// bridge plugin calls claim(), runs the command inside DSH and writes the terminal result back
// with complete(). This module owns the two halves the HTTP router must not re-implement --
// "who may ask for what" (authorizeCall) and "how a command travels" (createCommandQueue) --
// plus bridge liveness (createBridgePresence). No HTTP or bridge protocol code lives here.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { slugName } from './config.mjs';
import { LinkError, badRequest, clampText, flagBool, isPlainObject, newId, notFound, nowIso, toInt } from './util.mjs';

/**
 * Every capability a peer can ask for. "read" calls only observe DSH, "action" calls mutate it
 * (create/prompt/rename/archive), so only reads are enabled by default.
 */
export const CAPABILITY_METHODS = {
  'workspaces.list': { kind: 'read', description: 'list the DSH workspaces this node knows' },
  'sessions.list': { kind: 'read', description: 'list sessions, optionally inside one workspace' },
  'sessions.read': { kind: 'read', description: 'read one session transcript' },
  'sessions.create': { kind: 'action', description: 'create a new DSH session' },
  'sessions.prompt': { kind: 'action', description: 'send a prompt to an existing session' },
  'sessions.rename': { kind: 'action', description: 'rename a session' },
  'sessions.archive': { kind: 'action', description: 'archive a session' },
  'bridge.status': { kind: 'read', description: 'report bridge presence and its capabilities' }
};

export const CAPABILITY_DEFAULTS = {
  enabled: false,
  methods: ['workspaces.list', 'sessions.list', 'sessions.read', 'bridge.status'],
  peers: {},
  maxWaitSeconds: 30,
  commandTtlSeconds: 120,
  maxPending: 50,
  claimStaleSeconds: 60,
  maxResultBytes: 524288
};

const KNOWN_METHODS = new Set(Object.keys(CAPABILITY_METHODS));
const TERMINAL_STATUS = new Set(['done', 'failed', 'expired']);
const WAIT_INTERVAL_MS = 150;
// Room kept for the { truncated, originalBytes, preview } envelope when a result is clipped.
const TRUNCATION_ENVELOPE_BYTES = 160;
// Command ids come from newId('cmd'); anything else (e.g. a path-ish id off the wire) is refused.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function methodList(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value) {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (name && KNOWN_METHODS.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Normalize the capability section. Tolerant by design: unknown methods are dropped, bad numbers
 * fall back to defaults, and a whole node config may be passed instead of the section itself (its
 * "capabilities" key is unwrapped). Idempotent, so callers may normalize as often as they like.
 */
export function normalizeCapabilityConfig(raw = {}) {
  const top = isPlainObject(raw) ? raw : {};
  const src = isPlainObject(top.capabilities) ? { ...top, ...top.capabilities } : top;
  const methods = methodList(src.methods);
  const peers = {};
  for (const [name, policy] of Object.entries(isPlainObject(src.peers) ? src.peers : {})) {
    const key = slugName(name, '');
    if (!key) continue;
    const entry = isPlainObject(policy) ? policy : {};
    peers[key] = { allow: methodList(entry.allow) ?? [], deny: methodList(entry.deny) ?? [] };
  }
  return {
    enabled: flagBool(src.enabled, CAPABILITY_DEFAULTS.enabled),
    methods: methods ?? [...CAPABILITY_DEFAULTS.methods],
    peers,
    maxWaitSeconds: toInt(src.maxWaitSeconds, CAPABILITY_DEFAULTS.maxWaitSeconds, { min: 1, max: 3600 }),
    commandTtlSeconds: toInt(src.commandTtlSeconds, CAPABILITY_DEFAULTS.commandTtlSeconds, { min: 1, max: 86400 }),
    maxPending: toInt(src.maxPending, CAPABILITY_DEFAULTS.maxPending, { min: 1, max: 10000 }),
    claimStaleSeconds: toInt(src.claimStaleSeconds, CAPABILITY_DEFAULTS.claimStaleSeconds, { min: 0, max: 86400 }),
    maxResultBytes: toInt(src.maxResultBytes, CAPABILITY_DEFAULTS.maxResultBytes, { min: 64, max: 64 * 1024 * 1024 })
  };
}

/**
 * Decide whether one call may run. The first failing gate wins:
 *   1. the channel itself must be enabled -- local calls (peer === '') are not exempt;
 *   2. the method must be a known capability (a peer policy can never invent one);
 *   3. the peer deny list blocks the method;
 *   4. otherwise the effective allow list applies: a peer entry with a non-empty allow list
 *      overrides the node-wide methods list (it can narrow and it can grant), and without such
 *      an entry the node-wide list decides.
 *
 * @returns {{ok: boolean, reason: string}} reason is one of: allowed, capabilities_disabled,
 *   unknown_method, method_not_allowed, peer_denied, peer_not_allowed.
 */
export function authorizeCall(cfg, { peer = '', method } = {}) {
  const policy = normalizeCapabilityConfig(cfg);
  const name = typeof method === 'string' ? method.trim() : '';
  if (!policy.enabled) return { ok: false, reason: 'capabilities_disabled' };
  if (!KNOWN_METHODS.has(name)) return { ok: false, reason: 'unknown_method' };
  const key = peer ? slugName(peer, '') : '';
  const scoped = key ? policy.peers[key] : undefined;
  if (scoped?.deny.includes(name)) return { ok: false, reason: 'peer_denied' };
  const allow = scoped?.allow.length ? scoped.allow : policy.methods;
  if (!allow.includes(name)) {
    return { ok: false, reason: scoped?.allow.length ? 'peer_not_allowed' : 'method_not_allowed' };
  }
  return { ok: true, reason: 'allowed' };
}

/** HTTP status for a refused call: only "no such capability" is a 404, everything else is 403. */
function statusForReason(reason) {
  return reason === 'unknown_method' ? 404 : 403;
}

/** tmp + rename, so a reader never sees a half-written record. */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
  return value;
}

async function readJsonFile(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return isPlainObject(raw) ? raw : null;
  } catch {
    return null;   // missing, mid-rename or torn -- callers read that as "not there yet"
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

function safeId(id) {
  const s = typeof id === 'string' ? id.trim() : '';
  return ID_PATTERN.test(s) ? s : null;
}

/**
 * Command results must stay inside maxResultBytes, otherwise the queue would push unbounded blobs
 * through JSON and HTTP. An oversized result becomes a preview envelope marked truncated.
 */
function clampResult(result, maxBytes, logger) {
  let json;
  try {
    json = JSON.stringify(result ?? null);
  } catch {
    return { truncated: true, originalBytes: null, preview: '<result is not JSON-serializable>' };
  }
  if (json === undefined) json = 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return result ?? null;
  const budget = Math.max(0, maxBytes - TRUNCATION_ENVELOPE_BYTES);
  const preview = Buffer.from(json, 'utf8').subarray(0, budget).toString('utf8');
  logger?.warn?.(`command result is ${bytes} bytes; clipped to ${budget} for the caller`);
  return { truncated: true, originalBytes: bytes, preview };
}

function normalizeError(error) {
  if (error == null) return 'command failed';
  if (error instanceof Error) return clampText(error.message, 4000);
  if (typeof error === 'string') return clampText(error, 4000);
  if (isPlainObject(error)) return error;
  return clampText(String(error), 4000);
}

/**
 * The command queue: one JSON file per command inside dir, plus a sidecar claim file that acts as
 * the lock (see claim()). Statuses: pending -> claimed -> done | failed, or expired when sweep()
 * gives up on a command nobody finished.
 */
export function createCommandQueue({ dir, cfg = {}, logger } = {}) {
  if (!dir) throw new LinkError(2, 'usage', 'createCommandQueue needs a data dir: { dir }');
  const dirPath = path.resolve(String(dir));
  let policy = normalizeCapabilityConfig(cfg);
  let closed = false;
  // Serializes enqueue/claim inside this process (the wx claim file covers other processes).
  let chain = Promise.resolve();
  // Live wait() timers, so close() can wake their callers instead of stranding them.
  const timers = new Map();

  const fileFor = (id) => path.join(dirPath, id + '.json');
  const claimFor = (id) => path.join(dirPath, id + '.claim');

  const lock = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.then(() => {}, () => {});
    return next;
  };

  const ensureDir = () => fs.mkdir(dirPath, { recursive: true });

  async function readById(id) {
    const name = safeId(id);
    return name ? readJsonFile(fileFor(name)) : null;
  }

  /** Every command record in dir, oldest first (ids are time-sortable). */
  async function listRecords() {
    let names;
    try {
      names = await fs.readdir(dirPath);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;   // skips .claim files and .json.<pid>.<rnd>.tmp files
      const id = name.slice(0, -'.json'.length);
      // bridge.json (presence) and other stray JSON files are not commands: a command record
      // always carries a method, a status and an id matching its own file name.
      const rec = await readJsonFile(fileFor(id));
      if (rec && typeof rec.method === 'string' && typeof rec.status === 'string' && rec.id === id) records.push(rec);
    }
    records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return records;
  }

  function pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timer.unref?.();
      timers.set(timer, resolve);
    });
  }

  /** Queue a capability call. Throws LinkError when the policy refuses it or the queue is full. */
  async function enqueue({ method, params, origin } = {}) {
    await ensureDir();
    const peer = origin?.peer ? String(origin.peer) : '';
    const verdict = authorizeCall(policy, { peer, method });
    if (!verdict.ok) {
      throw new LinkError(statusForReason(verdict.reason), verdict.reason,
        'capability "' + method + '" refused: ' + verdict.reason);
    }
    const payload = params ?? null;
    try {
      JSON.stringify(payload);
    } catch {
      throw badRequest('command params must be JSON-serializable');
    }
    return lock(async () => {
      const active = (await listRecords()).filter((r) => !TERMINAL_STATUS.has(r.status)).length;
      if (active >= policy.maxPending) {
        throw new LinkError(429, 'too_many_commands',
          'too many pending commands (' + active + ' >= ' + policy.maxPending + ')');
      }
      const record = {
        id: newId('cmd'),
        method,
        params: payload,
        origin: {
          peer: peer || null,
          ip: origin?.ip ? String(origin.ip) : null,
          label: origin?.label ? String(origin.label) : null
        },
        createdAt: nowIso(),
        status: 'pending',
        claimedBy: null,
        claimedAt: null,
        attempts: 0,
        finishedAt: null,
        result: null,
        error: null
      };
      await writeJsonAtomic(fileFor(record.id), record);
      logger?.debug?.('queued ' + record.method + ' ' + record.id + ' for ' + (record.origin.peer ?? 'local'));
      return record;
    });
  }

  /**
   * Take up to limit commands for this bridge. Candidates are pending commands and claims whose
   * lease went stale. The claim file is created with O_EXCL (flag wx), so exactly one bridge --
   * in this process or another -- walks away with a given command.
   */
  async function claim({ limit = 5, bridge = 'bridge' } = {}) {
    await ensureDir();
    const max = toInt(limit, 5, { min: 0, max: 1000 });
    if (!max) return [];
    const owner = String(bridge || 'bridge');
    return lock(async () => {
      const now = Date.now();
      const staleMs = policy.claimStaleSeconds * 1000;
      const claimed = [];
      for (const record of await listRecords()) {
        if (claimed.length >= max) break;
        const pending = record.status === 'pending';
        const leased = record.status === 'claimed';
        if (!pending && !leased) continue;
        const claimFile = claimFor(record.id);
        const stat = await statOrNull(claimFile);
        // The claim file is the lease, so its mtime is the authoritative claim timestamp.
        const staleLease = stat != null && staleMs > 0 && now - stat.mtimeMs >= staleMs;
        if (leased && stat && !staleLease) continue;   // another bridge is still working on it
        // A bridge that died while holding the lock leaves the file behind; without removing it
        // O_EXCL could never be won again.
        if (stat && staleLease) await fs.rm(claimFile, { force: true });
        try {
          await fs.writeFile(claimFile, JSON.stringify({ bridge: owner, at: nowIso(), pid: process.pid }), { flag: 'wx' });
        } catch (err) {
          if (err.code === 'EEXIST') continue;   // lost the race -- try the next command
          throw err;
        }
        // Re-read under the lock: the command may have finished while we raced for it.
        const fresh = (await readJsonFile(fileFor(record.id))) ?? record;
        if (TERMINAL_STATUS.has(fresh.status)) {
          await fs.rm(claimFile, { force: true });
          continue;
        }
        const updated = {
          ...fresh,
          status: 'claimed',
          claimedBy: owner,
          claimedAt: nowIso(),
          attempts: (fresh.attempts ?? 0) + 1
        };
        await writeJsonAtomic(fileFor(fresh.id), updated);
        claimed.push(updated);
      }
      if (claimed.length) logger?.debug?.(owner + ' claimed ' + claimed.length + ' command(s)');
      return claimed;
    });
  }

  /**
   * Write the terminal state of a command. Re-completing an already finished command is a no-op (a
   * bridge retry must not rewrite history); results over maxResultBytes are clipped.
   */
  async function complete(id, { ok = true, result = null, error = null } = {}) {
    const name = safeId(id);
    if (!name) throw badRequest('invalid command id');
    const record = await readJsonFile(fileFor(name));
    if (!record) throw notFound('unknown command: ' + name);
    if (TERMINAL_STATUS.has(record.status)) return record;
    const next = { ...record, status: ok ? 'done' : 'failed', finishedAt: nowIso() };
    if (ok) {
      next.result = clampResult(result, policy.maxResultBytes, logger);
      next.error = null;
    } else {
      next.result = null;
      next.error = normalizeError(error);
    }
    await writeJsonAtomic(fileFor(name), next);
    await fs.rm(claimFor(name), { force: true });
    return next;
  }

  const get = (id) => readById(id);

  /** Poll for a terminal state. Returns null on timeout (default: maxWaitSeconds). */
  async function wait(id, ms = policy.maxWaitSeconds * 1000) {
    const name = safeId(id);
    if (!name) return null;
    const timeoutMs = toInt(ms, policy.maxWaitSeconds * 1000, { min: 0, max: 3600 * 1000 });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await readJsonFile(fileFor(name));
      if (record && TERMINAL_STATUS.has(record.status)) return record;
      if (closed) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await pause(Math.min(WAIT_INTERVAL_MS, remaining));
    }
  }

  /** Expire commands nobody finished within commandTtlSeconds. Returns how many were expired. */
  async function sweep() {
    const ttlMs = policy.commandTtlSeconds * 1000;
    const now = Date.now();
    let expired = 0;
    for (const record of await listRecords()) {
      if (TERMINAL_STATUS.has(record.status)) continue;
      const created = Date.parse(String(record.createdAt ?? ''));
      const ageMs = Number.isFinite(created) ? now - created : Number.POSITIVE_INFINITY;
      if (ageMs < ttlMs) continue;
      await writeJsonAtomic(fileFor(record.id), {
        ...record,
        status: 'expired',
        error: 'expired',
        finishedAt: nowIso()
      });
      await fs.rm(claimFor(record.id), { force: true });
      expired += 1;
    }
    if (expired) logger?.info?.('expired ' + expired + ' command(s) past their ttl');
    return expired;
  }

  async function stats() {
    const counts = { pending: 0, claimed: 0, done: 0, failed: 0, expired: 0 };
    let oldestPendingAt = null;
    for (const record of await listRecords()) {
      if (counts[record.status] === undefined) continue;
      counts[record.status] += 1;
      if (record.status === 'pending') {
        const at = String(record.createdAt ?? '');
        if (at && (!oldestPendingAt || at < oldestPendingAt)) oldestPendingAt = at;
      }
    }
    return { ...counts, oldestPendingAt };
  }

  return {
    dir: dirPath,
    enqueue,
    claim,
    complete,
    get,
    wait,
    sweep,
    stats,
    setConfig(next) {
      policy = normalizeCapabilityConfig(next);
      return policy;
    },
    config: () => ({ ...policy }),
    close() {
      closed = true;
      for (const [timer, resolve] of timers) {
        clearTimeout(timer);
        resolve();
      }
      timers.clear();
    }
  };
}

function normalizeCapabilities(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const name = typeof entry === 'string' ? entry.trim().slice(0, 64) : '';
      if (name && !out.includes(name) && out.length < 64) out.push(name);
    }
    return out;
  }
  if (isPlainObject(value)) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Bridge liveness next to the queue: the plugin rewrites <dir>/bridge.json on every beat, so the
 * node can answer "is a bridge listening right now?" without touching DSH itself.
 */
export function createBridgePresence({ dir, cfg = {}, logger } = {}) {
  if (!dir) throw new LinkError(2, 'usage', 'createBridgePresence needs a data dir: { dir }');
  const dirPath = path.resolve(String(dir));
  const file = path.join(dirPath, 'bridge.json');

  async function read() {
    return readJsonFile(file);
  }

  async function beat(info = {}) {
    await fs.mkdir(dirPath, { recursive: true });
    const declared = normalizeCapabilities(info.capabilities);
    // cfg only feeds the fallback: a bridge that does not declare its own capability list is
    // reported as "whatever this node currently allows".
    const policy = normalizeCapabilityConfig(cfg);
    const record = {
      node: info.node == null ? null : String(info.node).slice(0, 128),
      version: info.version == null ? null : String(info.version).slice(0, 64),
      capabilities: declared ?? (policy.enabled ? [...policy.methods] : []),
      sessions: info.sessions == null ? null : toInt(info.sessions, null, { min: 0 }),
      at: nowIso()
    };
    await writeJsonAtomic(file, record);
    return record;
  }

  async function staleness(ms = 60000) {
    const maxAgeMs = toInt(ms, 60000, { min: 0, max: 86400000 });
    const record = await read();
    const at = Date.parse(String(record?.at ?? ''));
    if (!record || !Number.isFinite(at)) return { fresh: false, ageMs: null };
    const ageMs = Math.max(0, Date.now() - at);
    return { fresh: ageMs <= maxAgeMs, ageMs };
  }

  return { path: file, beat, read, staleness };
}
