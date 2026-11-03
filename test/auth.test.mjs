// 0.5.0: token roles, peer identity, secure defaults and request rate limiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TMP, makeNode, resetTmp } from './helpers.mjs';
import { createInboundToken, defaultConfig, normalizeConfig } from '../src/config.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { planDshInstall } from '../src/pairing.mjs';

async function request(target, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(target.url + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, headers: res.headers, body: payload };
}

function addToken(node, opts) {
  return createInboundToken(node.cfg, opts.label ?? 'role-token', opts);
}

function envelope(id, overrides = {}) {
  return {
    id,
    ts: new Date().toISOString(),
    from: { nodeId: 'node_fake', name: 'peer-a', url: 'http://127.0.0.1:1' },
    thread: id,
    replyTo: null,
    kind: 'message',
    subject: 'subject',
    body: 'body',
    attachments: [],
    ...overrides
  };
}

test('auth: new configs do not trust localhost and legacy tokens stay admin', async (t) => {
  await resetTmp();
  assert.equal(defaultConfig({ dataDir: TMP }).auth.trustLocalhost, false);
  assert.equal(normalizeConfig({}, TMP).auth.trustLocalhost, false, 'a missing auth block means secure by default');
  assert.equal(normalizeConfig({ auth: { trustLocalhost: true } }, TMP).auth.trustLocalhost, true, 'an explicit true is preserved (and doctor fails it)');
  assert.throws(() => normalizeConfig({ auth: { tokens: [{ role: 'peer' }] } }, TMP), /must name its peer/);
  assert.throws(() => createInboundToken(defaultConfig({ dataDir: TMP }), 'p', { role: 'peer' }), /needs the peer name/);

  const node = await makeNode({ name: 'legacy-admin' });
  t.after(() => node.close());
  // node.token is a legacy token (created without a role): it must still work as admin.
  const peers = await request(node, '/api/v1/peers', { token: node.token });
  assert.equal(peers.status, 200);
  assert.equal(node.cfg.auth.tokens.length, 1);
});

test('auth: the role matrix separates admin, bridge, peer and device tokens', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'role-matrix', trustLocalhost: false });
  t.after(() => node.close());
  const admin = node.token;
  const bridge = addToken(node, { role: 'bridge', label: 'bridge-token' }).token;
  const device = addToken(node, { role: 'device', label: 'phone-token' }).token;
  const peer = addToken(node, { role: 'peer', peer: 'peer-a', label: 'peer-a-token' }).token;

  const bridgePeers = await request(node, '/api/v1/peers', { token: bridge });
  assert.equal(bridgePeers.status, 403);
  assert.equal(bridgePeers.body.error.code, 'role_forbidden');
  assert.equal((await request(node, '/api/v1/messages', { token: bridge })).status, 200, 'the bridge reads the inbox');
  assert.equal((await request(node, '/api/v1/messages', { method: 'POST', token: bridge, body: envelope('msg_bridge_1', { to: node.name }) })).status, 403);

  assert.equal((await request(node, '/api/v1/dsh/capabilities', { token: device })).status, 200);
  assert.equal((await request(node, '/api/v1/peers', { token: device })).status, 403);
  assert.equal((await request(node, '/api/v1/messages', { token: device })).status, 403);

  const ownPost = await request(node, '/api/v1/messages', { method: 'POST', token: peer, body: envelope('msg_peer_1', { to: node.name }) });
  assert.equal(ownPost.status, 202, 'a bound peer may post as itself');
  assert.equal((await request(node, '/api/v1/peers', { token: peer })).status, 403);

  assert.equal((await request(node, '/api/v1/peers', { token: admin })).status, 200);
  // A remote admin token is not a bridge: the bridge control plane stays local or bridge-only.
  const remoteBridge = await request(node, '/api/v1/bridge/status', { token: admin });
  assert.equal(remoteBridge.status, 403);
  assert.equal(remoteBridge.body.error.code, 'bridge_forbidden');
});

test('auth: expired tokens stop working without a restart', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'expiry', trustLocalhost: false });
  t.after(() => node.close());
  const expired = addToken(node, { role: 'device', label: 'expired', expiresAt: new Date(Date.now() - 60_000).toISOString() }).token;
  const future = addToken(node, { role: 'device', label: 'future', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).token;
  assert.equal((await request(node, '/api/v1/info', { token: expired })).status, 401);
  assert.equal((await request(node, '/api/v1/info', { token: future })).status, 200);
});

