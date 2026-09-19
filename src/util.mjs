// dsh-link: shared utilities (ids, hashing, auth compare, errors, JSON body I/O, globs).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DSHLINK_VERSION = '0.3.0';
export const API_PREFIX = '/api/v1';

export class LinkError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new LinkError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'missing or invalid token') => new LinkError(401, 'unauthorized', msg);
export const forbidden = (msg, details) => new LinkError(403, 'forbidden', msg, details);
export const notFound = (msg) => new LinkError(404, 'not_found', msg);
export const conflict = (msg, details) => new LinkError(409, 'conflict', msg, details);
export const tooLarge = (msg, details) => new LinkError(413, 'payload_too_large', msg, details);
export const upstream = (msg, details) => new LinkError(502, 'upstream_error', msg, details);

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Time-sortable id: <prefix>_<base32 ms>_<random> */
export function newId(prefix = 'msg') {
  let t = Date.now();
  let stamp = '';
  for (let i = 0; i < 10; i += 1) {
    stamp = ID_ALPHABET[t % 32] + stamp;
    t = Math.floor(t / 32);
  }
  return `${prefix}_${stamp}${randomBytes(6).toString('hex')}`;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
}

export function toInt(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function clampText(value, max) {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

/** Minimal glob -> RegExp. Supports **, *, ?. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i += 1; re += '.*'; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

export function matchesAnyGlob(globs, ...candidates) {
  for (const glob of globs) {
    const re = glob instanceof RegExp ? glob : globToRegExp(glob);
    for (const candidate of candidates) {
      if (candidate && re.test(candidate)) return true;
    }
  }
  return false;
}

export function createLogger(level = 'info') {
  const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const threshold = order[level] ?? 3;
  const emit = (name, stream, args) => {
    if ((order[name] ?? 3) > threshold) return;
    stream.write(`[${nowIso()}] ${name.toUpperCase()} ${args.map((a) =>
      typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}
`);
  };
  return {
    level,
    error: (...a) => emit('error', process.stderr, a),
    warn: (...a) => emit('warn', process.stderr, a),
    info: (...a) => emit('info', process.stdout, a),
    debug: (...a) => emit('debug', process.stdout, a)
  };
}

/** Parse CLI args: --key value | --key=value | --flag | -x ; returns {_: positionals, ...flags} */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        const key = body.slice(0, eq);
        pushFlag(out, key, body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { pushFlag(out, body, next); i += 1; }
        else pushFlag(out, body, true);
      }
    } else if (token.startsWith('-') && token.length > 1) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { pushFlag(out, key, next); i += 1; }
      else pushFlag(out, key, true);
    } else {
      out._.push(token);
    }
  }
  return out;
}

function pushFlag(out, key, value) {
  if (Object.prototype.hasOwnProperty.call(out, key)) {
    if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  } else {
    out[key] = value;
  }
}

export function flagList(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function flagString(value, fallback = undefined) {
  if (value === undefined || value === true || value === false) return fallback;
  if (Array.isArray(value)) return String(value[value.length - 1]);
  return String(value);
}

export function flagBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  const s = String(Array.isArray(value) ? value[value.length - 1] : value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AbortSignal that fires after ms. Unlike AbortSignal.timeout(), the timer is
 * unref'd so a pending timeout never keeps a finished process alive (Node asserts
 * in InternalCallbackScope if such timers are still pending at teardown).
 */
export function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  timer.unref?.();
  return controller.signal;
}
