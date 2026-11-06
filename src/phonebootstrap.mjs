// dsh-link 0.10 (B2/B4): the dshlink2: bootstrap profile.
//
// A phone cannot be given a usable credential through a channel it cannot yet authenticate, so the
// first contact is split from the long-lived identity:
//
//   dshlink2:<base64url(gzip(JSON))>
//
// The code pins the phone gateway's CA, carries a one-time bootstrap secret, and (when the hub has a
// phone frps) the complete visitor frpc config. On first connect the phone generates its own RSA
// keypair locally, sends only the public key through TLS verified against the pinned CA, and gets a
// per-phone client certificate back. From then on it authenticates with mutual TLS; no hub token is
// ever present on the phone.
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import {
  DSHLINK_VERSION, LinkError, badRequest, isPlainObject, newId, nowIso, randomToken
} from './util.mjs';
import { renderPhoneVisitorToml } from './phone.mjs';

export const PHONE_BOOTSTRAP_PREFIX = 'dshlink2:';
export const PHONE_BOOTSTRAP_VERSION = 2;
export const PHONE_BOOTSTRAP_KIND = 'dshlink-phone-v2';
export const PHONE_BOOTSTRAP_DEFAULT_BIND_PORT = 18790;
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const BOOTSTRAP_SECRET_PREFIX = 'pbs_';

