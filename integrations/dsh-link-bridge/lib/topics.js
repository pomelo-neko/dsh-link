// dsh-link-bridge topic policy: which Session should a batch of inbound messages go to?
//
// The bridge used to reuse one session (runtime.sessionId) for everything, so unrelated topics
// piled up in the same context. This module is the pure decision half of the fix: it keeps one
// entry per topic in a "pool", reuses the session that topic already owns until a budget (wakes,
// age, idle time) runs out, and then tells the caller to open a fresh session and archive the old
// one. A periodic sweep retires topics that went quiet and caps the pool.
//
// Nothing here touches ctx, the network or the wall clock: the pool and the current time are plain
// values handed in by the caller, so every branch is deterministic and testable. Zero dependencies.

/** Default topic policy. All *Seconds values are seconds; counters are plain counts. */
export const TOPIC_DEFAULTS = {
  strategy: 'auto',
  maxSessionWakes: 12,
  maxSessionAgeSeconds: 43200,
  topicIdleResetSeconds: 21600,
  archiveIdleSeconds: 86400,
  maxPoolSize: 20
};

/** Accepted strategy values; an unknown one falls back to 'auto'. */
const STRATEGIES = new Set(['auto', 'thread', 'subject']);

/** Longest topic component kept inside a pool key (a "subject" can be a whole paragraph). */
const MAX_TOPIC_CHARS = 120;

/** Longest human-readable label: longer titles are cut here and marked with an ellipsis. */
const MAX_LABEL_CHARS = 60;

/**
 * Reply/forward markers peeled off the front of a subject, ASCII and CJK, each with an optional
 * counter ("Re[2]:", "Re(2):", "Re 2:"). It is applied repeatedly, because a real chain looks
 * like "Re: Fwd: Re[2]: x" and all of those are the same topic.
 */
const SUBJECT_PREFIX = /^\s*(?:(?:re|fwd?|fw|aw|sv)(?:\s*[(\[（]?\s*\d+\s*[)\]）]?)?\s*[:：]|(?:回复|答复|回覆|回信|转发|轉發|轉寄|转寄)(?:\s*[(\[（]?\s*\d+\s*[)\]）]?)?\s*[:：])\s*/i;

