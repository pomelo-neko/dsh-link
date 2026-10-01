// dsh-link-bridge: which local conversation asked on a thread.
//
// The topic pool answers one question — "where does a message on this topic go?" — and it always
// opens its sessions inside the bridge workspace. That is right for a conversation the peer
// starts, and wrong for the reverse case: a conversation in another workspace asks a peer
// something, the peer answers on the same thread, and the answer would wake a bridge session
// instead of the conversation that asked. This table remembers thread -> asking Session.
//
// It is filled from the DSH Host event bus (`tools/result` for the dsh-link send tools, whose
// execution carries the calling agent and its Session), so no argument has to be added to the send
// tools and the agent does not have to know its own session id.
//
// Everything here is pure: no ctx, no clock, no I/O, so the whole table is unit-testable.

export const ROUTE_DEFAULTS = {
  enabled: true,
  // Long enough to cover "ask a peer, the peer answers tomorrow", short enough to forget.
  ttlSeconds: 86400,
  max: 200
};

/** `link_send_message` / `link_reply`, with or without the `mcp__<server>__` prefix. */
const SEND_TOOL_RE = /(?:^|__)link_(?:send_message|reply)$/;

/** Message ids kept per route: enough for replyTo lookups and for diagnosing a route. */
const MAX_IDS_PER_ROUTE = 8;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function asNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Coerce the `routes` config block; an absent block keeps routing on with the defaults. */
export function normalizeRoutePolicy(raw = {}) {
  const source = asRecord(raw) ?? {};
  return {
    enabled: source.enabled !== false,
    ttlSeconds: Math.max(60, asNumber(source.ttlSeconds, ROUTE_DEFAULTS.ttlSeconds)),
    max: Math.max(1, Math.min(2000, asNumber(source.max, ROUTE_DEFAULTS.max)))
  };
}

/** True for the tool names whose result proves "this Session just sent a message on a thread". */
export function isSendTool(name) {
  return SEND_TOOL_RE.test(asText(name).trim());
}

/**
 * Pull the message the node created out of one tool result. A send answers with
 * `message <id> to <peer>: <state>` followed by the JSON record, so the record is read from the
 * text payload; `structuredContent` is honoured first in case a server sends one.
 * Falls back to the call's own `thread` argument, which is all a `link_reply` needs.
 */
export function sentMessageFromResult(result, args = {}) {
  const record = asRecord(result);
  const structured = asRecord(asRecord(record)?.structuredContent);
  let message = asRecord(structured?.message);
  if (!message) {
    const blocks = Array.isArray(record?.content) ? record.content : [];
    for (const block of blocks) {
      const text = asText(asRecord(block)?.text);
      const at = text.indexOf('\n\n{');
      if (at < 0) continue;
      try {
        const candidate = asRecord(asRecord(JSON.parse(text.slice(at + 2)))?.message);
        if (candidate) { message = candidate; break; }
      } catch { /* not the JSON payload */ }
    }
  }
  const id = asText(message?.id).trim();
  const thread = asText(message?.thread).trim() || asText(asRecord(args)?.thread).trim() || id;
  if (!thread) return null;
  return { id, thread };
}

function isValidEntry(entry) {
  const record = asRecord(entry);
  return Boolean(record) && asText(record.sessionId).trim().length > 0;
}

function expired(entry, settings, now) {
  return asNumber(asRecord(entry)?.lastAt, 0) + settings.ttlSeconds * 1000 < now;
}

/** Keep the table bounded by dropping the least recently used routes. */
function enforceCap(table, settings) {
  const keys = Object.keys(table);
  if (keys.length <= settings.max) return [];
  const ordered = keys
    .map((key) => ({ key, lastAt: asNumber(asRecord(table[key])?.lastAt, 0) }))
    .sort((a, b) => a.lastAt - b.lastAt);
  const drop = ordered.slice(0, keys.length - settings.max).map((item) => item.key);
  for (const key of drop) delete table[key];
  return drop;
}

/**
 * Remember that `sessionId` asked on `thread`. One session owns a thread at a time: a second
 * session sending on the same thread takes it over, so the newest asker gets the answer.
 * @returns the stored entry, or null when routing is off or the input is unusable.
 */
