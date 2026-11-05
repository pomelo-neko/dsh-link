// dsh-link 0.9: smartphone connect profiles.
//
// A phone cannot receive a node/hub token by enrolling like a node does, and it cannot be given
// the build-time frpc tunnel assets either (those embed this deployment's frps credentials). So the
// hub mints a single "connect profile" for one phone:
//
//   dshlink1:<base64url(gzip(JSON))>
//
// which carries the entry URL, a device token and — when the hub publishes itself over frps — the
// complete visitor frpc config plus the mutual-TLS files it needs. The Android app imports this
// string (or the same JSON as a file) and writes the tunnel files into its private storage, which
// keeps the APK itself free of any secret.
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import {
  DSHLINK_VERSION, LinkError, badRequest, isPlainObject, nowIso
} from './util.mjs';
import { createHubToken } from './hubconfig.mjs';

export const PHONE_INVITE_PREFIX = 'dshlink1:';
export const PHONE_INVITE_VERSION = 1;
export const PHONE_KIND = 'dshlink-phone';
export const PHONE_TUNNEL_BIND_PORT = 18790;
const MAX_CODE_BYTES = 1024 * 1024;

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

/** frpc accepts both separators; forward slashes keep generated TOML readable. */
function tomlPath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function profileUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Render the frpc config a phone needs: one STCP visitor to the hub's provider, no proxies and no
 * web admin port (the phone only dials out).
 */
export function renderPhoneVisitorToml({
  serverAddr,
  serverPort = 7000,
  user = 'dsh-link',
  authToken = '',
  tls = true,
  certFile = null,
  keyFile = null,
  trustedCaFile = null,
  serverName = 'dshlink-hub',
  secretKey,
  bindPort = PHONE_TUNNEL_BIND_PORT,
  name = 'phone-to-hub'
} = {}) {
  if (!pickString(serverAddr)) throw badRequest('a phone tunnel needs the frps serverAddr');
  if (!pickString(secretKey)) throw badRequest('a phone tunnel needs the STCP provider secretKey');
  const lines = [
    'serverAddr = ' + tomlString(serverAddr),
    'serverPort = ' + Number(serverPort ?? 7000),
    'user = ' + tomlString(user ?? 'dsh-link'),
    'loginFailExit = false',
    '',
    'auth.token = ' + tomlString(authToken ?? ''),
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    '',
    'transport.tls.enable = ' + (tls !== false)
  ];
  if (tls !== false) {
    lines.push('transport.tls.disableCustomTLSFirstByte = false');
    if (certFile) lines.push('transport.tls.certFile = ' + tomlString(tomlPath(certFile)));
    if (keyFile) lines.push('transport.tls.keyFile = ' + tomlString(tomlPath(keyFile)));
    if (trustedCaFile) lines.push('transport.tls.trustedCaFile = ' + tomlString(tomlPath(trustedCaFile)));
  }
  lines.push(
    '',
    '[[visitors]]',
    'name = ' + tomlString(name),
    'type = "stcp"',
    'serverName = ' + tomlString(serverName),
    'secretKey = ' + tomlString(secretKey),
    'bindAddr = "127.0.0.1"',
    'bindPort = ' + Number(bindPort),
    'transport.useEncryption = true',
    'transport.useCompression = false'
  );
  return lines.join('\n') + '\n';
}

async function readMaybe(file) {
  if (!file) return null;
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/**
 * Build the tunnel half of a profile from a hub config. Returns null when the hub has no frps
 * (then the phone can only connect over a directly reachable URL).
 */
export async function tunnelBundleFromHubConfig(cfg, { visitorPort = PHONE_TUNNEL_BIND_PORT } = {}) {
  const frp = cfg?.frp ?? {};
  if (!frp.enabled || !pickString(frp.serverAddr) || !pickString(frp.provider?.secretKey)) return null;
  const [cert, key, ca] = await Promise.all([readMaybe(frp.certFile), readMaybe(frp.keyFile), readMaybe(frp.trustedCaFile)]);
  const files = {};
  if (cert) files['client.crt'] = cert.toString('base64');
  if (key) files['client.key'] = key.toString('base64');
  if (ca) files['ca.crt'] = ca.toString('base64');
  const tls = frp.tls !== false;
  const frpc = renderPhoneVisitorToml({
    serverAddr: frp.serverAddr,
    serverPort: frp.serverPort ?? 7000,
    user: frp.user ?? 'dsh-link',
    authToken: frp.token ?? '',
    tls,
    certFile: tls && files['client.crt'] ? '{{DIR}}/client.crt' : null,
    keyFile: tls && files['client.key'] ? '{{DIR}}/client.key' : null,
    trustedCaFile: tls && files['ca.crt'] ? '{{DIR}}/ca.crt' : null,
    serverName: frp.provider?.name ?? 'dshlink-hub',
    secretKey: frp.provider.secretKey,
    bindPort: visitorPort
  });
  return { enabled: true, bindPort: Number(visitorPort), frpc, files };
}

export function encodePhoneCode(profile) {
  const json = Buffer.from(JSON.stringify(profile), 'utf8');
  return PHONE_INVITE_PREFIX + zlib.gzipSync(json, { level: 9 }).toString('base64url');
}

function inflateProfile(body) {
  const raw = Buffer.from(body, 'base64url');
  if (!raw.length) throw badRequest('phone connect code is empty');
  try {
    return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch {
    // Tolerate a plain base64url(JSON) code from older tooling.
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw badRequest('phone connect code is not valid dsh-link phone data');
    }
  }
}

function normalizeTunnel(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw badRequest('phone profile tunnel must be an object');
  const frpc = typeof raw.frpc === 'string' ? raw.frpc : '';
  if (!frpc.trim()) throw badRequest('phone profile tunnel has no frpc config');
  const bindPort = Number(raw.bindPort ?? PHONE_TUNNEL_BIND_PORT);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) throw badRequest('phone profile tunnel bindPort is invalid');
  const files = {};
  for (const [name, value] of Object.entries(isPlainObject(raw.files) ? raw.files : {})) {
    if (typeof value !== 'string') continue;
    files[name] = value;
  }
  return { enabled: true, bindPort, frpc, files };
}

