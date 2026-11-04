// dsh-link: loopback token gateway tests. Uses a fake upstream on a random 127.0.0.1 port, so it
// never touches a real node (a live one usually listens on 8787) and never edits real config.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  DEFAULT_GATEWAY, createInboundToken, defaultConfig, isLoopbackAddress, normalizeGatewayConfig
} from '../src/config.mjs';
import { createGateway } from '../src/gateway.mjs';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function startEchoUpstream() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = String(req.url ?? '').split('?')[0];
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, path });
      // Held open on purpose: the gateway has to give up with 504, not hang.
      if (path === '/api/v1/dsh/slow') return;
      if (path === '/api/v1/dsh/call') {
        res.writeHead(202, { 'content-type': 'application/json', 'x-upstream': 'echo' });
        res.end(JSON.stringify({ accepted: true, path: req.url, token: req.headers.authorization ?? null, body }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'echo' });
      res.end(JSON.stringify({
        ok: true,
        path: req.url,
        token: req.headers.authorization ?? null,
        tokenHeader: req.headers['x-dshlink-token'] ?? null,
        contentType: req.headers['content-type'] ?? null,
        body
      }));
    });
  });
  const port = await listen(server);
  return {
    server,
    url: 'http://127.0.0.1:' + port,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function freeClosedPort() {
  const server = http.createServer((req, res) => res.end('nope'));
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function makeGateway(options = {}) {
  const cfg = defaultConfig({ name: 'gateway-test' });
  // trustLocalhost stays true on purpose: the gateway must never fall back to it.
  cfg.auth = { trustLocalhost: true, tokens: [] };
  cfg.gateway = normalizeGatewayConfig({
    enabled: true,
    bind: '127.0.0.1',
    port: 0,
    upstream: options.upstream,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    timeoutMs: options.timeoutMs ?? 5000
  });
  const specs = options.tokens ?? [{ label: 'phone', role: 'device' }];
  const tokens = {};
  for (const spec of specs) {
    const created = createInboundToken(cfg, spec.label, { role: spec.role, expiresAt: spec.expiresAt });
    tokens[spec.label] = created.token;
  }
  const gateway = createGateway({ cfg, getConfig: () => cfg, logger: SILENT });
  const info = await gateway.listen({ port: 0, bind: '127.0.0.1' });
  return { cfg, gateway, info, tokens, base: info.url, close: () => gateway.close() };
}

async function call(base, pathname, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (options.token !== undefined) headers.authorization = 'Bearer ' + options.token;
  const init = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) init.body = options.body;
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

function chunkedPost(base, pathname, token, chunks) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
    }, (res) => {
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('gateway config normalization is tolerant and defaults are safe', () => {
  assert.deepEqual(normalizeGatewayConfig(undefined), DEFAULT_GATEWAY);
  assert.deepEqual(normalizeGatewayConfig({}), DEFAULT_GATEWAY);
  // Every invalid value falls back to its default instead of breaking the node at startup.
  assert.deepEqual(normalizeGatewayConfig({
    enabled: 'yes', bind: '0.0.0.0', port: 70000, upstream: 'ftp://example.com/x', maxBodyBytes: -1, timeoutMs: 'soon'
  }), DEFAULT_GATEWAY);
  // Valid values survive; the upstream keeps only its origin (the gateway forwards the path as-is).
  assert.deepEqual(normalizeGatewayConfig({
    enabled: true, bind: '::1', port: '9999', upstream: 'http://10.0.0.5:9000/base', maxBodyBytes: 1024, timeoutMs: 500
  }), {
    enabled: true, bind: '::1', port: 9999, upstream: 'http://10.0.0.5:9000', maxBodyBytes: 1024, timeoutMs: 500,
    provider: { name: 'dshlink-phone', secretKey: null }
  });
  // The optional STCP provider for the phone path: name is validated, a placeholder secret is ignored.
  assert.deepEqual(normalizeGatewayConfig({ provider: { name: 'my phone provider!', secretKey: 'CHANGE_ME' } }).provider,
    { name: 'dshlink-phone', secretKey: null });
  assert.deepEqual(normalizeGatewayConfig({ provider: { name: 'dshlink-phone-gw', secretKey: '  s3cret  ' } }).provider,
    { name: 'dshlink-phone-gw', secretKey: 's3cret' });
});

test('isLoopbackAddress accepts loopback only', () => {
  for (const good of ['127.0.0.1', '127.5.5.5', '127.255.255.255', '::1', '::ffff:127.0.0.1', 'localhost', 'LOCALHOST']) {
    assert.equal(isLoopbackAddress(good), true, good);
  }
  for (const bad of ['10.0.0.1', '192.0.2.10', '0.0.0.0', '::', 'example.com', '', null, undefined, '::ffff:10.0.0.1']) {
    assert.equal(isLoopbackAddress(bad), false, String(bad));
  }
});

test('rejects missing, invalid and expired tokens before touching upstream', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({
    upstream: upstream.url,
    tokens: [
      { label: 'phone', role: 'device' },
      { label: 'stale', role: 'device', expiresAt: new Date(Date.now() - 60_000).toISOString() }
    ]
  });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const missing = await call(ctx.base, '/api/v1/info');
  assert.equal(missing.status, 401);
  assert.equal(missing.json.error.code, 'unauthorized');
  assert.match(missing.headers.get('www-authenticate') ?? '', /^Bearer /);

  const invalid = await call(ctx.base, '/api/v1/info', { token: 'not-a-real-token' });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.json.error.code, 'unauthorized');

  const expired = await call(ctx.base, '/api/v1/info', { token: ctx.tokens.stale });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.error.code, 'unauthorized');

  // cfg.auth.trustLocalhost is true in this fixture; a request without a token still gets 401 and
  // nothing reached the node.
  assert.equal(upstream.requests.length, 0);
});

