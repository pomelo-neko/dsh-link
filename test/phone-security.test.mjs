// Tests for the 0.10 phone trust architecture (B2 + B4):
// - the hub phone CA signs certificates for phone-generated public keys;
// - the HTTPS phone gateway performs mutual TLS, proxies only the mobile control surface and
//   injects a hub token that never reaches the phone;
// - revoked phones and consumed bootstrap codes are refused;
// - the dedicated phone-frps tenant emits its own frpc config.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import https from 'node:https';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { TMP } from './helpers.mjs';
import { HubStore } from '../src/hubstore.mjs';
import { createHub } from '../src/hub.mjs';
import { createHubToken, hubConfigPathFor, normalizeHubConfig, saveHubConfig } from '../src/hubconfig.mjs';
import { findOpenssl, openPhoneCA } from '../src/phoneca.mjs';
import { buildPhoneBootstrap, decodePhoneBootstrap, summarizePhoneBootstrap } from '../src/phonebootstrap.mjs';
import { createPhoneGateway } from '../src/phonegateway.mjs';
import { phoneFrpConfigToml } from '../src/phonefrp.mjs';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const OPENSSL = findOpenssl();
const SKIP = OPENSSL ? false : 'openssl was not found; set DSHLINK_OPENSSL or install OpenSSL';

let counter = 0;
async function freshDir(label) {
  counter += 1;
  const dir = path.join(TMP, 'phone-security-' + label + '-' + counter);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Minimal HTTPS client with a pinned CA and optional client certificate. */
function request(url, { method = 'GET', body, caPem, certPem, keyPem } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const options = {
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      ca: caPem,
      rejectUnauthorized: true
    };
    if (certPem) { options.cert = certPem; options.key = keyPem; }
    const headers = {};
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    options.headers = headers;
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timed out')));
    req.end(body);
  });
}

test('phone-frps: the dedicated tenant config points at the phone gateway', () => {
  const cfg = {
    phoneGateway: { port: 8791 },
    phoneFrp: {
      serverAddr: 'frps.phone.test',
      serverPort: 16443,
      user: 'dsh-link-phone',
      token: 'phone-frps-token',
      certFile: 'C:/certs/client.crt',
      keyFile: 'C:/certs/client.key',
      trustedCaFile: 'C:/certs/ca.crt',
      provider: { name: 'dshlink-phone', secretKey: 'provider-secret' },
      adminPort: 7402
    }
  };
  const toml = phoneFrpConfigToml(cfg);
  assert.match(toml, /serverAddr = "frps\.phone\.test"/);
  assert.match(toml, /serverPort = 16443/);
  assert.match(toml, /user = "dsh-link-phone"/);
  assert.match(toml, /auth\.additionalScopes = \["HeartBeats", "NewWorkConns"\]/);
  assert.match(toml, /name = "dshlink-phone"/);
  assert.match(toml, /type = "stcp"/);
  assert.match(toml, /secretKey = "provider-secret"/);
  assert.match(toml, /allowUsers = \["dsh-link-phone"\]/);
  assert.match(toml, /localPort = 8791/);
  assert.match(toml, /transport\.useEncryption = true/);
  assert.throws(() => phoneFrpConfigToml({ phoneGateway: { port: 8791 }, phoneFrp: {} }), /serverAddr/);
});

test('phone bootstrap: profile pins the CA, carries a one-time secret and never leaks it in the summary', SKIP, async () => {
  const dir = await freshDir('bootstrap');
  const ca = await openPhoneCA({ dir: path.join(dir, 'phone-ca'), log: QUIET });
  const store = await new HubStore(dir).init();
  const cfg = {
    name: 'BOOTSTRAP-HUB',
    dataDir: dir,
    phoneGateway: { port: 8791 },
    phoneFrp: { enabled: false }
  };
  const built = await buildPhoneBootstrap(cfg, ca, store, { label: 'pixel', ttlHours: 2, tunnel: false, url: 'https://10.0.0.5:8791' });
  const decoded = decodePhoneBootstrap(built.code);
  assert.equal(decoded.kind, 'dshlink-phone-v2');
  assert.equal(decoded.entry.url, 'https://10.0.0.5:8791');
  assert.equal(decoded.gateway.caFingerprint, ca.caFingerprint());
  assert.equal(decoded.bootstrap.id, built.bootstrapId);
  assert.match(decoded.gateway.caPem, /BEGIN CERTIFICATE/);
  assert.ok(decoded.bootstrap.secret.startsWith('pbs_'));
  const summary = summarizePhoneBootstrap(decoded);
  assert.equal(JSON.stringify(summary).includes(decoded.bootstrap.secret), false);
  assert.equal(JSON.stringify(summary).includes('PRIVATE KEY'), false);
  assert.throws(() => decodePhoneBootstrap('dshlink2:not-a-profile'), /profile|bootstrap/i);
});

