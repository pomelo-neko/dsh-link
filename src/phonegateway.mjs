// dsh-link 0.10 (B2): the phone gateway.
//
// A loopback-only HTTPS listener that terminates mutual TLS for phones and reverse-proxies the
// mobile control surface of the hub. The phone never holds a hub token: the gateway injects a
// local, device-role token after it has verified the phone's client certificate. Every phone gets
// its own certificate from the hub phone CA, so revoking one phone is a local registry update.
//
// The only unauthenticated route is POST /api/v1/phone/bootstrap, which exchanges a one-time
// bootstrap secret (minted by "dshlink hub phone bootstrap") for a client certificate. It accepts
// a phone-generated public key, never a private key, and it is the only place a phone is told
// anything before it can authenticate the gateway against the CA pinned in its dshlink2: code.
import http from 'node:http';
import https from 'node:https';
import { API_PREFIX, DSHLINK_VERSION, LinkError, newId, nowIso } from './util.mjs';
import { isLoopbackAddress } from './config.mjs';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

const FORWARDED_HEADERS = ['content-type', 'accept', 'range'];

export const PHONE_GATEWAY_POLICY_SUMMARY = 'mutual TLS with a per-phone certificate; one-time bootstrap only; hub token never leaves the hub';

function sendError(res, status, code, message, details) {
  if (res.headersSent || res.writableEnded) { res.destroy(); return; }
  const payload = { error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  const body = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function policyPathOf(url) {
  const pathname = url.pathname.toLowerCase();
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

// The mobile control surface: enough to browse workspaces/sessions/transcripts and to create
// sessions or send prompts, and nothing else. Everything else on the hub stays invisible.
function allowedMethodPath(method, pathname) {
  if (method === 'GET' && (pathname === API_PREFIX + '/info')) return true;
  if (method === 'GET' && pathname.startsWith(API_PREFIX + '/network/')) return true;
  if ((method === 'GET' || method === 'POST') && pathname.startsWith(API_PREFIX + '/dsh/')) return true;
  return false;
}

function readBody(req, maxBytes) {
  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new LinkError(413, 'payload_too_large', `body is ${declared} bytes; limit is ${maxBytes}`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = null;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (!overflow && total > maxBytes) {
        overflow = new LinkError(413, 'payload_too_large', `body exceeds ${maxBytes} bytes`);
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => (overflow ? reject(overflow) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new LinkError(400, 'bad_request', 'request body was interrupted')); });
  });
}

function pemFromRaw(raw) {
  const lines = String(raw ?? '').match(/.{1,64}/g) ?? [];
  return '-----BEGIN CERTIFICATE-----\n' + lines.join('\n') + '\n-----END CERTIFICATE-----\n';
}

function clientCertificatePem(socket) {
  try {
    const cert = socket.getPeerCertificate?.(true);
    if (!cert || !cert.raw) return null;
    return pemFromRaw(cert.raw.toString('base64'));
  } catch { return null; }
}

function isHttps(req) {
  return req.socket && typeof req.socket.getPeerCertificate === 'function';
}

/**
 * opts.cfg        - hub config (phoneGateway / phoneFrp sections)
 * opts.ca         - an initialized PhoneCA
 * opts.store      - HubStore (phone registry + bootstrap registry + audit)
 * opts.logger     - { info, warn, error, debug }
 * opts.getConfig  - optional accessor for live phoneGateway config
 */
export function createPhoneGateway({ cfg, ca, store, logger, getConfig } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const sockets = new Set();
  let server = null;
  const lastSeen = new Map();
  const bootstrapAttempts = new Map();

  function sourceConfig() {
    if (typeof getConfig === 'function') {
      try {
        const latest = getConfig();
        if (latest && typeof latest === 'object') return latest;
      } catch (err) { log.warn('phone gateway config read failed:', err?.message ?? String(err)); }
    }
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  function current() {
    const source = sourceConfig();
    return source.phoneGateway ?? {};
  }

  function rateLimited(id) {
    const now = Date.now();
    const recent = (bootstrapAttempts.get(id) ?? []).filter((at) => now - at < 60_000);
    recent.push(now);
    bootstrapAttempts.set(id, recent);
    if (bootstrapAttempts.size > 2000) bootstrapAttempts.clear();
    return recent.length > 20;
  }

  async function handleBootstrap(req, res, url) {
    const settings = current();
    if (!settings.enabled) { sendError(res, 403, 'phone_gateway_disabled', 'the phone gateway is disabled'); return; }
    if (settings.allowNewDevices === false) { sendError(res, 403, 'phone_enrollment_closed', 'this hub is not accepting new phones'); return; }
    if (typeof ca?.issueDevice !== 'function') { sendError(res, 503, 'phone_ca_unavailable', 'the phone CA is not initialized'); return; }
    let body;
    try {
      if (req.method !== 'POST') { sendError(res, 405, 'method_not_allowed', 'use POST /api/v1/phone/bootstrap'); return; }
      body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
    } catch (err) {
      sendError(res, err instanceof LinkError ? err.status : 400, err instanceof LinkError ? err.code : 'bad_request', err.message ?? 'invalid bootstrap request');
      return;
    }
    const bootstrap = body?.bootstrap && typeof body.bootstrap === 'object' ? body.bootstrap : {};
    const id = String(bootstrap.id ?? '').trim();
    const secret = String(bootstrap.secret ?? '').trim();
    if (!id || !secret) { sendError(res, 400, 'bad_request', 'bootstrap id and secret are required'); return; }
    if (rateLimited(id)) { sendError(res, 429, 'too_many_attempts', 'too many bootstrap attempts for this code'); return; }
    const consumed = await store.consumePhoneBootstrap(id, secret);
    if (!consumed.ok) {
      await store.audit({ event: 'phone_bootstrap_failed', bootstrapId: id, reason: consumed.reason, ip: req.socket.remoteAddress });
      sendError(res, 401, 'bootstrap_rejected', consumed.reason);
      return;
    }
    const device = body?.device && typeof body.device === 'object' ? body.device : {};
    const deviceId = String(device.deviceId ?? '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || ('phone-' + Date.now());
    const label = String(device.label ?? consumed.entry?.label ?? 'phone').slice(0, 64);
    const existing = await store.getPhone(deviceId);
    if (existing?.status === 'revoked') {
      await store.audit({ event: 'phone_bootstrap_failed', bootstrapId: id, reason: 'device revoked', deviceId });
      sendError(res, 403, 'phone_revoked', 'this phone was revoked; ask the hub admin for a new profile');
      return;
    }
    const active = await store.countPhones({ activeOnly: true });
    if (!existing && active >= Number(settings.maxDevices ?? 64)) {
      await store.audit({ event: 'phone_bootstrap_failed', bootstrapId: id, reason: 'max devices', deviceId });
      sendError(res, 409, 'too_many_devices', 'the hub has reached phoneGateway.maxDevices');
      return;
    }
    let issued;
    try {
      issued = await ca.issueDevice({
        publicKeyPem: body?.publicKey,
        deviceId,
        label,
        days: Number(settings.deviceDays ?? 365)
      });
    } catch (err) {
      await store.audit({ event: 'phone_bootstrap_failed', bootstrapId: id, reason: err?.message ?? 'issue failed', deviceId });
      sendError(res, err instanceof LinkError ? err.status : 400, err instanceof LinkError ? err.code : 'bad_public_key', err.message ?? 'could not issue a certificate');
      return;
    }
    const record = await store.upsertPhone({
      id: existing?.id ?? newId('ph'),
      label,
      deviceId,
      fingerprint: issued.fingerprint,
      serialNumber: issued.serialNumber,
      subject: 'CN=' + deviceId,
      publicKeyPem: issued.publicKeyPem,
      status: 'active',
      createdAt: existing?.createdAt ?? nowIso(),
      lastSeenAt: nowIso(),
      expiresAt: issued.validTo ? new Date(issued.validTo).toISOString() : null,
      platform: String(device.platform ?? '').slice(0, 64) || null,
      appVersion: String(device.appVersion ?? '').slice(0, 64) || null,
      note: device.note ? String(device.note).slice(0, 300) : null
    });
    await store.audit({ event: 'phone_enrolled', phoneId: record.id, deviceId, fingerprint: issued.fingerprint, bootstrapId: id, label, ip: req.socket.remoteAddress });
    log.info?.(`phone gateway: enrolled ${label} (${record.id}) fingerprint ${issued.fingerprint}`);
    sendJson(res, 201, {
      ok: true,
      device: { id: record.id, label: record.label, deviceId, fingerprint: record.fingerprint, validTo: record.expiresAt },
      certificate: { certPem: issued.certPem },
      ca: { caPem: ca.caPem(), fingerprint: ca.caFingerprint() },
      server: { softwareVersion: DSHLINK_VERSION, entryUrl: null }
    });
  }

  async function authenticate(req, res) {
    if (!isHttps(req)) {
      sendError(res, 400, 'tls_required', 'the phone gateway only accepts HTTPS');
      return null;
    }
    const pem = clientCertificatePem(req.socket);
    if (!pem) { sendError(res, 401, 'client_certificate_required', 'a phone client certificate is required'); return null; }
    const verified = ca.verifyClientCertificate(pem);
    if (!verified.ok) {
      await store.audit({ event: 'phone_rejected', reason: verified.reason, fingerprint: verified.fingerprint ?? null, ip: req.socket.remoteAddress });
      sendError(res, 403, 'phone_certificate_invalid', verified.reason);
      return null;
    }
    const phone = await store.getPhoneByFingerprint(verified.fingerprint);
    if (!phone) { sendError(res, 403, 'phone_unknown', 'this certificate is not registered with the hub'); return null; }
    if (phone.status === 'revoked') {
      await store.audit({ event: 'phone_rejected', reason: 'revoked', phoneId: phone.id, fingerprint: verified.fingerprint, ip: req.socket.remoteAddress });
      sendError(res, 403, 'phone_revoked', 'this phone was revoked');
      return null;
    }
    const now = Date.now();
    if (now - (lastSeen.get(phone.id) ?? 0) > 60_000) {
      lastSeen.set(phone.id, now);
      store.recordPhoneSeen(phone.id).catch(() => {});
    }
    return { phone, fingerprint: verified.fingerprint };
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'https://phone-gateway.invalid'); } catch { sendError(res, 400, 'bad_request', 'malformed request URL'); return; }
    const pathname = policyPathOf(url);
    const settings = current();
    if (!settings.enabled) { sendError(res, 403, 'phone_gateway_disabled', 'the phone gateway is disabled'); return; }

    if (pathname === '/healthz') {
      sendJson(res, 200, { ok: true, name: sourceConfig().name ?? 'hub', role: 'phone-gateway', version: DSHLINK_VERSION, caFingerprint: ca.caFingerprint() });
      return;
    }
    if (req.method === 'POST' && pathname === API_PREFIX + '/phone/bootstrap') { await handleBootstrap(req, res, url); return; }

    const auth = await authenticate(req, res);
    if (!auth) return;

    if (req.method === 'GET' && pathname === API_PREFIX + '/phone/me') {
      sendJson(res, 200, {
        ok: true,
        device: {
          id: auth.phone.id,
          label: auth.phone.label,
          deviceId: auth.phone.deviceId,
          fingerprint: auth.phone.fingerprint,
          createdAt: auth.phone.createdAt,
          expiresAt: auth.phone.expiresAt
        },
        ca: { fingerprint: ca.caFingerprint() },
        policy: PHONE_GATEWAY_POLICY_SUMMARY
      });
      return;
    }

    if (!allowedMethodPath(req.method, pathname)) {
      sendError(res, 403, 'phone_route_denied', `route ${pathname} is not exposed to phones`);
      return;
    }
    const hubToken = String(settings.hubToken ?? '').trim();
    if (!hubToken) { sendError(res, 503, 'phone_gateway_misconfigured', 'phoneGateway.hubToken is not set'); return; }
    let body;
    try { body = await readBody(req, Number(settings.maxBodyBytes ?? 2 * 1024 * 1024)); } catch (err) {
      sendError(res, err instanceof LinkError ? err.status : 400, err instanceof LinkError ? err.code : 'bad_request', err.message ?? 'could not read request body');
      return;
    }
    const hubPort = Number(sourceConfig().port ?? 8790);
    const targetPath = url.pathname + url.search;
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    headers.authorization = 'Bearer ' + hubToken;
    headers['x-dshlink-phone'] = auth.fingerprint;
    if (body.length > 0 || ['POST', 'PUT', 'PATCH'].includes(req.method)) headers['content-length'] = String(body.length);
    proxy(req, res, { port: hubPort, path: targetPath, headers, body, timeoutMs: Number(settings.timeoutMs ?? 60_000) });
  }

  function proxy(req, res, { port, path: targetPath, headers, body, timeoutMs }) {
    let proxyReq;
    try {
      proxyReq = http.request({ host: '127.0.0.1', port, method: req.method, path: targetPath, headers });
    } catch (err) {
      sendError(res, 502, 'bad_gateway', 'phone gateway upstream is unreachable: ' + (err?.message ?? String(err)));
      return;
    }
    let responded = false;
    let timer = null;
    const settle = (status, code, message) => {
      if (responded) return;
      responded = true;
      if (timer) clearTimeout(timer);
      sendError(res, status, code, message);
    };
    timer = setTimeout(() => { proxyReq.destroy(); if (!responded) settle(504, 'phone_gateway_timeout', `the hub did not respond within ${timeoutMs}ms`); }, timeoutMs);
    timer.unref?.();
    res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); if (timer) clearTimeout(timer); });
    proxyReq.on('error', (err) => {
      log.warn(`phone gateway: hub request failed for ${req.method} ${targetPath}: ${err?.code ?? err?.message ?? String(err)}`);
      settle(502, 'bad_gateway', 'the hub is unreachable: ' + (err?.code ?? err?.message ?? String(err)));
    });
    proxyReq.on('response', (upstream) => {
      responded = true;
      if (timer) clearTimeout(timer);
      const out = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        // Do not let a hub auth challenge leak to the phone; the phone already authenticated.
        if (name === 'www-authenticate') continue;
        out[name] = value;
      }
      res.writeHead(upstream.statusCode ?? 502, out);
      upstream.pipe(res);
      upstream.on('error', () => { if (!res.writableEnded) res.destroy(); });
    });
    proxyReq.end(body.length > 0 ? body : undefined);
  }

  return {
    async listen({ port, bind } = {}) {
      if (server) throw new LinkError(2, 'already_listening', 'the phone gateway is already listening');
      if (!ca) throw new LinkError(500, 'phone_ca_unavailable', 'the phone gateway needs an initialized phone CA');
      const settings = current();
      const wantedPort = port ?? Number(settings.port ?? 8791);
      const wantedBind = bind ?? settings.bind ?? '127.0.0.1';
      if (!isLoopbackAddress(wantedBind)) {
        throw new LinkError(2, 'phone_gateway_bind_not_loopback', 'the phone gateway must bind a loopback address; phones reach it through the STCP visitor');
      }
      const tls = ca.serverTls();
      const instance = https.createServer({
        key: tls.key,
        cert: tls.cert,
        ca: tls.ca,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2'
      }, (req, res) => {
        handle(req, res).catch((err) => {
          log.error('phone gateway unhandled request error:', err?.stack ?? String(err));
          if (!res.headersSent) sendError(res, 500, 'internal_error', 'phone gateway internal error');
          else res.destroy();
        });
      });
      instance.headersTimeout = 60_000;
      instance.on('tlsClientError', (err) => log.debug?.('phone gateway TLS client error: ' + (err?.code ?? err?.message ?? String(err))));
      instance.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(wantedPort, wantedBind, () => { instance.off('error', reject); resolve(); });
      });
      server = instance;
      const address = instance.address();
      const actualPort = typeof address === 'object' && address ? address.port : wantedPort;
      log.info(`phone gateway listening on https://${wantedBind}:${actualPort} (${PHONE_GATEWAY_POLICY_SUMMARY})`);
      return { port: actualPort, bind: wantedBind, url: `https://${wantedBind}:${actualPort}`, caFingerprint: ca.caFingerprint() };
    },

    async close() {
      const instance = server;
      if (!instance) return;
      server = null;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        instance.close(finish);
        instance.closeIdleConnections?.();
        const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); finish(); }, 1000);
        timer.unref?.();
      });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },

    async status() {
      const settings = current();
      const [phones, bootstraps] = await Promise.all([store.listPhones(), store.listPhoneBootstraps(20)]);
      return {
        enabled: settings.enabled === true,
        listening: server !== null,
        bind: settings.bind ?? '127.0.0.1',
        port: Number(settings.port ?? 8791),
        caFingerprint: ca?.caFingerprint?.() ?? null,
        hubTokenSet: !!settings.hubToken,
        allowNewDevices: settings.allowNewDevices !== false,
        maxDevices: Number(settings.maxDevices ?? 64),
        devices: { total: phones.length, active: phones.filter((p) => p.status !== 'revoked').length },
        bootstraps: bootstraps.map((b) => ({ id: b.id, label: b.label, status: b.status, expiresAt: b.expiresAt, uses: b.uses, maxUses: b.maxUses }))
      };
    },

    get listening() { return server !== null; }
  };
}