test('forwards a valid device request and passes status/headers/body through', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const res = await call(ctx.base, '/api/v1/dsh/workspaces?limit=5', { token: ctx.tokens.phone });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream'), 'echo');
  assert.equal(res.json.path, '/api/v1/dsh/workspaces?limit=5');
  assert.equal(res.json.ok, true);

  assert.equal(upstream.requests.length, 1);
  const seen = upstream.requests[0];
  assert.equal(seen.method, 'GET');
  assert.equal(seen.url, '/api/v1/dsh/workspaces?limit=5');
  // The node must see the caller's token so it can derive the device role itself.
  assert.equal(seen.headers.authorization, 'Bearer ' + ctx.tokens.phone);
});

test('device policy allows dsh/info/healthz/network and denies everything else', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });
  const token = ctx.tokens.phone;

  const allowed = [
    ['GET', '/healthz'],
    ['GET', '/api/v1/info'],
    ['GET', '/api/v1/dsh/workspaces'],
    ['GET', '/api/v1/network/nodes'],
    ['POST', '/api/v1/dsh/call']
  ];
  for (const [method, pathname] of allowed) {
    const body = method === 'POST' ? '{}' : undefined;
    const res = await call(ctx.base, pathname, { method, token, body });
    assert.equal(res.status, method === 'POST' ? 202 : 200, method + ' ' + pathname);
  }
  assert.equal(upstream.requests.length, allowed.length);

  const denied = [
    ['GET', '/api/v1/peers'],
    ['GET', '/api/v1/messages'],
    ['GET', '/api/v1/status'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/network'],
    ['POST', '/api/v1/info'],
    ['DELETE', '/api/v1/dsh/workspaces']
  ];
  for (const [method, pathname] of denied) {
    const res = await call(ctx.base, pathname, { method, token });
    assert.equal(res.status, 403, method + ' ' + pathname);
    assert.equal(res.json.error.code, 'role_forbidden', method + ' ' + pathname);
  }
  // Denied requests never reached the node.
  assert.equal(upstream.requests.length, allowed.length);
});

test('admin token may reach admin routes; a device token may not', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({
    upstream: upstream.url,
    tokens: [{ label: 'phone', role: 'device' }, { label: 'boss', role: 'admin' }]
  });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const admin = await call(ctx.base, '/api/v1/peers', { token: ctx.tokens.boss });
  assert.equal(admin.status, 200);
  assert.equal(upstream.requests[0].headers.authorization, 'Bearer ' + ctx.tokens.boss);

  const device = await call(ctx.base, '/api/v1/peers', { token: ctx.tokens.phone });
  assert.equal(device.status, 403);
  assert.equal(device.json.error.code, 'role_forbidden');
  assert.equal(upstream.requests.length, 1);
});

test('always denies /mcp and /api/v1/bridge/*, for every role', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({
    upstream: upstream.url,
    tokens: [{ label: 'phone', role: 'device' }, { label: 'boss', role: 'admin' }]
  });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const cases = [
    ['POST', '/mcp', ctx.tokens.boss, 403, 'forbidden'],
    ['GET', '/MCP', ctx.tokens.boss, 403, 'forbidden'],
    ['GET', '/api/v1/bridge/status', ctx.tokens.boss, 403, 'forbidden'],
    ['GET', '/api/v1/bridge', ctx.tokens.boss, 403, 'forbidden'],
    ['GET', '/api/v1/bridge/status', ctx.tokens.phone, 403, 'forbidden']
  ];
  for (const [method, pathname, token, status, code] of cases) {
    const body = method === 'POST' ? '{}' : undefined;
    const res = await call(ctx.base, pathname, { method, token, body });
    assert.equal(res.status, status, method + ' ' + pathname);
    assert.equal(res.json.error.code, code, method + ' ' + pathname);
  }
  assert.equal(upstream.requests.length, 0);
});