test('phone gateway: bootstrap issues a client certificate and mTLS proxies only the mobile surface', SKIP, async () => {
  const dir = await freshDir('gateway');
  const ca = await openPhoneCA({ dir: path.join(dir, 'phone-ca'), log: QUIET });
  const store = await new HubStore(dir).init();

  const raw = {
    name: 'PHONE-GATEWAY-HUB',
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    phoneGateway: { enabled: true, bind: '127.0.0.1', port: 0, caDir: path.join(dir, 'phone-ca') }
  };
  const cfg = normalizeHubConfig(raw, dir);
  cfg.dataDir = dir;
  cfg.configPath = hubConfigPathFor({ dataDir: dir });
  const admin = createHubToken(cfg, 'admin', { role: 'admin' });
  const device = createHubToken(cfg, 'device', { role: 'device' });
  cfg.phoneGateway.hubToken = device.token;
  const hub = createHub({ cfg, store, logger: QUIET, saveConfig: async (next) => { await saveHubConfig(next); } });
  const hubInfo = await hub.listen({ port: 0, bind: '127.0.0.1' });
  cfg.port = hubInfo.port;

  const gateway = createPhoneGateway({ cfg, ca, store, logger: QUIET });
  const gatewayInfo = await gateway.listen({ port: 0, bind: '127.0.0.1' });
  try {
    const health = await request(gatewayInfo.url + '/healthz', { caPem: ca.caPem() });
    assert.equal(health.status, 200);
    assert.equal(health.json.role, 'phone-gateway');
    assert.equal(health.json.caFingerprint, ca.caFingerprint());

    const built = await buildPhoneBootstrap(cfg, ca, store, { label: 'pixel-e2e', ttlHours: 2, tunnel: false, url: gatewayInfo.url });
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const body = JSON.stringify({
      bootstrap: { id: built.summary.bootstrapId, secret: decodePhoneBootstrap(built.code).bootstrap.secret },
      device: { deviceId: 'pixel-e2e', label: 'Pixel E2E', platform: 'android', appVersion: '0.6.0' },
      publicKey
    });
    const enroll = await request(gatewayInfo.url + '/api/v1/phone/bootstrap', { method: 'POST', body, caPem: ca.caPem() });
    assert.equal(enroll.status, 201);
    assert.match(enroll.json.certificate.certPem, /BEGIN CERTIFICATE/);
    assert.equal(enroll.json.device.deviceId, 'pixel-e2e');
    assert.equal('token' in enroll.json, false);
    assert.equal(JSON.stringify(enroll.json).includes(device.token), false);

    // The one-time code cannot be used twice.
    const reuse = await request(gatewayInfo.url + '/api/v1/phone/bootstrap', { method: 'POST', body, caPem: ca.caPem() });
    assert.equal(reuse.status, 401);
    assert.equal(reuse.json.error.code, 'bootstrap_rejected');

    const certPem = enroll.json.certificate.certPem;
    const me = await request(gatewayInfo.url + '/api/v1/phone/me', { caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(me.status, 200);
    assert.equal(me.json.device.deviceId, 'pixel-e2e');

    const info = await request(gatewayInfo.url + '/api/v1/info', { caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(info.status, 200);
    assert.equal(info.json.name, 'PHONE-GATEWAY-HUB');
    assert.equal(info.json.role, 'hub');

    const denied = await request(gatewayInfo.url + '/api/v1/hub/tokens', { caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'phone_route_denied');

    // Path normalisation cannot be used to escape the mobile surface.
    const traversal = await request(gatewayInfo.url + '/api/v1/dsh/../hub/tokens', { caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(traversal.status, 403);
    assert.equal(traversal.json.error.code, 'phone_route_denied');

    // POST /api/v1/dsh/* is proxied to the hub (a phone uses it for sessions.prompt). With no
    // enrolled node the hub itself answers 404; what matters is that the gateway did not deny it.
    const callBody = JSON.stringify({ peer: 'ghost', method: 'sessions.list', params: {}, waitSeconds: 0 });
    const call = await request(gatewayInfo.url + '/api/v1/dsh/call', { method: 'POST', body: callBody, caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(call.status, 404);
    assert.equal(call.json.error.code, 'unknown_target');

    const noCert = await request(gatewayInfo.url + '/api/v1/phone/me', { caPem: ca.caPem() });
    assert.equal(noCert.status, 401);
    assert.equal(noCert.json.error.code, 'client_certificate_required');

    const phones = await store.listPhones();
    assert.equal(phones.length, 1);
    assert.equal(phones[0].fingerprint, enroll.json.device.fingerprint);
    const revoked = await store.revokePhone('pixel-e2e', 'test revocation');
    assert.equal(revoked.status, 'revoked');
    const after = await request(gatewayInfo.url + '/api/v1/phone/me', { caPem: ca.caPem(), certPem, keyPem: privateKey });
    assert.equal(after.status, 403);
    assert.equal(after.json.error.code, 'phone_revoked');

    const status = await gateway.status();
    assert.equal(status.devices.total, 1);
    assert.equal(status.devices.active, 0);
    assert.equal(admin.token.length > 20, true);
  } finally {
    await gateway.close();
    await hub.close();
  }
});
test('hub phone control plane: admin mints/revokes bootstrap codes and phones never see admin routes', SKIP, async () => {
  const dir = await freshDir('control-plane');
  const ca = await openPhoneCA({ dir: path.join(dir, 'phone-ca'), log: QUIET });
  const store = await new HubStore(dir).init();
  const raw = {
    name: 'PHONE-CONTROL-HUB',
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    phoneGateway: { enabled: true, bind: '127.0.0.1', port: 8791, caDir: path.join(dir, 'phone-ca') }
  };
  const cfg = normalizeHubConfig(raw, dir);
  cfg.dataDir = dir;
  cfg.configPath = hubConfigPathFor({ dataDir: dir });
  const admin = createHubToken(cfg, 'admin', { role: 'admin' });
  const device = createHubToken(cfg, 'device', { role: 'device' });
  cfg.phoneGateway.hubToken = device.token;
  const hub = createHub({ cfg, store, logger: QUIET, phone: { ca }, saveConfig: async (next) => { await saveHubConfig(next); } });
  const info = await hub.listen({ port: 0, bind: '127.0.0.1' });
  const call = async (method, pathname, body, token = admin.token) => {
    const res = await fetch(info.url + pathname, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json };
  };
  try {
    const created = await call('POST', '/api/v1/hub/phone/bootstrap', { label: 'pixel-control', ttlHours: 1, tunnel: false, url: 'https://127.0.0.1:8791' });
    assert.equal(created.status, 201);
    assert.match(created.json.code, /^dshlink2:/);
    assert.equal(created.json.summary.label, 'pixel-control');
    const summaryText = JSON.stringify(created.json.summary);
    assert.equal(summaryText.includes('pbs_'), false);
    assert.equal(summaryText.includes('secret'), false);

    const status = await call('GET', '/api/v1/hub/phone/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.gateway.enabled, false);
    assert.equal(status.json.bootstraps.length, 1);
    assert.equal(status.json.bootstraps[0].status, 'active');

    const forbidden = await call('GET', '/api/v1/hub/phone/status', undefined, device.token);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, 'role_forbidden');

    const removed = await call('DELETE', '/api/v1/hub/phone/bootstrap/' + created.json.bootstrapId);
    assert.equal(removed.status, 200);
    const after = await call('GET', '/api/v1/hub/phone/status');
    assert.equal(after.json.bootstraps[0].status, 'revoked');
  } finally {
    await hub.close();
  }
});


test('hub store: phone changes written by another process reach the running hub', async () => {
  const dir = await freshDir('phone-reload');
  const writer = await new HubStore(dir).init();
  await writer.upsertPhone({ id: 'ph_reload_1', label: 'pixel', deviceId: 'dev-reload-1', fingerprint: 'AA:BB:CC', status: 'active' });

  // The hub process has its own store instance. It must see later changes made by the CLI,
  // which writes phones.json from a separate process.
  const running = await new HubStore(dir).init();
  assert.equal((await running.getPhoneByFingerprint('aa:bb:cc')).status, 'active');

  await new Promise((resolve) => setTimeout(resolve, 15));
  const cli = await new HubStore(dir).init();
  await cli.revokePhone('ph_reload_1', 'revoked by the CLI');
  assert.equal((await running.getPhone('ph_reload_1')).status, 'revoked');
  assert.equal((await running.countPhones({ activeOnly: true })), 0);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const cli2 = await new HubStore(dir).init();
  await cli2.upsertPhone({ id: 'ph_reload_1', label: 'pixel', deviceId: 'dev-reload-1', fingerprint: 'AA:BB:CC', status: 'active' });
  assert.equal((await running.getPhone('ph_reload_1')).status, 'active');
  assert.equal((await running.listPhones()).length, 1);
});
