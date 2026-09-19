// dsh-link: read-only view of the local DSH installation. Reads DSH's on-disk state
// (workspace registry + session logs) so a dsh-link node can answer peer queries about
// workspaces, conversations and transcripts without the DSH process being involved.
import { promises as fs, closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { badRequest, expandEnv, flagBool, isPlainObject, toInt } from './util.mjs';

/** Every zstd frame starts with these 4 bytes; a session log is frames concatenated end to end. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** zstdDecompressSync decodes only the first frame of a buffer, so frames are split by hand. */
const FRAME_BOUNDARY_RETRIES = 4;
const META_HEAD_BYTES = 64 * 1024;
const META_HEAD_MAX_BYTES = 512 * 1024;
const META_MAX_FRAMES = 24;
const LOG_FILENAME = 'session.v3.jsonl.zstd';
const LOG_FILE_RE = /\.jsonl(\.zstd)?$/i;
const SESSION_PREFIX = 'session-';
const PROJCACHE_DIR = ['storages', 'session_projcache', 'sessions'];

/** Read cap for one session log; longer logs are read from the head only and flagged. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** Registry / session-index cache lifetime. */
export const DSH_VIEW_CACHE_MS = 5000;

export const DSH_VIEW_DEFAULTS = {
  enabled: false,
  home: '',
  exposeWorkspaces: false,
  exposeTranscripts: false,
  transcriptMaxChars: 8000,
  transcriptMaxMessages: 200,
  excludeWorkspaces: []
};

// ---------------------------------------------------------------- configuration

function normalizeExcludeList(value) {
  const items = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? value.split(',') : []);
  return items.map((item) => String(item).trim()).filter(Boolean);
}

/** Coerce an arbitrary dshView config block into the documented shape. Never throws. */
export function normalizeDshViewConfig(raw = {}) {
  const src = isPlainObject(raw) ? raw : {};
  const base = DSH_VIEW_DEFAULTS;
  return {
    enabled: flagBool(src.enabled, base.enabled),
    home: typeof src.home === 'string' ? src.home.trim() : base.home,
    exposeWorkspaces: flagBool(src.exposeWorkspaces, base.exposeWorkspaces),
    exposeTranscripts: flagBool(src.exposeTranscripts, base.exposeTranscripts),
    transcriptMaxChars: toInt(src.transcriptMaxChars, base.transcriptMaxChars, { min: 200, max: 1_000_000 }),
    transcriptMaxMessages: toInt(src.transcriptMaxMessages, base.transcriptMaxMessages, { min: 1, max: 10_000 }),
    excludeWorkspaces: normalizeExcludeList(src.excludeWorkspaces)
  };
}

/** Resolve the DSH home directory: cfg.home -> DSH_HOME -> ~/.dsh. Returns an absolute path or null. */
export function resolveDshHome(cfg = {}) {
  const explicit = typeof cfg === 'string' ? cfg : (isPlainObject(cfg) ? cfg.home : '');
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(expandEnv(explicit.trim()));
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return path.resolve(expandEnv(env.trim()));
  const home = os.homedir();
  if (typeof home !== 'string' || home === '') return null;
  return path.join(home, '.dsh');
}

// ------------------------------------------------------------------- decoding

function statSyncOrNull(file) {
  try {
    return statSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

/** Read at most maxBytes from the head of a file. Returns null when nothing can be read. */
function readFilePrefixSync(file, maxBytes) {
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const want = Math.max(0, Math.min(size, maxBytes));
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buf, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
    return read === want ? buf : buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Async twin of readFilePrefixSync; also reports the real size so callers can flag truncation. */
async function readFilePrefix(file, maxBytes) {
  let handle = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const want = Math.max(0, Math.min(stat.size, maxBytes));
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const chunk = await handle.read(buf, read, want - read, read);
      if (!chunk || chunk.bytesRead <= 0) break;
      read += chunk.bytesRead;
    }
    return {
      buffer: read === want ? buf : buf.subarray(0, read),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
      truncatedBytes: stat.size > read
    };
  } catch {
    return null;
  } finally {
    if (handle) { try { await handle.close(); } catch { /* ignore */ } }
  }
}

function frameStarts(buf) {
  const out = [];
  let at = buf.indexOf(ZSTD_MAGIC, 0);
  while (at >= 0) {
    out.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 1);
  }
  return out;
}