/** Decode a connect code OR a plain JSON profile (both are accepted by the app's file import). */
export function decodePhoneInvite(code) {
  const text = String(code ?? '').trim();
  if (!text) throw badRequest('a phone connect code is required');
  if (text.length > MAX_CODE_BYTES * 2) throw badRequest('phone connect code is too large');
  let parsed;
  if (text.startsWith('{')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw badRequest('phone profile file is not valid JSON');
    }
  } else {
    const body = (text.startsWith(PHONE_INVITE_PREFIX) ? text.slice(PHONE_INVITE_PREFIX.length) : text).replace(/\s+/g, '');
    if (!body) throw badRequest('a phone connect code is required');
    parsed = inflateProfile(body);
  }
  if (!isPlainObject(parsed) || parsed.kind !== PHONE_KIND) throw badRequest('not a dsh-link phone profile');
  if (parsed.v !== PHONE_INVITE_VERSION) throw badRequest('unsupported phone profile version: ' + parsed.v);
  const entry = isPlainObject(parsed.entry) ? parsed.entry : {};
  const kind = entry.kind === 'node' ? 'node' : 'hub';
  const url = profileUrl(entry.url);
  if (!url) throw badRequest('phone profile has no usable entry URL');
  const token = pickString(parsed.token);
  if (!token) throw badRequest('phone profile has no device token');
  if (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now()) {
    throw new LinkError(410, 'phone_invite_expired', 'phone connect code expired at ' + parsed.expiresAt);
  }
  return {
    v: PHONE_INVITE_VERSION,
    kind: PHONE_KIND,
    software: 'dsh-link',
    softwareVersion: parsed.softwareVersion ?? null,
    label: String(parsed.label ?? 'phone').slice(0, 64),
    issuedAt: parsed.issuedAt ?? null,
    expiresAt: parsed.expiresAt ?? null,
    entry: { kind, name: String(entry.name ?? '').slice(0, 64) || 'hub', url },
    token,
    tokenId: parsed.tokenId ?? null,
    tunnel: normalizeTunnel(parsed.tunnel),
    note: parsed.note ?? null
  };
}

/** What the console/CLI shows about a profile: never includes the token. */
export function summarizePhoneProfile(profile) {
  return {
    label: profile.label,
    entry: profile.entry,
    expiresAt: profile.expiresAt,
    hasTunnel: !!profile.tunnel,
    tunnelBindPort: profile.tunnel?.bindPort ?? null,
    tokenId: profile.tokenId,
    softwareVersion: profile.softwareVersion
  };
}

/**
 * Mint a phone connect profile for a hub: creates a device token and, when the hub publishes over
 * frps, embeds the whole visitor tunnel. The caller owns cfg persistence (saveConfig/saveHubConfig).
 */
export async function buildHubPhoneInvite(cfg, {
  label = 'phone',
  ttlHours = 2,
  maxUses = null,
  visitorPort = PHONE_TUNNEL_BIND_PORT,
  tunnel: withTunnel = true,
  url = null,
  note = null
} = {}) {
  const cleanLabel = String(label ?? 'phone').trim().slice(0, 64) || 'phone';
  const hours = ttlHours === null || ttlHours === undefined || ttlHours === '' ? 0 : Number(ttlHours);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) throw badRequest('ttlHours must be between 0 and 8760');
  const explicitUrl = url ? profileUrl(url) : null;
  if (url && !explicitUrl) throw badRequest('an explicit phone URL must be http(s)');
  const tunnel = withTunnel ? await tunnelBundleFromHubConfig(cfg, { visitorPort }) : null;
  if (!tunnel && !explicitUrl) {
    throw badRequest('this hub has no frp tunnel, so a phone profile needs an explicit --url reachable from the phone');
  }
  const entryUrl = explicitUrl ?? 'http://127.0.0.1:' + Number(visitorPort);
  const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
  const created = createHubToken(cfg, cleanLabel, {
    role: 'device',
    expiresAt: expiresAt ?? undefined,
    maxUses: maxUses ?? null
  });
  const profile = {
    v: PHONE_INVITE_VERSION,
    kind: PHONE_KIND,
    software: 'dsh-link',
    softwareVersion: DSHLINK_VERSION,
    label: cleanLabel,
    issuedAt: nowIso(),
    expiresAt,
    entry: { kind: 'hub', name: String(cfg.name ?? 'hub').slice(0, 64), url: entryUrl },
    token: created.token,
    tokenId: created.id,
    tunnel,
    note: note ?? null
  };
  return {
    code: encodePhoneCode(profile),
    profile,
    summary: summarizePhoneProfile(profile),
    tokenId: created.id,
    expiresAt,
    tunnel: !!tunnel
  };
}