test('POST body, content-type and query are forwarded; upstream status passes through', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const payload = JSON.stringify({ method: 'dsh.workspaces.list', params: { limit: 3 } });
  const res = await call(ctx.base, '/api/v1/dsh/call?wait=1', {
    method: 'POST',
    token: ctx.tokens.phone,
    headers: { 'content-type': 'application/json' },
    body: payload
  });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('x-upstream'), 'echo');
  assert.equal(res.json.accepted, true);
  assert.equal(res.json.path, '/api/v1/dsh/call?wait=1');

  assert.equal(upstream.requests.length, 1);
  const seen = upstream.requests[0];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/api/v1/dsh/call?wait=1');
  assert.equal(seen.body, payload);
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers['content-length'], String(Buffer.byteLength(payload)));
  assert.equal(seen.headers.authorization, 'Bearer ' + ctx.tokens.phone);
});

test('Range requests for file downloads are forwarded (so resumable pulls work)', async (t) => {
  const upstream = await startEchoUpstream();
  const cfgAdmin = await makeGateway({ upstream: upstream.url, tokens: [{ label: 'admin', role: 'admin' }] });
  t.after(async () => { await cfgAdmin.close(); await upstream.close(); });

  const res = await call(cfgAdmin.base, '/api/v1/files/ws/big.bin', {
    token: cfgAdmin.tokens.admin,
    headers: { range: 'bytes=0-1023' }
  });
  assert.equal(res.status, 200);
  assert.equal(upstream.requests.length, 1);
  // The node's file download route reads req.headers.range; for it not to be lost here it must
  // survive the gateway hop, otherwise a remote pull silently degrades to a full download.
  assert.equal(upstream.requests[0].headers.range, 'bytes=0-1023');
});

test('X-DSHLink-Token alone authenticates and is forwarded as-is', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const res = await call(ctx.base, '/api/v1/info', { headers: { 'x-dshlink-token': ctx.tokens.phone } });
  assert.equal(res.status, 200);
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].headers['x-dshlink-token'], ctx.tokens.phone);
  assert.equal(upstream.requests[0].headers.authorization, undefined);
  assert.equal(res.json.tokenHeader, ctx.tokens.phone);
});

test('rejects an over-limit body with 413 before forwarding', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url, maxBodyBytes: 16 });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const tooBig = JSON.stringify({ payload: 'x'.repeat(200) });
  const declared = await call(ctx.base, '/api/v1/dsh/call', {
    method: 'POST', token: ctx.tokens.phone, headers: { 'content-type': 'application/json' }, body: tooBig
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.json.error.code, 'payload_too_large');

  // Same limit for a chunked body without a Content-Length header.
  const chunked = await chunkedPost(ctx.base, '/api/v1/dsh/call', ctx.tokens.phone, ['x'.repeat(20), 'y'.repeat(20)]);
  assert.equal(chunked.status, 413);
  assert.equal(upstream.requests.length, 0);
});

test('unreachable upstream yields 502 and the gateway keeps serving', async (t) => {
  const deadPort = await freeClosedPort();
  const ctx = await makeGateway({ upstream: 'http://127.0.0.1:' + deadPort, tokens: [{ label: 'phone', role: 'device' }] });
  t.after(async () => { await ctx.close(); });

  const res = await call(ctx.base, '/api/v1/info', { token: ctx.tokens.phone });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'bad_gateway');

  // The server is still alive after the connection error.
  const alive = await call(ctx.base, '/api/v1/info');
  assert.equal(alive.status, 401);
  assert.equal(alive.json.error.code, 'unauthorized');
});

test('a stalled upstream yields 504 gateway_timeout', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url, timeoutMs: 150 });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const res = await call(ctx.base, '/api/v1/dsh/slow', { token: ctx.tokens.phone });
  assert.equal(res.status, 504);
  assert.equal(res.json.error.code, 'gateway_timeout');

  const alive = await call(ctx.base, '/api/v1/info', { token: ctx.tokens.phone });
  assert.equal(alive.status, 200);
});

test('hot reload: token changes are picked up without restarting the gateway', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const added = createInboundToken(ctx.cfg, 'later-admin', { role: 'admin' });
  const admin = await call(ctx.base, '/api/v1/peers', { token: added.token });
  assert.equal(admin.status, 200);

  // Revoking works the same way: verifyToken() runs against the live config object.
  ctx.cfg.auth.tokens = ctx.cfg.auth.tokens.filter((entry) => entry.label !== 'phone');
  const revoked = await call(ctx.base, '/api/v1/info', { token: ctx.tokens.phone });
  assert.equal(revoked.status, 401);
});

test('close() stops the listener and is idempotent', async (t) => {
  const upstream = await startEchoUpstream();
  const ctx = await makeGateway({ upstream: upstream.url });
  t.after(async () => { await ctx.close(); await upstream.close(); });

  const before = await call(ctx.base, '/api/v1/info', { token: ctx.tokens.phone });
  assert.equal(before.status, 200);

  await ctx.close();
  await ctx.close();
  await assert.rejects(fetch(ctx.base + '/healthz'));
});