function parseLines(text, events) {
  for (const line of text.split('\n')) {
    const body = line.trim();
    if (body === '') continue;
    try {
      const event = JSON.parse(body);
      if (isPlainObject(event)) events.push(event);
    } catch { /* noise or a torn line: skip it */ }
  }
}

/**
 * Decode a concatenated-zstd-frame buffer into JSONL events.
 * Corrupt frames are skipped, never fatal; a frame cut by the read cap is not counted as corrupt.
 */
function decodeFrames(buf, { maxBytes = MAX_LOG_BYTES, maxFrames = Infinity, onFrame } = {}) {
  const events = [];
  const limited = buf.length > maxBytes;
  const data = limited ? buf.subarray(0, maxBytes) : buf;
  let frames = 0;
  let corruptFrames = 0;
  const decompress = zlib.zstdDecompressSync;
  if (typeof decompress !== 'function' || data.length === 0) {
    return { events, frames, corruptFrames, truncatedBytes: limited };
  }
  const starts = frameStarts(data);
  const bounds = starts.concat([data.length]);
  for (let i = 0; i + 1 < bounds.length && frames < maxFrames; i += 1) {
    const lastFrame = i + 1 === bounds.length - 1;
    let decoded = null;
    let advance = 1;
    for (let attempt = 0; attempt < FRAME_BOUNDARY_RETRIES; attempt += 1) {
      const endIndex = i + 1 + attempt;
      if (endIndex > bounds.length - 1) break;
      try {
        decoded = decompress(data.subarray(bounds[i], bounds[endIndex]));
        advance = attempt + 1;
        break;
      } catch {
        decoded = null;
      }
    }
    if (decoded === null) {
      // The final frame is expected to fail when the read window cut the file short.
      if (!(lastFrame && limited)) corruptFrames += 1;
      continue;
    }
    frames += 1;
    parseLines(decoded.toString('utf8'), events);
    i += advance - 1;
    if (typeof onFrame === 'function' && onFrame(events, frames) === true) break;
  }
  return { events, frames, corruptFrames, truncatedBytes: limited };
}

/**
 * Decode a session log. Accepts a Buffer or a path and always returns
 * { events, frames, corruptFrames } - broken frames are skipped instead of thrown.
 */
export function decodeSessionLog(bufferOrPath, { maxBytes = MAX_LOG_BYTES, maxFrames = Infinity } = {}) {
  let buf = null;
  if (Buffer.isBuffer(bufferOrPath)) buf = bufferOrPath;
  else if (bufferOrPath instanceof Uint8Array) {
    buf = Buffer.from(bufferOrPath.buffer, bufferOrPath.byteOffset, bufferOrPath.byteLength);
  } else if (typeof bufferOrPath === 'string' && bufferOrPath !== '') {
    buf = readFilePrefixSync(bufferOrPath, maxBytes);
  }
  if (!buf || buf.length === 0) return { events: [], frames: 0, corruptFrames: 0 };
  const out = decodeFrames(buf, { maxBytes, maxFrames });
  return { events: out.events, frames: out.frames, corruptFrames: out.corruptFrames };
}

// -------------------------------------------------------------- event helpers