/** Text fields arrive from JSON, from another machine's bridge, or from a test: accept strings. */
function asText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Read a numeric field, falling back when it is missing or not a finite number. */
function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Plain-object guard: arrays, null and scalars are not records. */
function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** A finite number >= 0 wins (0 is meaningful: "rotate/archive immediately"); else the default. */
function nonNegative(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/**
 * Merge user configuration over TOPIC_DEFAULTS. Malformed values (NaN, negative, a stray string)
 * fall back to their default: a bad cordis.patch.yml must not be able to make the bridge throw or
 * behave unpredictably.
 * @param raw - topic config, usually straight from the plugin config.
 */
export function normalizeTopicPolicy(raw = {}) {
  const source = asRecord(raw) ?? {};
  const strategy = asText(source.strategy).trim().toLowerCase();
  return {
    strategy: STRATEGIES.has(strategy) ? strategy : TOPIC_DEFAULTS.strategy,
    maxSessionWakes: Math.floor(nonNegative(source.maxSessionWakes, TOPIC_DEFAULTS.maxSessionWakes)),
    maxSessionAgeSeconds: nonNegative(source.maxSessionAgeSeconds, TOPIC_DEFAULTS.maxSessionAgeSeconds),
    topicIdleResetSeconds: nonNegative(source.topicIdleResetSeconds, TOPIC_DEFAULTS.topicIdleResetSeconds),
    archiveIdleSeconds: nonNegative(source.archiveIdleSeconds, TOPIC_DEFAULTS.archiveIdleSeconds),
    maxPoolSize: Math.floor(nonNegative(source.maxPoolSize, TOPIC_DEFAULTS.maxPoolSize))
  };
}

/**
 * Strip repeated reply/forward prefixes from a subject and trim what is left.
 * "Re: Re: 你好" -> "你好"; "答复：x" -> "x"; "Re[2]: z" -> "z"; "" -> "".
 * @param subject - raw subject field (any type; anything unusable becomes '').
 */
export function normalizeSubject(subject) {
  let text = asText(subject).trim();
  // Bounded: a subject made of 100 nested prefixes is pathological, not worth an endless loop.
  for (let round = 0; round < 16; round += 1) {
    const next = text.replace(SUBJECT_PREFIX, '');
    if (next === text) break;
    text = next.trim();
  }
  return text;
}

/** Sender name of a message, tolerating both "from: {name}" and "from: 'PEER'". */
function peerNameOf(message) {
  const record = asRecord(message);
  const from = record ? record.from : null;
  if (asRecord(from)) return asText(from.name) || asText(from.nodeId);
  return asText(from);
}

/** Collapse whitespace and bound the topic part of a key so one huge subject cannot bloat state. */
function topicPartOf(subject) {
  const flat = subject.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TOPIC_CHARS ? flat.slice(0, MAX_TOPIC_CHARS) : flat;
}

/** First non-empty line of a body; used when a message carries no subject. */
function firstLineOf(body) {
  for (const line of asText(body).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Stable pool key for a message.
 *   thread  - the thread field when present, else the subject, else the message id
 *   subject - peer + normalized subject, else the message id
 *   auto    - thread:<id> if threaded, else topic:<peer>/<subject>, else msg:<id>
 * The "auto" form is what makes one Re: chain land on one topic: the subject is normalized first,
 * so "Re: x", "Re[2]: Re: x" and "x" all produce the same key.
 * @param message - inbound message record.
 * @param policy - topic policy (raw config or a normalizeTopicPolicy result).
 */
export function topicKeyFor(message, policy) {
  const settings = normalizeTopicPolicy(policy);
  const record = asRecord(message);
  const thread = asText(record ? record.thread : '').trim();
  const subject = normalizeSubject(record ? record.subject : '');
  const id = asText(record ? record.id : '').trim();
  const topic = () => 'topic:' + peerNameOf(message) + '/' + topicPartOf(subject);
  const byId = () => 'msg:' + (id || 'unknown');

  if (settings.strategy === 'thread') {
    if (thread) return 'thread:' + thread;
    return subject ? topic() : byId();
  }
  if (settings.strategy === 'subject') return subject ? topic() : byId();
  if (thread) return 'thread:' + thread;
  return subject ? topic() : byId();
}

/**
 * Human-readable title for a topic: "<peer>: <subject>", or the first non-empty body line when
 * there is no subject. The subject is normalized first, so a reply is labelled like its root.
 * Titles longer than 60 characters are cut and marked with an ellipsis.
 * @param message - inbound message record.
 */
export function topicLabel(message) {
  const record = asRecord(message);
  if (!record) return '';
  const peer = peerNameOf(message);
  const subject = normalizeSubject(record.subject);
  const text = (subject || firstLineOf(record.body)).replace(/\s+/g, ' ').trim() || asText(record.id) || 'untitled';
  const head = peer ? peer + ': ' + text : text;
  return head.length > MAX_LABEL_CHARS ? head.slice(0, MAX_LABEL_CHARS) + '…' : head;
}

/**
 * Ask the caller's existence probe whether a recorded session is still there. Only an explicit
 * false means "gone": an absent callback, an undefined answer, a thenable or a probe that throws
 * all count as "exists", because a wrong "missing" would churn sessions on every message.
 */
function sessionExists(exists, sessionId) {
  if (typeof exists !== 'function') return true;
  try {
    return exists(sessionId) !== false;
  } catch {
    return true;
  }
}

/** Archive record handed back to the caller for one retired session. */
function archived(key, sessionId, reason) {
  return { key, sessionId, reason };
}

/**
 * Decide the session for one topic, without changing anything.
 *
 * Reasons, checked in this order:
 *   new-topic   the pool has no entry for this key
 *   archived    the topic was already retired, so it starts over with a fresh session
 *   missing     no sessionId recorded, or exists() said the session is gone
 *   idle-reset  the topic slept longer than topicIdleResetSeconds
 *   wake-budget the session already served maxSessionWakes wakes
 *   session-age the session is older than maxSessionAgeSeconds
 *   reuse       none of the above: keep the session this topic already owns
 *
 * Only 'reuse' carries a sessionId; every 'create' leaves it null and names the session to archive
 * in the returned archive list. The caller opens the new session and then calls recordUse(), which
 * is what moves the counters. A missing or malformed timestamp counts as "just used", so a
 * hand-edited entry reuses its session instead of thrashing.
 *
 * @param args.pool - the topic pool (plain object); never written to.
 * @param args.key - key from topicKeyFor().
 * @param args.label - the label the caller will record with recordUse(); not used by the decision.
 * @param args.now - fixed clock in ms (only an unusable value falls back to Date.now()).
 * @param args.policy - topic policy (raw config or normalized).
 * @param args.exists - optional sync probe: sessionId => false when the session is gone.
 * @returns {{action:'reuse'|'create', sessionId:string|null, reason:string,
 *   archive:{key:string,sessionId:string,reason:string}[], entry:object|null}}
 */
export function planSession({ pool, key, label, now, policy, exists } = {}) {
  const settings = normalizeTopicPolicy(policy);
  const at = asNumber(now, Date.now());
  const topicKey = asText(key);
  const store = asRecord(pool) ?? {};
  const entry = asRecord(store[topicKey]);

  if (!entry) return { action: 'create', sessionId: null, reason: 'new-topic', archive: [], entry: null };
  if (entry.archived === true) return { action: 'create', sessionId: null, reason: 'archived', archive: [], entry };

  const sessionId = asText(entry.sessionId);
  if (!sessionId || !sessionExists(exists, sessionId)) {
    return { action: 'create', sessionId: null, reason: 'missing', archive: [], entry };
  }

  const lastUsedAt = asNumber(entry.lastUsedAt, at);
  const createdAt = asNumber(entry.createdAt, at);
  const wakes = Math.max(0, Math.floor(asNumber(entry.wakes, 0)));

  if (at - lastUsedAt > settings.topicIdleResetSeconds * 1000) {
    return { action: 'create', sessionId: null, reason: 'idle-reset', archive: [archived(topicKey, sessionId, 'idle-reset')], entry };
  }
  if (wakes >= settings.maxSessionWakes) {
    return { action: 'create', sessionId: null, reason: 'wake-budget', archive: [archived(topicKey, sessionId, 'wake-budget')], entry };
  }
  if (at - createdAt > settings.maxSessionAgeSeconds * 1000) {
    return { action: 'create', sessionId: null, reason: 'session-age', archive: [archived(topicKey, sessionId, 'session-age')], entry };
  }
  return { action: 'reuse', sessionId, reason: 'reuse', archive: [], entry };
}

/**
 * Record that one topic just used one session: updates the pool in place and returns the entry.
 * The entry always has the canonical shape (sessionId, wakes, createdAt, lastUsedAt, label,
 * archived) and drops anything else the previous entry carried; the previous entry object is
 * replaced, so callers must use the returned value rather than a stale reference.
 *
 * The session's own clocks are kept while the same sessionId is re-recorded; a different id means
 * the caller rotated the session, so the wake budget and the age clock start over. A previously
 * archived topic is live again as soon as a session is recorded for it.
 *
 * @param pool - the topic pool (updated in place; a non-object pool is left alone).
 * @param key - key from topicKeyFor().
 * @param args.sessionId - session that handled the messages.
 * @param args.label - human title from topicLabel(); the previous label is kept when omitted.
 * @param args.now - fixed clock in ms.
 * @param args.messages - how many messages this wake carried (default 1, like state.notified).
 * @returns the entry stored in the pool.
 */
export function recordUse(pool, key, { sessionId, label, now, messages = 1 } = {}) {
  const topicKey = asText(key);
  const at = asNumber(now, Date.now());
  const id = asText(sessionId);
  const count = Math.max(0, Math.floor(asNumber(messages, 1)));
  const store = asRecord(pool);
  const previous = asRecord(store ? store[topicKey] : null);
  const continuing = Boolean(previous) && asText(previous.sessionId) === id;
  const entry = {
    sessionId: id,
    wakes: (continuing ? Math.max(0, Math.floor(asNumber(previous.wakes, 0))) : 0) + count,
    createdAt: continuing ? asNumber(previous.createdAt, at) : at,
    lastUsedAt: at,
    label: asText(label) || (previous ? asText(previous.label) : ''),
    archived: false
  };
  if (!store) return entry;
  store[topicKey] = entry;
  return entry;
}

/**
 * Retire quiet topics and keep the pool bounded. Updates the pool in place; the caller archives
 * the sessions named in the returned archive list.
 *
 *   archive-idle  a topic idle for archiveIdleSeconds is marked archived (reason 'archive-idle');
 *                 it stays in the pool, so the next message on it reuses the key but gets a new
 *                 session, and it is forgotten only after two more archive windows.
 *   drop          an entry archived at least 2 * archiveIdleSeconds ago is removed from the pool.
 *   pool-cap      with more than maxPoolSize keys the oldest topics are archived and dropped
 *                 (reason 'pool-cap') until the pool fits again.
 *
 * A topic whose lastUsedAt is exactly the current time is in use right now and is never archived
 * or evicted, so a pool made only of in-use topics may stay above the cap for one sweep.
 *
 * @param args.pool - the topic pool (updated in place).
 * @param args.now - fixed clock in ms.
 * @param args.policy - topic policy (raw config or normalized).
 * @returns {{archive:{key:string,sessionId:string,reason:string}[], drop:string[]}}
 */
export function sweepPool({ pool, now, policy } = {}) {
  const settings = normalizeTopicPolicy(policy);
  const at = asNumber(now, Date.now());
  const archive = [];
  const drop = [];
  const store = asRecord(pool);
  if (!store) return { archive, drop };

  const idleMs = settings.archiveIdleSeconds * 1000;
  const forgottenMs = idleMs * 2;

  // 1) Archive what went quiet. An entry used at exactly this instant is in use: hands off.
  for (const key of Object.keys(store)) {
    const entry = asRecord(store[key]);
    if (!entry || entry.archived === true || entry.lastUsedAt === at) continue;
    const sessionId = asText(entry.sessionId);
    if (!sessionId) continue;
    const lastUsedAt = asNumber(entry.lastUsedAt, 0);
    if (at - lastUsedAt < idleMs) continue;
    entry.archived = true;
    entry.archivedAt = at;
    archive.push(archived(key, sessionId, 'archive-idle'));
  }

  // 2) Forget archived topics once the archive window has passed twice.
  for (const key of Object.keys(store)) {
    const entry = asRecord(store[key]);
    if (!entry || entry.archived !== true) continue;
    const archivedAt = asNumber(entry.archivedAt, asNumber(entry.lastUsedAt, at));
    if (at - archivedAt < forgottenMs) continue;
    delete store[key];
    drop.push(key);
  }

  // 3) Cap the pool: oldest first, never the topics that are in use right now.
  let size = Object.keys(store).length;
  if (size > settings.maxPoolSize) {
    const oldest = Object.keys(store)
      .map((key) => ({ key, entry: asRecord(store[key]) }))
      .filter(({ entry }) => entry && entry.lastUsedAt !== at)
      .sort((left, right) => asNumber(left.entry.lastUsedAt, 0) - asNumber(right.entry.lastUsedAt, 0));
    for (const { key, entry } of oldest) {
      if (size <= settings.maxPoolSize) break;
      const sessionId = asText(entry.sessionId);
      if (sessionId) archive.push(archived(key, sessionId, 'pool-cap'));
      delete store[key];
      drop.push(key);
      size -= 1;
    }
  }
  return { archive, drop };
}

/**
 * Small, JSON-safe view of the pool for state.json: one record per topic with the session in use,
 * how many wakes it has served, when it was created and last used, its label and whether it is
 * archived.
 * @param pool - the topic pool.
 */
export function poolSummary(pool) {
  const out = {};
  const store = asRecord(pool);
  if (!store) return out;
  for (const key of Object.keys(store)) {
    const entry = asRecord(store[key]);
    if (!entry) continue;
    out[key] = {
      sessionId: asText(entry.sessionId),
      wakes: Math.max(0, Math.floor(asNumber(entry.wakes, 0))),
      createdAt: asNumber(entry.createdAt, 0),
      lastUsedAt: asNumber(entry.lastUsedAt, 0),
      archived: entry.archived === true,
      label: asText(entry.label)
    };
  }
  return out;
}
