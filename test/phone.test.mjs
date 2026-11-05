// Tests for the 0.9 phone connect profiles: the dshlink1 codec, the visitor TOML renderer, the
// hub -> phone tunnel bundle and the device-token invite builder. Pure functions plus a couple of
// temp files, no HTTP (the hub console route is covered in hub.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TMP } from './helpers.mjs';
import { normalizeHubConfig, verifyHubToken } from '../src/hubconfig.mjs';
import {
  PHONE_INVITE_PREFIX, PHONE_TUNNEL_BIND_PORT, buildHubPhoneInvite, decodePhoneInvite,
  encodePhoneCode, renderPhoneVisitorToml, summarizePhoneProfile, tunnelBundleFromHubConfig
} from '../src/phone.mjs';

let counter = 0;

async function freshDir(label) {
  counter += 1;
  const dir = path.join(TMP, 'phone-' + label + '-' + counter);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function sampleProfile(overrides = {}) {
  return {
    v: 1,
    kind: 'dshlink-phone',
    software: 'dsh-link',
    softwareVersion: '0.9.0',
    label: 'my phone',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    entry: { kind: 'hub', name: 'HUB', url: 'http://127.0.0.1:18790' },
    token: 'plain-device-token',
    tokenId: 'tok_phone_1',
    tunnel: {
      enabled: true,
      bindPort: PHONE_TUNNEL_BIND_PORT,
      frpc: renderPhoneVisitorToml({ serverAddr: 'frp.example', secretKey: 'stcp-secret' }),
      files: { 'client.crt': 'Y3J0', 'client.key': 'a2V5', 'ca.crt': 'Y2E=' }
    },
    note: null,
    ...overrides
  };
}

async function hubConfigWithFrp(label) {
  const dir = await freshDir(label);
  const certFile = path.join(dir, 'client.crt');
  const keyFile = path.join(dir, 'client.key');
  const caFile = path.join(dir, 'ca.crt');
  await fs.writeFile(certFile, 'CERT-PEM', 'utf8');
  await fs.writeFile(keyFile, 'KEY-PEM', 'utf8');
  await fs.writeFile(caFile, 'CA-PEM', 'utf8');
  const cfg = normalizeHubConfig({
    name: 'HUB-' + label.toUpperCase(),
    dataDir: dir,
    frp: {
      enabled: true,
      serverAddr: '203.0.113.10',
      serverPort: 16443,
      user: 'dsh-link',
      token: 'frps-secret',
      certFile,
      keyFile,
      trustedCaFile: caFile,
      provider: { name: 'dshlink-hub', secretKey: 'stcp-secret' }
    }
  }, dir);
  return { dir, cfg };
}

test('phone: connect codes round-trip through the dshlink1 prefix', () => {
  const profile = sampleProfile();
  const code = encodePhoneCode(profile);
  assert.ok(code.startsWith(PHONE_INVITE_PREFIX));
  assert.doesNotMatch(code, /\s/);
  const decoded = decodePhoneInvite(code);
  assert.equal(decoded.kind, 'dshlink-phone');
  assert.equal(decoded.v, 1);
  assert.equal(decoded.label, 'my phone');
  assert.equal(decoded.entry.kind, 'hub');
  assert.equal(decoded.entry.name, 'HUB');
  assert.equal(decoded.entry.url, 'http://127.0.0.1:18790');
  assert.equal(decoded.token, 'plain-device-token');
  assert.equal(decoded.tokenId, 'tok_phone_1');
  assert.equal(decoded.tunnel.enabled, true);
  assert.equal(decoded.tunnel.bindPort, PHONE_TUNNEL_BIND_PORT);
  assert.match(decoded.tunnel.frpc, /serverAddr = "frp\.example"/);
  assert.equal(decoded.tunnel.files['client.crt'], 'Y3J0');
  assert.equal(decoded.tunnel.files['client.key'], 'a2V5');
});

test('phone: plain JSON profiles, wrapped codes and bare payloads are accepted', () => {
  const profile = sampleProfile();
  const viaJson = decodePhoneInvite(JSON.stringify(profile));
  assert.equal(viaJson.label, 'my phone');
  const code = encodePhoneCode(profile);
  const wrapped = code.slice(0, 60) + '\n  ' + code.slice(60).replace(/(.{80})/g, '$1\n');
  assert.equal(decodePhoneInvite(wrapped).token, 'plain-device-token');
  const bare = code.slice(PHONE_INVITE_PREFIX.length);
  assert.equal(decodePhoneInvite(bare).entry.url, 'http://127.0.0.1:18790');
  const noTunnel = decodePhoneInvite(JSON.stringify(sampleProfile({ tunnel: null })));
  assert.equal(noTunnel.tunnel, null);
});

test('phone: broken, expired and tokenless profiles are rejected', () => {
  assert.throws(() => decodePhoneInvite(''), /connect code is required/);
  assert.throws(() => decodePhoneInvite('hello world'), /not valid dsh-link phone data/);
  assert.throws(() => decodePhoneInvite(JSON.stringify({ kind: 'dshlink-invite' })), /not a dsh-link phone profile/);
  assert.throws(() => decodePhoneInvite(JSON.stringify({ ...sampleProfile(), v: 99 })), /unsupported phone profile version/);
  assert.throws(() => decodePhoneInvite(JSON.stringify({ ...sampleProfile(), entry: { url: '' } })), /entry URL/);
  assert.throws(() => decodePhoneInvite(JSON.stringify({ ...sampleProfile(), token: '' })), /device token/);
  assert.throws(
    () => decodePhoneInvite(JSON.stringify(sampleProfile({ expiresAt: new Date(Date.now() - 1000).toISOString() }))),
    (err) => err.code === 'phone_invite_expired' && err.status === 410
  );
});

test('phone: the rendered visitor TOML is a complete phone-side frpc config', () => {
  const toml = renderPhoneVisitorToml({
    serverAddr: 'frp.example',
    serverPort: 16443,
    user: 'dsh-link',
    authToken: 'frps-secret',
    certFile: '{{DIR}}/client.crt',
    keyFile: '{{DIR}}/client.key',
    trustedCaFile: '{{DIR}}/ca.crt',
    serverName: 'dshlink-hub',
    secretKey: 'stcp-secret',
    bindPort: 18790
  });
  assert.match(toml, /serverAddr = "frp\.example"/);
  assert.match(toml, /serverPort = 16443/);
  assert.match(toml, /loginFailExit = false/);
  assert.match(toml, /auth\.token = "frps-secret"/);
  assert.match(toml, /auth\.additionalScopes = \["HeartBeats", "NewWorkConns"\]/);
  assert.match(toml, /transport\.tls\.enable = true/);
  assert.match(toml, /transport\.tls\.certFile = "\{\{DIR\}\}\/client\.crt"/);
  assert.match(toml, /\[\[visitors\]\]/);
  assert.match(toml, /name = "phone-to-hub"/);
  assert.match(toml, /type = "stcp"/);
  assert.match(toml, /serverName = "dshlink-hub"/);
  assert.match(toml, /secretKey = "stcp-secret"/);
  assert.match(toml, /bindAddr = "127\.0\.0\.1"/);
  assert.match(toml, /bindPort = 18790/);
  assert.match(toml, /transport\.useEncryption = true/);
  assert.match(toml, /transport\.useCompression = false/);
  assert.doesNotMatch(toml, /\[\[proxies\]\]/);
  assert.throws(() => renderPhoneVisitorToml({ secretKey: 'x' }), /serverAddr/);
  assert.throws(() => renderPhoneVisitorToml({ serverAddr: 'frp.example' }), /secretKey/);
});

test('phone: the tunnel bundle carries the hub frps credentials and cert files', async () => {
  const { cfg, dir } = await hubConfigWithFrp('bundle');
  const bundle = await tunnelBundleFromHubConfig(cfg, { visitorPort: 18790 });
  assert.equal(bundle.enabled, true);
  assert.equal(bundle.bindPort, 18790);
  assert.match(bundle.frpc, /serverAddr = "203\.0\.113\.10"/);
  assert.match(bundle.frpc, /serverPort = 16443/);
  assert.match(bundle.frpc, /auth\.token = "frps-secret"/);
  assert.match(bundle.frpc, /serverName = "dshlink-hub"/);
  assert.match(bundle.frpc, /secretKey = "stcp-secret"/);
  assert.match(bundle.frpc, /transport\.tls\.certFile = "\{\{DIR\}\}\/client\.crt"/);
  assert.match(bundle.frpc, /transport\.tls\.keyFile = "\{\{DIR\}\}\/client\.key"/);
  assert.match(bundle.frpc, /transport\.tls\.trustedCaFile = "\{\{DIR\}\}\/ca\.crt"/);
  assert.equal(Buffer.from(bundle.files['client.crt'], 'base64').toString(), 'CERT-PEM');
  assert.equal(Buffer.from(bundle.files['client.key'], 'base64').toString(), 'KEY-PEM');
  assert.equal(Buffer.from(bundle.files['ca.crt'], 'base64').toString(), 'CA-PEM');
  // A hub without frps gets no bundle (static URLs only).
  const plain = normalizeHubConfig({ name: 'PLAIN', dataDir: dir }, dir);
  assert.equal(await tunnelBundleFromHubConfig(plain), null);
  plain.frp.enabled = true;
  plain.frp.serverAddr = null;
  assert.equal(await tunnelBundleFromHubConfig(plain), null);
});

test('phone: buildHubPhoneInvite mints a device token and embeds the tunnel', async () => {
  const { cfg } = await hubConfigWithFrp('invite');
  const before = cfg.auth.tokens.length;
  const created = await buildHubPhoneInvite(cfg, { label: 'test phone', ttlHours: 2, maxUses: 3 });
  assert.equal(cfg.auth.tokens.length, before + 1, 'the caller persists cfg; the token is already pushed');
  assert.ok(created.code.startsWith(PHONE_INVITE_PREFIX));
  assert.equal(created.tunnel, true);
  assert.equal(created.summary.label, 'test phone');
  assert.equal(created.summary.hasTunnel, true);
  assert.ok(created.summary.entry.url.startsWith('http://127.0.0.1:'));
  assert.ok(!Object.prototype.hasOwnProperty.call(created.summary, 'token'));
  assert.doesNotMatch(JSON.stringify(created.summary), /plain|token":/);
  const decoded = decodePhoneInvite(created.code);
  const verified = verifyHubToken(cfg, decoded.token);
  assert.equal(verified.role, 'device');
  assert.equal(verified.maxUses, 3);
  const ttlMs = Date.parse(decoded.expiresAt) - Date.now();
  assert.ok(ttlMs > 90 * 60 * 1000 && ttlMs <= 121 * 60 * 1000, 'ttlHours 2 should expire in ~2h');
  assert.equal(decoded.tunnel.bindPort, 18790);
  assert.match(decoded.tunnel.frpc, /serverAddr = "203\.0\.113\.10"/);
  assert.equal(summarizePhoneProfile(decoded).tokenId, decoded.tokenId);
});

test('phone: buildHubPhoneInvite supports direct URLs and validates its options', async () => {
  const dir = await freshDir('direct');
  const cfg = normalizeHubConfig({ name: 'DIRECT', dataDir: dir }, dir);
  const direct = await buildHubPhoneInvite(cfg, {
    label: 'lan phone', tunnel: false, url: 'http://192.0.2.50:8790/', ttlHours: 0
  });
  const decoded = decodePhoneInvite(direct.code);
  assert.equal(direct.tunnel, false);
  assert.equal(decoded.tunnel, null);
  assert.equal(decoded.entry.url, 'http://192.0.2.50:8790');
  assert.equal(decoded.expiresAt, null);
  await assert.rejects(() => buildHubPhoneInvite(cfg, { tunnel: false }), /explicit --url|explicit URL|no frp tunnel/);
  await assert.rejects(() => buildHubPhoneInvite(cfg, { tunnel: false, url: 'http://x', ttlHours: -1 }), /ttlHours/);
  await assert.rejects(() => buildHubPhoneInvite(cfg, { tunnel: false, url: 'http://x', ttlHours: 9000 }), /ttlHours/);
});