function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function partsOf(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/** Flatten a message content array into plain text (unknown parts become [type] markers). */
function contentText(content) {
  if (typeof content === 'string') return content;
  const chunks = [];
  for (const part of partsOf(content)) {
    if (typeof part === 'string') { chunks.push(part); continue; }
    if (!isPlainObject(part)) continue;
    if (part.type === 'text') chunks.push(toText(part.text));
    else if (part.type === 'image') chunks.push('[image]');
    else if (part.type === 'reasoning' || part.type === 'tool-call' || part.type === 'tool-result') continue;
    else if (typeof part.type === 'string' && part.type !== '') chunks.push('[' + part.type + ']');
  }
  return chunks.filter((chunk) => chunk !== '').join('\n');
}

function toolResultBlocks(data) {
  const blocks = [];
  const message = isPlainObject(data.message) ? data.message : null;
  const source = isPlainObject(message?.source) ? message.source : null;
  const fallbackCallId = source?.callId ?? data.callId ?? data.toolCallId ?? null;
  for (const part of partsOf(message?.content ?? data.content)) {
    if (!isPlainObject(part)) continue;
    if (part.type === 'tool-result') blocks.push({ callId: part.toolCallId ?? fallbackCallId, text: contentText(part.content) });
    else if (part.type === 'text') blocks.push({ callId: fallbackCallId, text: toText(part.text) });
  }
  if (blocks.length === 0) {
    const raw = data.result !== undefined ? data.result : data.output;
    if (raw !== undefined) blocks.push({ callId: fallbackCallId, text: toText(raw) });
  }
  return blocks;
}

function clip(text, maxChars) {
  const body = typeof text === 'string' ? text : toText(text);
  if (!Number.isFinite(maxChars) || maxChars <= 0 || body.length <= maxChars) {
    return { text: body, truncated: false };
  }
  return { text: body.slice(0, maxChars), truncated: true };
}

/**
 * Turn raw session events into ordered transcript entries.
 * kind: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result' | 'system'.
 */
function renderMessages(events, maxChars) {
  const callNames = new Map();
  for (const event of events) {
    if (event?.type !== 'tool/call') continue;
    const data = isPlainObject(event.data) ? event.data : {};
    const callId = typeof data.callId === 'string' ? data.callId : (typeof data.id === 'string' ? data.id : '');
    if (callId !== '' && typeof data.name === 'string') callNames.set(callId, data.name);
  }
  const out = [];
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    const type = typeof event.type === 'string' ? event.type : '';
    const data = isPlainObject(event.data) ? event.data : {};
    const seq = Number.isFinite(event.seq) ? event.seq : null;
    const time = Number.isFinite(event.time) ? event.time : null;
    const push = (kind, role, text, tool = null) => {
      const body = clip(text, maxChars);
      if (body.text === '') return;
      out.push({ seq, time, role, kind, text: body.text, tool, truncated: body.truncated });
    };
    if (type === 'user/message') {
      push('user', 'user', contentText(data.content));
    } else if (type === 'assistant/message') {
      for (const part of partsOf(data.message?.content)) {
        if (!isPlainObject(part)) continue;
        if (part.type === 'text') push('assistant', 'assistant', toText(part.text));
        else if (part.type === 'reasoning') push('reasoning', 'assistant', toText(part.text));
        else if (part.type === 'tool-call' || part.type === 'tool_use') {
          const callId = typeof part.id === 'string' ? part.id : (typeof part.toolCallId === 'string' ? part.toolCallId : '');
          // The dedicated tool/call event is authoritative; only fall back when it is absent.
          if (callId === '' || !callNames.has(callId)) {
            push('tool-call', 'assistant', part.arguments ?? part.input, typeof part.name === 'string' ? part.name : null);
          }
        }
      }
    } else if (type === 'tool/call') {
      push('tool-call', 'assistant', data.arguments ?? data.input, typeof data.name === 'string' ? data.name : null);
    } else if (type === 'tool/result') {
      for (const block of toolResultBlocks(data)) {
        push('tool-result', 'tool', block.text, callNames.get(block.callId) ?? null);
      }
    } else if (type === 'system/message') {
      push('system', 'system', contentText(data.message?.content ?? data.content));
    }
  }
  return out;
}

// -------------------------------------------------------------- meta / registry

function normalizeSessionId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return '';
  const bare = raw.toLowerCase().startsWith(SESSION_PREFIX) ? raw.slice(SESSION_PREFIX.length) : raw;
  return bare.trim().toLowerCase();
}

function withSessionPrefix(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return '';
  return raw.toLowerCase().startsWith(SESSION_PREFIX) ? raw : SESSION_PREFIX + raw;
}

function stripSessionPrefix(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return '';
  return raw.toLowerCase().startsWith(SESSION_PREFIX) ? raw.slice(SESSION_PREFIX.length) : raw;
}

function normalizePathKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let key = path.resolve(value.trim());
  while (key.length > 3 && (key.endsWith(path.sep) || key.endsWith('/'))) key = key.slice(0, -1);
  return process.platform === 'win32' ? key.toLowerCase() : key;
}