test('auth: a bound peer token cannot forge senders, read other peers or relay', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'identity', trustLocalhost: false });
  t.after(() => node.close());
  const peer = addToken(node, { role: 'peer', peer: 'peer-a', label: 'peer-a-token' }).token;
  let seq = 0;
  const send = (overrides) => request(node, '/api/v1/messages', {
    method: 'POST',
    token: peer,
    body: envelope('msg_auth_' + (seq += 1), { to: node.name, ...overrides })
  });

  const own = await send({});
  assert.equal(own.status, 202, 'a bound peer may post as itself');
  const forged = await send({ from: { nodeId: 'node_x', name: 'peer-b', url: 'http://127.0.0.1:2' } });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.code, 'identity_mismatch');
  const relay = await send({ to: 'third-node' });
  assert.equal(relay.status, 403);
  assert.equal(relay.body.error.code, 'relay_not_allowed');

  // Seed one message from another peer: the bound token must not see or mark it.
  await node.ops.acceptMessage(envelope('msg_from_peer_b', {
    from: { nodeId: 'node_b', name: 'peer-b', url: 'http://127.0.0.1:3' },
    to: node.name, subject: 'other', body: 'secret'
  }));
  const inbox = await request(node, '/api/v1/messages', { token: peer });
  assert.equal(inbox.status, 200);
  assert.ok(inbox.body.messages.length >= 1);
  assert.ok(inbox.body.messages.every((message) => message.from?.name === 'peer-a'));
  const peek = await request(node, '/api/v1/messages/msg_from_peer_b', { token: peer });
  assert.equal(peek.status, 403);
  assert.equal(peek.body.error.code, 'not_your_message');

  await node.ops.sendMessage({ to: 'peer-a', subject: 'to-a', body: 'one' });
  await node.ops.sendMessage({ to: 'peer-c', subject: 'to-c', body: 'two' });
  const outbox = await request(node, '/api/v1/outbox', { token: peer });
  assert.equal(outbox.status, 200);
  assert.ok(outbox.body.messages.every((message) => message.to === 'peer-a'));
  const wrong = await request(node, '/api/v1/outbox?to=peer-c', { token: peer });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'not_your_traffic');
});

test('auth: the request rate limiter returns 429 with retry-after', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'rate', trustLocalhost: false, limits: { maxRequestsPerMinute: 3 } });
  t.after(() => node.close());
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await request(node, '/api/v1/info', { token: node.token })).status, 200, 'request ' + i);
  }
  const limited = await request(node, '/api/v1/info', { token: node.token });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'too_many_requests');
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('auth: a hardened node accepts the bridge token and rejects anonymous bridge calls', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'hardened', trustLocalhost: false });
  t.after(() => node.close());
  const bridge = addToken(node, { role: 'bridge', label: 'bridge' }).token;
  const device = addToken(node, { role: 'device', label: 'phone' }).token;
  assert.equal((await request(node, '/api/v1/bridge/status')).status, 401);
  assert.equal((await request(node, '/api/v1/bridge/status', { token: bridge })).status, 200);
  assert.equal((await request(node, '/api/v1/bridge/commands', { token: bridge })).status, 200);
  assert.equal((await request(node, '/api/v1/bridge/commands', { token: device })).status, 403);
});

test('doctor: flags trustLocalhost and reports the hardening state', async (t) => {
  await resetTmp();
  const strict = await makeNode({ name: 'doctor-strict', trustLocalhost: false });
  t.after(() => strict.close());
  const strictReport = await runDoctor({ cfg: strict.cfg, store: strict.store, roots: strict.roots, ops: strict.ops, token: strict.token });
  const strictChecks = Object.fromEntries(strictReport.checks.map((check) => [check.name, check]));
  assert.equal(strictChecks['trust-localhost'].status, 'pass');
  assert.equal(strictChecks['rate-limit'].status, 'pass');
  assert.equal(strictChecks['bind-exposure'].status, 'pass');

  const legacy = await makeNode({ name: 'doctor-legacy' });
  t.after(() => legacy.close());
  const legacyReport = await runDoctor({ cfg: legacy.cfg, store: legacy.store, roots: legacy.roots, ops: legacy.ops, token: legacy.token });
  const legacyChecks = Object.fromEntries(legacyReport.checks.map((check) => [check.name, check]));
  assert.equal(legacyChecks['trust-localhost'].status, 'fail');
  assert.match(legacyChecks['trust-localhost'].detail, /harden/);
  assert.equal(legacyReport.ok, false);
});

test('install-dsh: writes MCP and bridge tokens into the DSH patch', async (t) => {
  await resetTmp();
  const dshHome = path.join(TMP, 'dsh-home-tokens');
  await fs.mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true });
  const plan = await planDshInstall({
    dshHome,
    profile: 'web',
    url: 'http://127.0.0.1:8787/mcp',
    bridge: true,
    bridgeWorkspace: path.join(TMP, 'bridge-ws'),
    token: 'tok-admin-123',
    bridgeToken: 'tok-bridge-456'
  });
  assert.equal(plan.mcp.tokenConfigured, true);
  assert.equal(plan.bridge.tokenConfigured, true);
  assert.match(plan.patchContent, /authorization: "Bearer tok-admin-123"/);
  assert.match(plan.patchContent, /token: "tok-bridge-456"/);

  const plain = await planDshInstall({ dshHome: path.join(TMP, 'dsh-home-plain'), profile: 'web', url: 'http://127.0.0.1:8787/mcp' });
  assert.equal(plain.mcp.tokenConfigured, false);
  assert.doesNotMatch(plain.patchContent, /authorization:/);
});