export function registerRoute(routes, { thread, messageId, sessionId, now = Date.now(), policy } = {}) {
  const settings = normalizeRoutePolicy(policy);
  const table = asRecord(routes);
  const key = asText(thread).trim();
  const session = asText(sessionId).trim();
  if (!settings.enabled || !table || !key || !session) return null;
  const previous = asRecord(table[key]);
  const entry = previous && asText(previous.sessionId).trim() === session
    ? previous
    : { thread: key, sessionId: session, messageIds: [], createdAt: now, hits: 0 };
  entry.thread = key;
  entry.sessionId = session;
  entry.lastAt = now;
  const id = asText(messageId).trim();
  if (id && !Array.isArray(entry.messageIds)) entry.messageIds = [id];
  else if (id && !entry.messageIds.includes(id)) entry.messageIds = [...entry.messageIds, id].slice(-MAX_IDS_PER_ROUTE);
  table[key] = entry;
  enforceCap(table, settings);
  return entry;
}

/**
 * Which Session should receive this inbound message? A live route on the message's thread wins;
 * otherwise the message is matched against the ids of the routes it answers (`replyTo`).
 * A hit refreshes the entry, so a long exchange does not expire mid-conversation.
 * @returns `{ sessionId, key, matched }` or null (callers then fall back to the topic pool).
 */
export function routeFor(routes, message, { now = Date.now(), policy } = {}) {
  const settings = normalizeRoutePolicy(policy);
  const table = asRecord(routes);
  const record = asRecord(message);
  if (!settings.enabled || !table || !record) return null;
  const hit = (key, entry, matched) => {
    entry.lastAt = now;
    entry.hits = asNumber(entry.hits, 0) + 1;
    return { sessionId: asText(entry.sessionId).trim(), key, matched };
  };
  const thread = asText(record.thread).trim();
  const direct = thread ? asRecord(table[thread]) : null;
  if (isValidEntry(direct) && !expired(direct, settings, now)) return hit(thread, direct, 'thread');
  const replyTo = asText(record.replyTo).trim();
  if (!replyTo) return null;
  for (const key of Object.keys(table)) {
    const entry = asRecord(table[key]);
    if (!isValidEntry(entry) || !Array.isArray(entry.messageIds) || !entry.messageIds.includes(replyTo)) continue;
    if (expired(entry, settings, now)) continue;
    return hit(asText(entry.thread).trim() || key, entry, 'replyTo');
  }
  return null;
}

/** Drop expired and malformed routes; called once per poll tick. */
export function sweepRoutes(routes, { now = Date.now(), policy } = {}) {
  const settings = normalizeRoutePolicy(policy);
  const table = asRecord(routes);
  if (!table) return { expired: 0, malformed: 0, overflow: 0 };
  let expiredCount = 0;
  let malformed = 0;
  for (const key of Object.keys(table)) {
    if (!isValidEntry(table[key])) { delete table[key]; malformed += 1; continue; }
    if (expired(table[key], settings, now)) { delete table[key]; expiredCount += 1; }
  }
  return { expired: expiredCount, malformed, overflow: enforceCap(table, settings).length };
}

/** Drop every route owned by a Session that turned out to be gone. */
export function forgetRoutesForSession(routes, sessionId) {
  const table = asRecord(routes);
  const id = asText(sessionId).trim();
  if (!table || !id) return 0;
  let removed = 0;
  for (const key of Object.keys(table)) {
    if (asText(asRecord(table[key])?.sessionId).trim() === id) { delete table[key]; removed += 1; }
  }
  return removed;
}

/** Compact view for state.json and the capability status call. */
export function routesSummary(routes, { now = Date.now(), policy } = {}) {
  const settings = normalizeRoutePolicy(policy);
  const table = asRecord(routes) ?? {};
  const live = Object.keys(table)
    .map((key) => asRecord(table[key]))
    .filter((entry) => isValidEntry(entry) && !expired(entry, settings, now));
  const last = live.slice().sort((a, b) => asNumber(b.lastAt, 0) - asNumber(a.lastAt, 0))[0] ?? null;
  return {
    enabled: settings.enabled,
    count: live.length,
    sessions: new Set(live.map((entry) => asText(entry.sessionId).trim())).size,
    ttlSeconds: settings.ttlSeconds,
    last: last
      ? { thread: asText(last.thread).trim(), sessionId: asText(last.sessionId).trim(), at: asNumber(last.lastAt, 0) }
      : null
  };
}
