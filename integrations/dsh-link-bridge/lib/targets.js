// dsh-link-bridge: directed-session policy for inbound messages (v0.4).
//
// A peer can address a message to one specific DSH Session on this machine by putting a
// session id in the envelope's `targetSession` field (or `meta.targetSession`, which older
// senders can fill without touching the protocol). The node transports the field untouched;
// this module decides whether the local bridge is allowed to wake that Session.
//
// The policy is deliberately explicit-by-default and closed for wildcards only when asked:
//   targets.enabled: true    turn directed delivery off entirely with false
//   targets.peers:   []      empty = any configured peer may direct a session; otherwise glob list
//   targets.allow:   []      empty = any existing session may be targeted; otherwise glob list
//   targets.deny:    []      glob list evaluated before allow (a deny always wins)
//
// Pure functions, no I/O: the bridge owns the clock, the HTTP calls and the state file.
export const TARGET_DEFAULTS = { enabled: true, peers: [], allow: [], deny: [] };

/** Longest session reference worth accepting on the wire. */
export const TARGET_SESSION_MAX = 200;

/** Session ids are opaque to the bridge, but they must stay one clean path/JSON-safe token. */
export const TARGET_SESSION_RE = /^[A-Za-z0-9._:-]{1,200}$/;

function asText(value) {
  return typeof value === 'string' ? value : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function cleanList(value) {
  return asArray(value).map((item) => asText(item).trim()).filter(Boolean);
}

/** Merge user config over the defaults; malformed values fall back to the permissive defaults. */
export function normalizeTargetPolicy(raw = {}) {
  const source = asRecord(raw) || {};
  return {
    enabled: source.enabled !== false,
    peers: cleanList(source.peers),
    allow: cleanList(source.allow),
    deny: cleanList(source.deny)
  };
}

/** The session the sender asked for, or an empty string. */
export function resolveTarget(message) {
  const record = asRecord(message);
  if (!record) return '';
  const direct = asText(record.targetSession).trim();
  if (direct) return direct.slice(0, TARGET_SESSION_MAX);
  const meta = asRecord(record.meta);
  const nested = meta ? asText(meta.targetSession).trim() : '';
  return nested.slice(0, TARGET_SESSION_MAX);
}

/** Small glob matcher (*, ?, **) so this plugin keeps zero runtime dependencies. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[\\\\^$+.()|[\]{}]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function matchesAny(globs, value) {
  const text = asText(value).trim();
  if (!text) return false;
  for (const glob of globs) {
    if (globToRegExp(glob).test(text)) return true;
  }
  return false;
}

/** The peer name that sent a message (both envelope shapes are accepted). */
export function messagePeer(message) {
  const record = asRecord(message);
  if (!record) return '';
  const from = asRecord(record.from) ? record.from : null;
  return asText((from && from.name) || record.from).trim();
}

/**
 * Decide whether this message may be delivered into the session it names.
 * @returns {{ok: boolean, sessionId: string, reason: string}}
 */
export function authorizeTarget(policy, message) {
  const settings = normalizeTargetPolicy(policy);
  const sessionId = resolveTarget(message);
  if (!sessionId) return { ok: false, sessionId: '', reason: '消息没有指定 targetSession' };
  if (!settings.enabled) return { ok: false, sessionId, reason: '本机关闭了定向投递（targets.enabled: false）' };
  if (!TARGET_SESSION_RE.test(sessionId)) return { ok: false, sessionId, reason: 'targetSession 不是合法的会话 id' };
  const peer = messagePeer(message);
  if (settings.peers.length && !matchesAny(settings.peers, peer)) {
    return { ok: false, sessionId, reason: '发送方 ' + (peer || '(未知)') + ' 不在 targets.peers 允许清单里' };
  }
  if (matchesAny(settings.deny, sessionId)) {
    return { ok: false, sessionId, reason: '会话 ' + sessionId + ' 命中 targets.deny' };
  }
  if (settings.allow.length && !matchesAny(settings.allow, sessionId)) {
    return { ok: false, sessionId, reason: '会话 ' + sessionId + ' 不在 targets.allow 允许清单里' };
  }
  return { ok: true, sessionId, reason: 'allowed' };
}

/** Compact view of the policy for state.json / logs. */
export function targetsSummary(policy) {
  const settings = normalizeTargetPolicy(policy);
  return {
    enabled: settings.enabled,
    peers: settings.peers,
    allow: settings.allow,
    deny: settings.deny,
    open: settings.enabled && settings.peers.length === 0 && settings.allow.length === 0 && settings.deny.length === 0
  };
}