function isoOrNull(value) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function maxIso(values) {
  let best = null;
  let bestAt = -Infinity;
  for (const value of values) {
    const iso = isoOrNull(value);
    if (iso === null) continue;
    const at = Date.parse(iso);
    if (Number.isFinite(at) && at > bestAt) { bestAt = at; best = iso; }
  }
  return best;
}

function titleOf(node) {
  for (const key of ['title', 'sessionTitle', 'titleText']) {
    const value = node[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (isPlainObject(value)) {
      for (const inner of ['val', 'value', 'text', 'title']) {
        const text = value[inner];
        if (typeof text === 'string' && text.trim() !== '') return text.trim();
      }
    }
  }
  return null;
}

/**
 * Breadth-first search for the first usable title string in a projection-cache file.
 * The cache layout is internal to DSH and may drift, so nothing here is assumed.
 */
function deepFindTitle(root, { maxNodes = 5000, maxDepth = 8 } = {}) {
  const queue = [{ value: root, depth: 0 }];
  let visited = 0;
  for (let head = 0; head < queue.length && visited < maxNodes; head += 1) {
    const node = queue[head].value;
    const depth = queue[head].depth;
    if (!isPlainObject(node) || depth > maxDepth) continue;
    visited += 1;
    const found = titleOf(node);
    if (found) return found;
    for (const child of Object.values(node)) {
      if (isPlainObject(child) || Array.isArray(child)) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

async function loadProjcache(home, names, logger) {
  for (const name of names) {
    if (!name) continue;
    const file = path.join(home, ...PROJCACHE_DIR, name + '.json');
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) continue;
      const identity = isPlainObject(parsed.record?.identity) ? parsed.record.identity : null;
      const title = deepFindTitle(parsed);
      const cwd = typeof identity?.cwd === 'string' ? identity.cwd : null;
      const createdAt = typeof identity?.createdAt === 'number' && Number.isFinite(identity.createdAt)
        ? new Date(identity.createdAt).toISOString()
        : null;
      if (title || cwd || createdAt) return { title, cwd, createdAt };
    } catch (err) {
      logger?.debug?.('dshview: projection cache is not JSON', file, err?.message ?? String(err));
    }
  }
  return null;
}

function headInfo(events) {
  let session = null;
  let title = null;
  for (const event of events) {
    if (!isPlainObject(event)) continue;
    if (event.type === 'session' && !session) {
      session = {
        id: typeof event.id === 'string' ? event.id : null,
        cwd: typeof event.cwd === 'string' ? event.cwd : null,
        createdAt: typeof event.createdAt === 'number' && Number.isFinite(event.createdAt)
          ? new Date(event.createdAt).toISOString()
          : null
      };
    } else if (event.type === 'session/title' && title === null) {
      const text = event.data?.title;
      if (typeof text === 'string' && text.trim() !== '') title = text.trim();
    }
    if (session && title !== null) break;
  }
  return { session, title };
}

function registryWorkspaces(registry) {
  const table = registry?.tables?.workspaces;
  return isPlainObject(table) ? table : {};
}

function resolveExcludedIds(tokens, workspaces) {
  const ids = new Set();
  const needles = (Array.isArray(tokens) ? tokens : []).map((token) => String(token).trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return ids;
  for (const [id, workspace] of Object.entries(workspaces)) {
    const values = [
      id.toLowerCase(),
      String(workspace?.title ?? '').toLowerCase(),
      normalizePathKey(workspace?.path).toLowerCase()
    ].filter(Boolean);
    if (needles.some((needle) => values.includes(needle))) ids.add(id);
  }
  return ids;
}

function compareByUpdatedDesc(a, b) {
  const left = a.updatedAt ? Date.parse(a.updatedAt) : NaN;
  const right = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
  if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

function cloneMeta(meta) {
  return { ...meta };
}

function requireSessionId(value) {
  const key = normalizeSessionId(value);
  if (key === '') throw badRequest('a session id is required');
  return key;
}

function matchesQuery(meta, needle) {
  return [meta.title, meta.sessionId, meta.cwd, meta.workspaceId]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));
}

function emptyTranscript() {
  return { session: null, total: 0, messages: [], truncated: false, corruptFrames: 0 };
}

// ------------------------------------------------------------------- the view

export function createDshView({ cfg = {}, logger, maxLogBytes } = {}) {
  const config = normalizeDshViewConfig(cfg);
  let home = resolveDshHome(config);
  // A node hot-reloads its config file, and the resolved home depends on it (cfg.home, else
  // DSH_HOME, else ~/.dsh). A service-started process often has no DSH_HOME, so the same config
  // can resolve differently than a shell: re-resolve whenever the configured value changes,
  // otherwise the view would keep reading the wrong home until the node is restarted.
  let homeKey = typeof config.home === 'string' ? config.home : '';
  const readCap = Number.isFinite(Number(maxLogBytes)) && Number(maxLogBytes) > 0
    ? Math.trunc(Number(maxLogBytes))
    : MAX_LOG_BYTES;
  const log = logger && typeof logger === 'object' ? logger : null;
  let cache = freshCache();

  function freshCache() {
    return { registry: null, index: null, inflight: null, lastScanAt: null, probe: null, transcripts: new Map() };
  }

  /** Re-resolve the home when the config's `home` value changed; drops stale caches when it did. */
  function syncHome() {
    const wanted = typeof config.home === 'string' ? config.home : '';
    if (wanted === homeKey) return home;
    homeKey = wanted;
    home = resolveDshHome(config);
    refresh();
    return home;
  }

  /** => { ok, home, reason?, enabled } - capability only, callers decide whether to expose anything. */
  function available() {
    syncHome();
    if (typeof zlib.zstdDecompressSync !== 'function') {
      return { ok: false, home, reason: 'zstd-unsupported', enabled: config.enabled };
    }
    if (!home) return { ok: false, home: null, reason: 'home-missing', enabled: config.enabled };
    const now = Date.now();
    if (!cache.probe || now - cache.probe.at >= DSH_VIEW_CACHE_MS) {
      let probe = { ok: false, reason: 'home-missing' };
      try {
        const stat = statSyncOrNull(home);
        if (stat && stat.isDirectory()) probe = { ok: true };
      } catch {
        probe = { ok: false, reason: 'home-unreadable' };
      }
      cache.probe = { at: now, value: probe };
    }
    const probe = cache.probe.value;
    return probe.ok ? { ok: true, home, enabled: config.enabled } : { ok: false, home, reason: probe.reason, enabled: config.enabled };
  }

  /** Drop every cached registry / index / transcript entry. */
  function refresh() {
    cache = freshCache();
  }

  /**
   * Re-apply a (possibly reloaded) config section in place. The view normalizes its config into a
   * private object, so a node that hot-reloads its config file must call this — otherwise the view
   * keeps the settings it was constructed with (which is how a node started by a task could keep
   * reading a stale, auto-detected DSH home after the config pinned a new one).
   */
  function reconfigure(raw) {
    const next = normalizeDshViewConfig(raw ?? {});
    for (const key of Object.keys(config)) {
      if (!(key in next)) delete config[key];
    }
    Object.assign(config, next);
    syncHome();
    refresh();
    return { ...config, home };
  }

  /** => { home, indexed, lastScanAt, cacheMs } for the current cache generation. */
  function stats() {
    syncHome();
    return {
      home,
      indexed: cache.index ? cache.index.value.entries.length : 0,
      lastScanAt: cache.lastScanAt,
      cacheMs: DSH_VIEW_CACHE_MS
    };
  }

  /** Parsed workspace.json exactly as it sits on disk (null when missing or unreadable). */
  async function registry() {
    syncHome();
    const now = Date.now();
    if (cache.registry && now - cache.registry.at < DSH_VIEW_CACHE_MS) return cache.registry.value;
    let value = null;
    if (home) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'));
        value = isPlainObject(parsed) ? parsed : null;
      } catch (err) {
        if (err?.code !== 'ENOENT') log?.debug?.('dshview: workspace registry unreadable', err?.message ?? String(err));
        value = null;
      }
    }
    cache.registry = { at: Date.now(), value };
    return value;
  }

  async function findLogFile(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const files = entries.filter((entry) => entry.isFile());
    const exact = files.find((entry) => entry.name === LOG_FILENAME);
    if (exact) return path.join(dir, exact.name);
    const drift = files.find((entry) => LOG_FILE_RE.test(entry.name));
    return drift ? path.join(dir, drift.name) : null;
  }

  /** sessions/<slug>/<session>/session.v3.jsonl.zstd, plus the flatter layouts seen in the wild. */
  async function listSessionLogs() {
    const out = [];
    if (!home) return out;
    const root = path.join(home, 'sessions');
    let slugs = [];
    try {
      slugs = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if (err?.code !== 'ENOENT') log?.debug?.('dshview: sessions directory unreadable', err?.message ?? String(err));
      return out;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const slugDir = path.join(root, slug.name);
      const direct = await findLogFile(slugDir);
      if (direct) { out.push({ name: null, logPath: direct, slug: slug.name }); continue; }
      let children = [];
      try {
        children = await fs.readdir(slugDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const logPath = await findLogFile(path.join(slugDir, child.name));
        if (logPath) out.push({ name: child.name, logPath, slug: slug.name });
      }
    }
    return out;
  }

  /**
   * Light head scan: one stat plus a bounded head window (64 KiB, 512 KiB only when the title is
   * still missing). Frames inside that window come for free, so the message count is scanned too.
   */
  async function scanHead(logPath) {
    const stat = await statOrNull(logPath);
    if (!stat || !stat.isFile()) return null;
    const windows = [Math.min(META_HEAD_BYTES, readCap)];
    if (readCap > META_HEAD_BYTES) windows.push(Math.min(META_HEAD_MAX_BYTES, readCap));
    let best = null;
    for (const limit of windows) {
      const read = await readFilePrefix(logPath, limit);
      if (!read) return best;
      const decoded = decodeFrames(read.buffer, { maxFrames: META_MAX_FRAMES, maxBytes: readCap });
      const info = headInfo(decoded.events);
      best = {
        size: read.size,
        scanned: read.buffer.length,
        truncatedBytes: read.truncatedBytes,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
        info,
        frames: decoded.frames,
        corruptFrames: decoded.corruptFrames,
        messages: renderMessages(decoded.events, config.transcriptMaxChars).length
      };
      if (info.session && info.title !== null) break;
      if (!read.truncatedBytes) break;
      if (limit >= readCap) break;
    }
    return best;
  }

  async function buildEntry(found, ctx) {
    const scan = await scanHead(found.logPath);
    if (!scan) return null;
    const key = normalizeSessionId(found.name) || normalizeSessionId(scan.info.session?.id);
    if (key === '') return null;
    const proj = (scan.info.session && scan.info.title !== null)
      ? null
      : await loadProjcache(home, ctx.projNames(found, key), log);
    const title = scan.info.title ?? proj?.title ?? '';
    const titleSource = scan.info.title !== null ? 'session/title' : (proj?.title ? 'projcache' : 'none');
    const cwd = scan.info.session?.cwd ?? proj?.cwd ?? null;
    const createdAt = scan.info.session?.createdAt ?? proj?.createdAt ?? isoOrNull(scan.birthtimeMs);
    const workspaceId = ctx.bySession.get(key) ?? (cwd ? (ctx.byPath.get(normalizePathKey(cwd)) ?? null) : null);
    // messages counts the messages inside the scan window only; messagesExact tells whether that
    // window covered the whole log (use transcript().total when an exact figure is needed).
    const meta = {
      sessionId: ctx.canonical.get(key) ?? withSessionPrefix(scan.info.session?.id ?? found.name ?? key),
      workspaceId,
      title,
      titleSource,
      cwd,
      createdAt,
      updatedAt: isoOrNull(scan.mtimeMs),
      sizeBytes: scan.size,
      archived: ctx.archived.has(key),
      messages: scan.messages,
      messagesExact: !scan.truncatedBytes && scan.corruptFrames === 0
    };
    return { key, slug: found.slug, logPath: found.logPath, meta, frames: scan.frames, corruptFrames: scan.corruptFrames };
  }

  async function buildIndex() {
    const registryValue = await registry();
    const workspaces = registryWorkspaces(registryValue);
    const bySession = new Map();
    const canonical = new Map();
    const byPath = new Map();
    for (const [wsId, workspace] of Object.entries(workspaces)) {
      for (const sid of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
        const key = normalizeSessionId(sid);
        if (key === '') continue;
        if (!bySession.has(key)) bySession.set(key, wsId);
        if (!canonical.has(key)) canonical.set(key, String(sid));
      }
      const pathKey = normalizePathKey(workspace?.path);
      if (pathKey !== '' && !byPath.has(pathKey)) byPath.set(pathKey, wsId);
    }
    const archived = new Set();
    const archivedIds = registryValue?.global?.archivedSessionIds;
    for (const sid of Array.isArray(archivedIds) ? archivedIds : []) {
      const key = normalizeSessionId(sid);
      if (key !== '') archived.add(key);
    }
    const excluded = resolveExcludedIds(config.excludeWorkspaces, workspaces);
    // A session directory is named either session-<uuid> or <uuid>, and the projection cache
    // has been seen to use both, so every spelling is tried.
    const projNames = (found, key) => {
      const names = [];
      for (const base of [found.name, canonical.get(key), key]) {
        if (!base) continue;
        names.push(base, stripSessionPrefix(base), withSessionPrefix(base));
      }
      return [...new Set(names.filter(Boolean))];
    };
    const ctx = { bySession, canonical, byPath, archived, projNames };
    const entries = [];
    const byKey = new Map();
    for (const found of await listSessionLogs()) {
      const entry = await buildEntry(found, ctx);
      if (!entry) continue;
      if (entry.meta.workspaceId && excluded.has(entry.meta.workspaceId)) continue;
      entries.push(entry);
      if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    }
    return { home, registry: registryValue, workspaces, excluded, entries, byKey };
  }

  /** Reuse a decoded transcript while the log file is unchanged and the cache entry is fresh. */
  function readTranscriptCache(key, chars, stat) {
    const hit = cache.transcripts.get(key);
    if (!hit) return null;
    const stale = Date.now() - hit.at >= DSH_VIEW_CACHE_MS
      || hit.chars !== chars
      || hit.size !== stat.size
      || hit.mtimeMs !== Math.trunc(stat.mtimeMs);
    if (stale) {
      cache.transcripts.delete(key);
      return null;
    }
    return hit;
  }

  function writeTranscriptCache(key, payload) {
    if (cache.transcripts.size >= 8) {
      const oldest = cache.transcripts.keys().next().value;
      cache.transcripts.delete(oldest);
    }
    cache.transcripts.set(key, { at: Date.now(), ...payload });
  }

  async function getIndex() {
    const now = Date.now();
    if (cache.index && now - cache.index.at < DSH_VIEW_CACHE_MS) return cache.index.value;
    if (cache.inflight) return cache.inflight;
    const inflight = buildIndex()
      .then((value) => {
        cache.index = { at: Date.now(), value };
        cache.lastScanAt = new Date().toISOString();
        return value;
      })
      .finally(() => { cache.inflight = null; });
    cache.inflight = inflight;
    return inflight;
  }

  function workspaceMatches(index, workspaceId, needle) {
    if (!workspaceId) return false;
    if (workspaceId.toLowerCase() === needle) return true;
    const workspace = index.workspaces[workspaceId];
    if (!workspace) return false;
    if (String(workspace.title ?? '').toLowerCase() === needle) return true;
    const pathKey = normalizePathKey(workspace.path);
    return pathKey !== '' && pathKey.toLowerCase() === needle;
  }

  /** Registered workspaces: { id, title, path, archived, sessions, lastActivityAt, createdAt, updatedAt }. */
  async function workspaces() {
    const index = await getIndex();
    const out = [];
    for (const [id, workspace] of Object.entries(index.workspaces)) {
      if (index.excluded.has(id)) continue;
      const mine = index.entries.filter((entry) => entry.meta.workspaceId === id);
      out.push({
        id,
        title: typeof workspace?.title === 'string' && workspace.title !== '' ? workspace.title : id,
        path: typeof workspace?.path === 'string' ? workspace.path : '',
        archived: false,
        sessions: mine.length,
        lastActivityAt: maxIso([workspace?.updatedAt, ...mine.map((entry) => entry.meta.updatedAt)]),
        createdAt: isoOrNull(workspace?.createdAt),
        updatedAt: isoOrNull(workspace?.updatedAt)
      });
    }
    out.sort((a, b) => {
      const left = a.lastActivityAt ? Date.parse(a.lastActivityAt) : NaN;
      const right = b.lastActivityAt ? Date.parse(b.lastActivityAt) : NaN;
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left;
      return String(a.title).localeCompare(String(b.title));
    });
    return out;
  }

  /**
   * Session metadata, newest activity first. workspace matches an id, a title or a path; query is a
   * case-insensitive substring of the title, id, cwd or workspace id.
   */
  async function sessions({ workspace, includeArchived = false, limit = 100, query } = {}) {
    const index = await getIndex();
    const wsNeedle = typeof workspace === 'string' && workspace.trim() !== '' ? workspace.trim().toLowerCase() : null;
    const needle = typeof query === 'string' && query.trim() !== '' ? query.trim().toLowerCase() : null;
    const list = [];
    for (const entry of index.entries) {
      const meta = entry.meta;
      if (!includeArchived && meta.archived) continue;
      if (wsNeedle && !workspaceMatches(index, meta.workspaceId, wsNeedle)) continue;
      if (needle && !matchesQuery(meta, needle)) continue;
      list.push(meta);
    }
    list.sort(compareByUpdatedDesc);
    return list.slice(0, toInt(limit, 100, { min: 0, max: 100000 })).map(cloneMeta);
  }

  /** One session meta (same shape as sessions() entries) or null. Prefixed and bare ids both work. */
  async function session(sessionId) {
    const key = requireSessionId(sessionId);
    const index = await getIndex();
    const entry = index.byKey.get(key);
    return entry ? cloneMeta(entry.meta) : null;
  }

  /**
   * Messages of one session: { session, total, messages, truncated, corruptFrames }.
   * limit defaults to 100 and is capped by cfg.transcriptMaxMessages. tail:true anchors the window
   * to the newest messages (offset then skips the newest ones); otherwise offset skips from the top.
   * maxChars defaults to cfg.transcriptMaxChars. Unknown sessions return an empty result with
   * session:null instead of throwing.
   */
  async function transcript(sessionId, { limit = 100, offset = 0, tail = false, maxChars } = {}) {
    const key = requireSessionId(sessionId);
    const index = await getIndex();
    const entry = index.byKey.get(key);
    if (!entry) return emptyTranscript();
    const chars = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
      ? Math.trunc(Number(maxChars))
      : config.transcriptMaxChars;
    let shots = [];
    let total = 0;
    let corruptFrames = 0;
    let byteLimited = false;
    const stat = await statOrNull(entry.logPath);
    const cached = stat ? readTranscriptCache(key, chars, stat) : null;
    if (cached) {
      shots = cached.messages;
      total = cached.total;
      corruptFrames = cached.corruptFrames;
      byteLimited = cached.byteLimited;
    } else {
      const read = await readFilePrefix(entry.logPath, readCap);
      if (!read) return { ...emptyTranscript(), session: cloneMeta(entry.meta) };
      const decoded = decodeFrames(read.buffer, { maxBytes: readCap });
      shots = renderMessages(decoded.events, chars);
      total = shots.length;
      corruptFrames = decoded.corruptFrames;
      byteLimited = read.truncatedBytes;
      writeTranscriptCache(key, { size: read.size, mtimeMs: Math.trunc(read.mtimeMs), chars, messages: shots, total, corruptFrames, byteLimited });
    }
    const cap = Math.min(toInt(limit, 100, { min: 0, max: 100000 }), config.transcriptMaxMessages);
    const skip = toInt(offset, 0, { min: 0 });
    let start;
    let end;
    if (tail === true) {
      end = Math.max(0, total - skip);
      start = Math.max(0, end - cap);
    } else {
      start = Math.min(skip, total);
      end = Math.min(total, start + cap);
    }
    return {
      session: cloneMeta(entry.meta),
      total,
      messages: shots.slice(start, end).map((message) => ({ ...message })),
      truncated: start > 0 || end < total || byteLimited,
      corruptFrames
    };
  }

  return { config, available, refresh, reconfigure, registry, workspaces, sessions, session, transcript, stats };
}