function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function profileUrl(value, { https = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (https && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
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
 * The phone's frpc config. The phone is a pure visitor on the dedicated phone frps and reaches the
 * phone gateway at 127.0.0.1:<bindPort>. The gateway CA is pinned separately in the profile.
 */
export async function tunnelBundleFromPhoneFrp(cfg, { bindPort = PHONE_BOOTSTRAP_DEFAULT_BIND_PORT } = {}) {
  const frp = cfg?.phoneFrp ?? {};
  if (!frp.enabled || !pickString(frp.serverAddr) || !pickString(frp.provider?.secretKey)) return null;
  const port = Number(bindPort ?? frp.bindPort ?? PHONE_BOOTSTRAP_DEFAULT_BIND_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest('phone tunnel bindPort is invalid');
  const [cert, key, ca] = await Promise.all([readMaybe(frp.certFile), readMaybe(frp.keyFile), readMaybe(frp.trustedCaFile)]);
  const files = {};
  if (cert) files['client.crt'] = cert.toString('base64');
  if (key) files['client.key'] = key.toString('base64');
  if (ca) files['ca.crt'] = ca.toString('base64');
  const tls = frp.tls !== false;
  const frpc = renderPhoneVisitorToml({
    serverAddr: frp.serverAddr,
    serverPort: frp.serverPort ?? 7000,
    user: frp.user ?? 'dsh-link-phone',
    authToken: frp.token ?? '',
    tls,
    certFile: tls && files['client.crt'] ? '{{DIR}}/client.crt' : null,
    keyFile: tls && files['client.key'] ? '{{DIR}}/client.key' : null,
    trustedCaFile: tls && files['ca.crt'] ? '{{DIR}}/ca.crt' : null,
    serverName: frp.provider?.name ?? 'dshlink-phone',
    secretKey: frp.provider.secretKey,
    bindPort: port,
    name: 'phone-to-hub'
  });
  return { enabled: true, bindPort: port, frpc, files };
}

export function encodePhoneBootstrap(profile) {
  const json = Buffer.from(JSON.stringify(profile), 'utf8');
  return PHONE_BOOTSTRAP_PREFIX + zlib.gzipSync(json, { level: 9 }).toString('base64url');
}

function inflateProfile(body) {
  const raw = Buffer.from(body, 'base64url');
  if (!raw.length) throw badRequest('phone bootstrap code is empty');
  try {
    return JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  } catch {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw badRequest('phone bootstrap code is not valid dsh-link phone data');
    }
  }
}

function normalizeTunnel(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) throw badRequest('phone profile tunnel must be an object');
  const frpc = typeof raw.frpc === 'string' ? raw.frpc : '';
  if (!frpc.trim()) throw badRequest('phone profile tunnel has no frpc config');
  const bindPort = Number(raw.bindPort ?? PHONE_BOOTSTRAP_DEFAULT_BIND_PORT);
  if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) throw badRequest('phone profile tunnel bindPort is invalid');
  const files = {};
  for (const [name, value] of Object.entries(isPlainObject(raw.files) ? raw.files : {})) {
    if (typeof value === 'string') files[name] = value;
  }
  return { enabled: true, bindPort, frpc, files };
}

/** Decode a dshlink2: code (or the same JSON) without trusting anything in it beyond shape. */
export function decodePhoneBootstrap(code) {
  const text = String(code ?? '').trim();
  if (!text) throw badRequest('a phone bootstrap code is required');
  if (text.length > MAX_CODE_BYTES * 2) throw badRequest('phone bootstrap code is too large');
  let parsed;
  if (text.startsWith('{')) {
    try { parsed = JSON.parse(text); } catch { throw badRequest('phone profile file is not valid JSON'); }
  } else {
    const body = (text.startsWith(PHONE_BOOTSTRAP_PREFIX) ? text.slice(PHONE_BOOTSTRAP_PREFIX.length) : text).replace(/\s+/g, '');
    if (!body) throw badRequest('a phone bootstrap code is required');
    parsed = inflateProfile(body);
  }
  if (!isPlainObject(parsed) || parsed.kind !== PHONE_BOOTSTRAP_KIND) throw badRequest('not a dsh-link phone bootstrap profile');
  if (parsed.v !== PHONE_BOOTSTRAP_VERSION) throw badRequest('unsupported phone bootstrap version: ' + parsed.v);
  const entry = isPlainObject(parsed.entry) ? parsed.entry : {};
  const url = profileUrl(entry.url, { https: true });
  if (!url) throw badRequest('phone bootstrap profile has no usable https entry URL');
  const gateway = isPlainObject(parsed.gateway) ? parsed.gateway : {};
  const caPem = typeof gateway.caPem === 'string' ? gateway.caPem.trim() : '';
  if (!caPem.includes('BEGIN CERTIFICATE')) throw badRequest('phone bootstrap profile has no pinned CA certificate');
  const bootstrap = isPlainObject(parsed.bootstrap) ? parsed.bootstrap : {};
  const id = pickString(bootstrap.id);
  const secret = pickString(bootstrap.secret);
  if (!id || !secret) throw badRequest('phone bootstrap profile has no one-time bootstrap secret');
  if (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now()) {
    throw new LinkError(410, 'phone_bootstrap_expired', 'phone bootstrap code expired at ' + parsed.expiresAt);
  }
  return {
    v: PHONE_BOOTSTRAP_VERSION,
    kind: PHONE_BOOTSTRAP_KIND,
    software: 'dsh-link',
    softwareVersion: parsed.softwareVersion ?? null,
    label: String(parsed.label ?? 'phone').slice(0, 64),
    issuedAt: parsed.issuedAt ?? null,
    expiresAt: parsed.expiresAt ?? null,
    entry: { kind: 'phone-gateway', name: String(entry.name ?? '').slice(0, 64) || 'hub', url },
    gateway: { caPem, caFingerprint: pickString(gateway.caFingerprint) },
    bootstrap: { id, secret, expiresAt: bootstrap.expiresAt ?? parsed.expiresAt ?? null },
    tunnel: normalizeTunnel(parsed.tunnel),
    note: parsed.note ?? null
  };
}

/** What the console/CLI shows about a bootstrap profile: never includes the bootstrap secret. */
export function summarizePhoneBootstrap(profile) {
  return {
    label: profile.label,
    entry: profile.entry,
    expiresAt: profile.expiresAt,
    caFingerprint: profile.gateway?.caFingerprint ?? null,
    bootstrapId: profile.bootstrap?.id ?? null,
    hasTunnel: !!profile.tunnel,
    tunnelBindPort: profile.tunnel?.bindPort ?? null,
    softwareVersion: profile.softwareVersion
  };
}

/**
 * Mint a dshlink2: bootstrap profile for one phone. The caller owns cfg persistence; the returned
 * code carries the CA certificate (public), a one-time bootstrap secret and the visitor tunnel, but
 * never the CA private key, a device certificate, or a hub token.
 */
export async function buildPhoneBootstrap(cfg, ca, store, {
  label = 'phone',
  ttlHours = 2,
  maxUses = 1,
  bindPort = null,
  tunnel: withTunnel = true,
  url = null,
  note = null
} = {}) {
  const cleanLabel = String(label ?? 'phone').trim().slice(0, 64) || 'phone';
  const hours = ttlHours === null || ttlHours === undefined || ttlHours === '' ? 2 : Number(ttlHours);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) throw badRequest('ttlHours must be between 1 and 720');
  const explicitUrl = url ? profileUrl(url, { https: true }) : null;
  if (url && !explicitUrl) throw badRequest('an explicit phone gateway URL must be https');
  const tunnel = withTunnel ? await tunnelBundleFromPhoneFrp(cfg, { bindPort: bindPort ?? cfg.phoneFrp?.bindPort ?? PHONE_BOOTSTRAP_DEFAULT_BIND_PORT }) : null;
  if (!tunnel && !explicitUrl) {
    throw badRequest('this hub has no phone tunnel, so a dshlink2 profile needs an explicit --url reachable from the phone');
  }
  const port = Number(bindPort ?? tunnel?.bindPort ?? cfg.phoneFrp?.bindPort ?? PHONE_BOOTSTRAP_DEFAULT_BIND_PORT);
  const entryUrl = explicitUrl ?? 'https://127.0.0.1:' + port;
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  const secret = BOOTSTRAP_SECRET_PREFIX + randomToken(24);
  const bootstrap = await store.createPhoneBootstrap({
    label: cleanLabel,
    secret,
    expiresAt,
    maxUses: Math.max(1, Math.min(100, Number(maxUses) || 1)),
    note
  });
  const profile = {
    v: PHONE_BOOTSTRAP_VERSION,
    kind: PHONE_BOOTSTRAP_KIND,
    software: 'dsh-link',
    softwareVersion: DSHLINK_VERSION,
    label: cleanLabel,
    issuedAt: nowIso(),
    expiresAt,
    entry: { kind: 'phone-gateway', name: String(cfg.name ?? 'hub').slice(0, 64), url: entryUrl },
    gateway: { caPem: ca.caPem(), caFingerprint: ca.caFingerprint() },
    bootstrap: { id: bootstrap.id, secret, expiresAt },
    tunnel,
    note: note ?? null
  };
  return {
    code: encodePhoneBootstrap(profile),
    profile,
    summary: summarizePhoneBootstrap(profile),
    bootstrapId: bootstrap.id,
    expiresAt,
    tunnel: !!tunnel
  };
}
