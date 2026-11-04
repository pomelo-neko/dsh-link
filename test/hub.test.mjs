// Tests for the 0.8 hub topology: hub config/store/HTTP, node uplink (HubLink), the hub
// branches inside ops, the file/DSH proxies and the CLI hub subcommands.
//
// Every test uses a throwaway data directory under test/.tmp/unit/hub-* and real loopback HTTP,
// so the same code paths that run in production are exercised (no stubs for the hub server).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { TMP, PROJECT_DIR } from './helpers.mjs';
import {
  DEFAULT_HUB_ENROLLMENT, defaultHubConfig, normalizeHubConfig, createHubToken, verifyHubToken,
  hubPublicInfo, saveHubConfig, loadHubConfig, hubConfigPathFor
} from '../src/hubconfig.mjs';
import { HubStore } from '../src/hubstore.mjs';
import { createHub } from '../src/hub.mjs';
import { HubLink, createHubLink } from '../src/hublink.mjs';
import { hubFrpConfigToml } from '../src/hubfrp.mjs';
import { frpConfigToml, parseFrpcTomlSummary } from '../src/tunnel.mjs';
import { MessageStore } from '../src/store.mjs';
import { FileRoots } from '../src/fsroot.mjs';
import { createOps } from '../src/ops.mjs';
import { createLinkServer } from '../src/server.mjs';
import { createInboundToken, normalizeConfig, normalizeHubConfig as normalizeNodeHubConfig, saveConfig } from '../src/config.mjs';
import { createDshView } from '../src/dshview.mjs';
import { createBridgePresence, createCommandQueue } from '../src/capabilities.mjs';
import { sha256Hex } from '../src/util.mjs';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
let counter = 0;

async function freshDir(label) {
  counter += 1;
  const dir = path.join(TMP, 'hub-' + label + '-' + counter);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function startHub(label, overrides = {}) {
  const dir = await freshDir('hub-' + label);
  const raw = {
    name: 'HUB-' + label.toUpperCase(),
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    enrollment: { rateLimitPerMinute: 300, maxUsesPerToken: 20, maxNodes: 20 },
    ...overrides
  };
  const cfg = normalizeHubConfig(raw, dir);
  cfg.dataDir = dir;
  cfg.configPath = hubConfigPathFor({ dataDir: dir });
  const store = await new HubStore(dir).init();
  const admin = createHubToken(cfg, 'admin', { role: 'admin' });
  const device = createHubToken(cfg, 'device', { role: 'device' });
  const enroll = createHubToken(cfg, 'enroll', { role: 'enroll', maxUses: 20 });
  const hub = createHub({ cfg, store, logger: QUIET, saveConfig: async (next) => { await saveHubConfig(next); } });
  const info = await hub.listen({ port: 0, bind: '127.0.0.1' });
  return {
    dir, cfg, store, hub, url: info.url, adminToken: admin.token,
    deviceToken: device.token, enrollToken: enroll.token,
    close: () => hub.close()
  };
}

async function startNode(label, opts = {}) {
  const dir = await freshDir('node-' + label);
  const ws = path.join(dir, 'ws');
  await fs.mkdir(ws, { recursive: true });
  const raw = {
    name: 'NODE-' + label.toUpperCase(),
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    auth: { trustLocalhost: false, tokens: [] },
    files: { allowUpload: true, roots: [{ name: 'ws', path: ws, read: true, write: true }] },
    dsh: { enabled: false },
    capabilities: { enabled: false, methods: [] },
    peers: [],
    relay: { enabled: false },
    stcp: { proxyName: 'dshlink-node-' + label, secretKey: 'secret-node-' + label }
  };
  const cfg = normalizeConfig(raw, dir);
  cfg.configPath = path.join(dir, 'dshlink.config.json');
  const admin = createInboundToken(cfg, 'local-admin', { role: 'admin' });
  cfg.hub = normalizeNodeHubConfig(opts.hub ?? {});
  await saveConfig(cfg);
  const store = await new MessageStore(dir).init();
  const dsh = createDshView({ cfg: cfg.dsh });
  const roots = new FileRoots({ ...cfg.files, maxListEntries: cfg.limits.maxListEntries }, { dshView: dsh });
  const commands = createCommandQueue({ dir: path.join(dir, 'commands'), cfg: cfg.capabilities });
  const presence = createBridgePresence({ dir: path.join(dir, 'commands'), cfg: cfg.capabilities });
  const hubLink = createHubLink({ cfg, logger: QUIET, save: async (next) => { await saveConfig(next); } });
  const ops = createOps({ cfg, store, roots, dsh, commands, presence, hubLink, logger: QUIET });
  const link = createLinkServer({ cfg, store, roots, ops, logger: QUIET });
  const info = await link.listen({ port: 0, bind: '127.0.0.1' });
  const close = async () => { if (hubLink.enabled) hubLink.stop(); await link.close(); };
  return { label, dir, ws, cfg, store, roots, ops, hubLink, link, url: info.url, adminToken: admin.token, close };
}

async function enroll(node, hub) {
  const result = await node.hubLink.enroll({ url: hub.url, token: hub.enrollToken, downlinkUrl: node.url });
  assert.equal(result.result.node.status, 'active');
  return result;
}

async function httpJson(url, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = 'Bearer ' + token;
  if (body !== undefined && requestHeaders['content-type'] === undefined) requestHeaders['content-type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (err) { json = null; }
  return { status: response.status, json, text, headers: response.headers };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [path.join(PROJECT_DIR, 'bin', 'dshlink.mjs'), ...args], {
    encoding: 'utf8',
    cwd: PROJECT_DIR
  });
  return result;
}

function cliJson(args) {
  const result = runCli(args);
  assert.equal(result.status, 0, 'dshlink ' + args.join(' ') + ' failed\nstdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    assert.fail('expected JSON on stdout from dshlink ' + args.join(' ') + '\nstdout:\n' + result.stdout.slice(0, 800));
  }
}

// ---------------------------------------------------------------- config/store ---

test('hub: config defaults, token roles and static nodes', async () => {
  const dir = await freshDir('config');
  const defaults = defaultHubConfig({ dataDir: dir, name: 'HUB-X', port: 0 });
  assert.equal(defaults.role, 'hub');
  assert.equal(defaults.port, 0);
  assert.equal(defaults.bind, '127.0.0.1');
  assert.equal(defaults.enrollment.autoApprove, true);
  assert.equal(defaults.enrollment.tokenTtlHours, 2);
  assert.equal(defaults.enrollment.maxUsesPerToken, 1);
  assert.equal(defaults.frp.enabled, false);
  assert.equal(defaults.frp.provider.name, 'dshlink-hub');

  const cfg = normalizeHubConfig({
    name: '  h  ',
    bind: '0.0.0.0',
    port: '9000',
    enrollment: { autoApprove: false, maxNodes: 3, tokenTtlHours: 4, rateLimitPerMinute: 7 },
    auth: { tokens: [{ label: 'one-shot', token: 'plain-enroll-token', role: 'enroll', maxUses: 2 }] },
    nodes: [{ name: 'N1', url: 'http://127.0.0.1:8080/' , token: 'static-downlink'}]
  }, dir);
  assert.equal(cfg.name, 'h');
  assert.equal(cfg.bind, '0.0.0.0');
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.enrollment.autoApprove, false);
  assert.equal(cfg.enrollment.maxNodes, 3);
  assert.equal(cfg.enrollment.tokenTtlHours, 4);
  assert.equal(cfg.enrollment.rateLimitPerMinute, 7);
  assert.equal(cfg.auth.tokens.length, 1);
  // Plaintext tokens are kept verbatim so operators can hand them to the CLI; verify-token
  // supports both hashed and plaintext entries.
  assert.equal(cfg.auth.tokens[0].token, 'plain-enroll-token');
  assert.equal(cfg.auth.tokens[0].maxUses, 2);
  assert.equal(cfg.nodes[0].name, 'N1');
  assert.equal(cfg.nodes[0].url, 'http://127.0.0.1:8080');
  assert.equal(cfg.nodes[0].token, 'static-downlink');

  const matched = verifyHubToken(cfg, 'plain-enroll-token');
  assert.equal(matched.role, 'enroll');
  assert.equal(matched.maxUses, 2);
  assert.equal(verifyHubToken(cfg, 'nope'), null);

  const minted = createHubToken(cfg, 'extra-enroll', { role: 'enroll', maxUses: 1 });
  assert.match(minted.token, /^[A-Za-z0-9_-]+$/);
  const verified = verifyHubToken(cfg, minted.token);
  assert.equal(verified.id, minted.id);
  assert.equal(verified.role, 'enroll');
  assert.equal(verified.maxUses, 1);
  assert.throws(() => createHubToken(cfg, 'bad-peer', { role: 'peer' }), /needs the node name/);

  const info = hubPublicInfo(cfg, { nodes: 0 });
  assert.equal(info.role, 'hub');
  assert.equal(info.software, 'dsh-link-hub');
  assert.equal(info.enrollment.enabled, true);
  assert.equal(info.enrollment.mode, 'token');
  assert.equal(JSON.stringify(info).includes('plain-enroll-token'), false);

  // Round-trip through the hub config file.
  cfg.dataDir = dir;
  await saveHubConfig(cfg);
  const loaded = await loadHubConfig({ dataDir: dir });
  assert.equal(loaded.name, 'h');
  assert.equal(loaded.port, 9000);
  assert.equal(verifyHubToken(loaded, 'plain-enroll-token').role, 'enroll');
  assert.equal(loaded.configPath, hubConfigPathFor({ dataDir: dir }));
  const missing = path.join(dir, 'missing');
  await assert.rejects(() => loadHubConfig({ dataDir: missing }), (err) => err.code === 'hub_config_missing');

  // Node-side hub block normalization.
  const node = normalizeConfig({
    name: 'NODE-X',
    dataDir: dir,
    hub: {
      enabled: true,
      url: 'http://hub.example:8790/',
      token: 'uplink',
      visitorPort: 19000,
      frp: { serverName: 'node-x-provider', secretKey: 'node-x-secret' }
    }
  }, dir);
  assert.equal(node.hub.enabled, true);
  assert.equal(node.hub.url, 'http://hub.example:8790');
  assert.equal(node.hub.token, 'uplink');
  assert.equal(node.hub.visitorPort, 19000);
  assert.equal(node.hub.frp.serverName, 'node-x-provider');

  // The node's frpc publishes a visitor to the hub, and the hub's frpc publishes the hub port
  // plus one visitor per enrolled node.
  const tunnelCfg = normalizeConfig({
    name: 'NODE-Y',
    dataDir: dir,
    stcp: { proxyName: 'dshlink-node-y', secretKey: 'node-y-secret' },
    tunnel: { enabled: true, serverAddr: '127.0.0.1', serverPort: 7000, adminPort: 7400 },
    hub: {
      enabled: true,
      url: 'http://127.0.0.1:18790',
      visitorPort: 18790,
      frp: { serverName: 'hub-provider', secretKey: 'hub-secret' }
    }
  }, dir);
  const nodeToml = frpConfigToml(tunnelCfg);
  assert.match(nodeToml, /name = "to-hub"/);
  assert.match(nodeToml, /serverName = "hub-provider"/);
  assert.match(nodeToml, /bindPort = 18790/);
  const nodeSummary = parseFrpcTomlSummary(nodeToml);
  assert.equal(nodeSummary.visitors.length, 1);
  assert.equal(nodeSummary.visitors[0].name, 'to-hub');

  const hubCfg = normalizeHubConfig({
    name: 'HUB-FRP',
    port: 8790,
    frp: {
      enabled: true,
      serverAddr: 'frp.example',
      serverPort: 7000,
      provider: { name: 'dshlink-hub-test', secretKey: 'hub-provider-secret' }
    }
  }, dir);
  const hubToml = hubFrpConfigToml(hubCfg, [
    { name: 'NODE-A', visitorPort: 19111, provider: { serverName: 'node-a-provider', secretKey: 'node-a-secret' } }
  ]);
  assert.match(hubToml, /name = "dshlink-hub-test"/);
  assert.match(hubToml, /localPort = 8790/);
  assert.match(hubToml, /name = "to-NODE-A"/);
  assert.match(hubToml, /bindPort = 19111/);
  const hubSummary = parseFrpcTomlSummary(hubToml);
  assert.equal(hubSummary.visitors.length, 1);
  assert.throws(() => hubFrpConfigToml(normalizeHubConfig({ frp: { enabled: true } }, dir)), (err) => err.code === 'frp_not_configured');
});

test('hub: store keeps nodes, a durable outbox and small caches', async () => {
  const dir = await freshDir('store');
  const store = await new HubStore(dir).init();
  await store.upsertNode({ name: 'B-NODE', status: 'active', url: 'http://127.0.0.1:1', token: 'b' });
  await store.upsertNode({ name: 'A-NODE', status: 'pending' });
  let nodes = await store.listNodes();
  assert.deepEqual(nodes.map((n) => n.name), ['A-NODE', 'B-NODE']);
  assert.equal((await store.getNode('A-NODE')).status, 'pending');
  const merged = await store.upsertNode({ name: 'A-NODE', status: 'active', note: 'approved' });
  assert.equal(merged.note, 'approved');
  assert.equal(merged.status, 'active');
  assert.ok(merged.updatedAt);
  assert.equal(await store.removeNode('B-NODE'), true);
  assert.equal(await store.removeNode('B-NODE'), false);
  assert.equal((await store.listNodes()).length, 1);

  const record = {
    id: 'msg_hub_store_1',
    ts: new Date().toISOString(),
    from: { nodeId: 'n1', name: 'A-NODE', url: 'http://127.0.0.1:1' },
    to: 'B-NODE',
    thread: 'thread-store',
    subject: 'hello',
    body: 'body',
    attachments: []
  };
  await store.appendOutbox(record);
  const again = await store.appendOutbox(record);
  assert.equal(again.id, record.id);
  assert.equal((await store.listOutbox({})).messages.length, 1);
  assert.equal((await store.pendingOutbox()).length, 1);
  await store.setDelivery(record.id, { state: 'delivered', via: 'B-NODE' });
  assert.equal((await store.pendingOutbox()).length, 0);
  const listed = await store.listOutbox({ pendingOnly: true });
  assert.equal(listed.count, 0);
  const all = await store.listOutbox({ limit: 10 });
  assert.equal(all.count, 1);
  assert.equal(all.messages[0].delivery.state, 'delivered');
  assert.equal(await store.getOutbox('msg_missing'), null);

  assert.equal(await store.tokenUses('tok_1'), 0);
  await store.recordEnrollUse('tok_1');
  await store.recordEnrollUse('tok_1');
  assert.equal(await store.tokenUses('tok_1'), 2);
  await store.rememberCommand('cmd_1', 'A-NODE');
  assert.equal(await store.commandPeer('cmd_1'), 'A-NODE');
  assert.equal(await store.commandPeer('cmd_missing'), null);
  await store.rememberRunning('A-NODE', { status: 'ok', sessions: [{ sessionId: 's1', running: true }] });
  const cache = await store.runningCache();
  assert.equal(cache['A-NODE'].payload.sessions[0].running, true);
  await store.audit({ event: 'test_event', value: 1 });
  const audit = await store.recentAudit(5);
  assert.equal(audit[0].event, 'test_event');
  const counts = await store.counts();
  assert.equal(counts.nodes, 1);
  assert.equal(counts.outboxPending, 0);

  // The second store instance sees the persisted files.
  const reopened = await new HubStore(dir).init();
  assert.equal((await reopened.listNodes()).length, 1);
  assert.equal(await reopened.tokenUses('tok_1'), 2);
  assert.equal((await reopened.listOutbox({})).count, 1);
});

// ------------------------------------------------------------------ hub HTTP ---

test('hub: HTTP auth, roles and info surface', async (t) => {
  const hub = await startHub('auth');
  t.after(() => hub.close());

  const health = await httpJson(hub.url + '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.role, 'hub');
  assert.equal(health.json.name, hub.cfg.name);

  // No trustLocalhost: a loopback request without a token is still rejected.
  const anonymous = await httpJson(hub.url + '/api/v1/info');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.error.code, 'unauthorized');

  const wrong = await httpJson(hub.url + '/api/v1/info', { token: 'not-a-token' });
  assert.equal(wrong.status, 401);

  const enrolled = await httpJson(hub.url + '/api/v1/info', { token: hub.enrollToken });
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.json.role, 'hub');
  assert.equal(enrolled.json.enrollment.enabled, true);
  assert.ok(enrolled.json.files.maxBytes > 0);

  const statusAsEnroll = await httpJson(hub.url + '/api/v1/hub/status', { token: hub.enrollToken });
  assert.equal(statusAsEnroll.status, 403);
  assert.equal(statusAsEnroll.json.error.code, 'role_forbidden');

  const status = await httpJson(hub.url + '/api/v1/hub/status', { token: hub.adminToken });
  assert.equal(status.status, 200);
  assert.equal(status.json.counts.nodes, 0);
  assert.equal(status.json.enrollment.tokenTtlHours, 2);
  assert.equal(status.json.frp.enabled, false);

  const nodes = await httpJson(hub.url + '/api/v1/hub/nodes', { token: hub.deviceToken });
  assert.equal(nodes.status, 200);
  assert.equal(nodes.json.count, 0);
  const denied = await httpJson(hub.url + '/api/v1/hub/nodes/NOPE', { method: 'DELETE', token: hub.deviceToken });
  assert.equal(denied.status, 403);

  const network = await httpJson(hub.url + '/api/v1/network/nodes', { token: hub.adminToken });
  assert.equal(network.status, 200);
  assert.equal(network.json.self.kind, 'hub');
  assert.equal(network.json.self.role, 'hub');
  assert.equal(network.json.nodes.length, 1);
  assert.equal(network.json.nodes[0].self, true);
  assert.equal(network.json.count, 1);

  const mcp = await httpJson(hub.url + '/mcp', { method: 'POST', token: hub.adminToken, body: {} });
  assert.equal(mcp.status, 404);
  const bridge = await httpJson(hub.url + '/api/v1/bridge/status', { token: hub.adminToken });
  assert.equal(bridge.status, 404);
});

// ------------------------------------------------------------- message switch ---

test('hub: enroll two nodes, deliver messages both ways, dedupe and identity checks', async (t) => {
  const hub = await startHub('e2e');
  const a = await startNode('a');
  const b = await startNode('b');
  t.after(async () => { await a.close(); await b.close(); await hub.close(); });

  const enrolledA = await enroll(a, hub);
  const enrolledB = await enroll(b, hub);
  assert.equal(enrolledA.result.uplink.role, 'peer');
  assert.equal(enrolledA.result.uplink.peer, a.cfg.name);
  assert.ok(enrolledB.result.uplinkToken);
  assert.equal(enrolledA.result.frp, null);

  await a.hubLink.heartbeat();
  await b.hubLink.heartbeat();
  assert.equal(a.hubLink.status().state, 'online');
  assert.equal(b.hubLink.status().state, 'online');

  const nodes = await httpJson(hub.url + '/api/v1/hub/nodes', { token: hub.adminToken });
  assert.equal(nodes.json.count, 2);
  const nodeA = nodes.json.nodes.find((n) => n.name === a.cfg.name);
  assert.equal(nodeA.status, 'online');
  assert.equal(nodeA.kind, 'node');

  // A -> hub -> B
  const sent = await a.ops.sendMessage({ to: b.cfg.name, subject: 'via hub', body: 'hello from a', targetSession: 'session-on-b' });
  assert.equal(sent.delivery.state, 'delivered');
  assert.equal(sent.delivery.via, 'hub');
  const bInbox = await b.ops.inbox({});
  assert.equal(bInbox.count, 1);
  assert.equal(bInbox.messages[0].body, 'hello from a');
  assert.equal(bInbox.messages[0].from.name, a.cfg.name);
  assert.equal(bInbox.messages[0].targetSession, 'session-on-b');

  // B -> hub -> A in the same thread
  const reply = await b.ops.sendMessage({
    to: a.cfg.name,
    subject: 'Re: via hub',
    body: 'pong from b',
    thread: sent.message.thread,
    replyTo: sent.message.id
  });
  assert.equal(reply.delivery.state, 'delivered');
  const aInbox = await a.ops.inbox({});
  assert.equal(aInbox.count, 1);
  assert.equal(aInbox.messages[0].body, 'pong from b');
  assert.equal(aInbox.messages[0].thread, sent.message.thread);

  const hubStatus = await httpJson(hub.url + '/api/v1/hub/status', { token: hub.adminToken });
  assert.equal(hubStatus.json.counts.nodes, 2);
  assert.equal(hubStatus.json.counts.outboxPending, 0);
  const outbox = await httpJson(hub.url + '/api/v1/hub/outbox', { token: hub.adminToken });
  assert.equal(outbox.json.count, 2);
  assert.ok(outbox.json.messages.every((m) => m.delivery.state === 'delivered'));

  // Duplicate delivery is idempotent: the same id twice reaches the inbox once.
  const duplicateId = 'msg_hub_dup_1';
  const duplicate = {
    id: duplicateId,
    ts: new Date().toISOString(),
    from: { nodeId: a.cfg.nodeId, name: a.cfg.name, url: a.url },
    to: b.cfg.name,
    thread: 'thread-dup',
    subject: 'dup',
    body: 'only once',
    attachments: []
  };
  const first = await httpJson(hub.url + '/api/v1/messages', { method: 'POST', token: a.cfg.hub.token, body: duplicate });
  assert.equal(first.status, 202);
  assert.equal(first.json.accepted, true);
  const second = await httpJson(hub.url + '/api/v1/messages', { method: 'POST', token: a.cfg.hub.token, body: duplicate });
  assert.equal(second.status, 202);
  assert.equal(second.json.duplicate, true);
  const dupThread = await b.ops.inbox({ thread: 'thread-dup' });
  assert.equal(dupThread.count, 1);

  // A peer token cannot claim to be another node.
  const spoof = await httpJson(hub.url + '/api/v1/messages', {
    method: 'POST',
    token: b.cfg.hub.token,
    body: { ...duplicate, id: 'msg_hub_spoof_1', from: { nodeId: 'x', name: a.cfg.name } }
  });
  assert.equal(spoof.status, 403);
  assert.equal(spoof.json.error.code, 'identity_mismatch');

  // Sending to a node that is not enrolled fails, and the node keeps the message queued.
  const ghost = await a.ops.sendMessage({ to: 'GHOST-NODE', subject: 'nowhere', body: 'x' });
  assert.equal(ghost.delivery.state, 'pending');
  assert.equal(ghost.delivery.via, 'hub');
  assert.match(ghost.delivery.error, /not enrolled/);

  // Hub mode never relays peer traffic itself.
  await assert.rejects(
    () => a.ops.acceptMessage({ id: 'msg_relay_1', to: b.cfg.name, from: { name: 'X' }, subject: 's', body: 'b' }),
    (err) => err.status === 403 && err.code === 'relay_through_hub'
  );
  const sync = await a.ops.sync({});
  assert.equal(sync.mode, 'hub');
  const nodeStatus = await a.ops.status();
  assert.equal(nodeStatus.hub.enabled, true);
  assert.equal(nodeStatus.hub.state, 'online');
  assert.equal(nodeStatus.hub.pendingOutbox, 1);
  assert.deepEqual(nodeStatus.hub.pendingTargets, ['GHOST-NODE']);
});

// --------------------------------------------------------- dsh / file proxying ---

test('hub: proxies the DSH view and streams files through the target node', async (t) => {
  const hub = await startHub('proxy');
  const node = await startNode('proxy');
  t.after(async () => { await node.close(); await hub.close(); });
  await enroll(node, hub);

  const dsh = await httpJson(hub.url + '/api/v1/dsh/workspaces?peer=' + encodeURIComponent(node.cfg.name), { token: hub.adminToken });
  assert.equal(dsh.status, 403);
  assert.equal(dsh.json.error.code, 'dsh_disabled');

  const missingPeer = await httpJson(hub.url + '/api/v1/files?peer=UNKNOWN', { token: hub.adminToken });
  assert.equal(missingPeer.status, 404);
  assert.equal(missingPeer.json.error.code, 'unknown_target');

  await fs.writeFile(path.join(node.ws, 'hello.txt'), 'hello via hub', 'utf8');
  const list = await httpJson(hub.url + '/api/v1/files?peer=' + encodeURIComponent(node.cfg.name) + '&root=ws&path=', { token: hub.adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.json.peer, node.cfg.name);
  assert.ok(list.json.entries.some((entry) => entry.name === 'hello.txt'));

  const download = await fetch(hub.url + '/api/v1/files/download?peer=' + encodeURIComponent(node.cfg.name) + '&root=ws&path=hello.txt', {
    headers: { authorization: 'Bearer ' + hub.adminToken }
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello via hub');
  assert.ok(download.headers.get('content-disposition'));

  const upload = await fetch(hub.url + '/api/v1/files/upload?peer=' + encodeURIComponent(node.cfg.name) + '&root=ws&path=up.txt', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + hub.adminToken, 'content-type': 'text/plain' },
    body: 'uploaded through the hub'
  });
  assert.equal(upload.status, 201);
  const uploadBody = await upload.json();
  assert.equal(uploadBody.peer, node.cfg.name);
  assert.equal(await fs.readFile(path.join(node.ws, 'up.txt'), 'utf8'), 'uploaded through the hub');

  const deviceFiles = await httpJson(hub.url + '/api/v1/files?peer=' + encodeURIComponent(node.cfg.name), { token: hub.deviceToken });
  assert.equal(deviceFiles.status, 403);
  assert.equal(deviceFiles.json.error.code, 'role_forbidden');

  const audit = await httpJson(hub.url + '/api/v1/audit?limit=50', { token: hub.adminToken });
  const events = audit.json.entries.map((entry) => entry.event);
  assert.ok(events.includes('hub_file_download'));
  assert.ok(events.includes('hub_file_upload'));
  assert.ok(events.includes('hub_enroll'));
});

// ------------------------------------------------------------------ hublink ---

test('hublink: state machine, backoff and delivery guard', async () => {
  const dir = await freshDir('hublink');
  const raw = {
    name: 'NODE-LINK',
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    hub: { enabled: true, url: 'http://127.0.0.1:1', token: 'uplink-token', heartbeatSeconds: 30, reconnect: { minSeconds: 5, maxSeconds: 60 } }
  };
  const cfg = normalizeConfig(raw, dir);
  const link = createHubLink({ cfg, logger: QUIET });
  assert.equal(link.enabled, true);
  assert.equal(link.url, 'http://127.0.0.1:1');
  assert.equal(link.status().enabled, true);
  assert.equal(link.backoffSeconds(), 5);

  const offline = await link.heartbeat();
  assert.equal(offline.state, 'offline');
  assert.equal(offline.attempts, 1);
  assert.ok(offline.lastError);
  assert.ok(offline.nextRetryAt);

  link.attempts = 3;
  assert.equal(link.backoffSeconds(), 40);
  link.attempts = 10;
  assert.equal(link.backoffSeconds(), 60);

  link.setPendingCount(4);
  assert.equal(link.pendingCount(), 4);
  link.setPendingCount(-1);
  assert.equal(link.pendingCount(), 0);

  const reconnect = await link.reconnect();
  assert.equal(reconnect.state, 'offline');
  assert.equal(reconnect.attempts, 1);
  link.stop();
  assert.equal(link.status().state, 'offline');

  await assert.rejects(
    () => createHubLink({ cfg: normalizeConfig({ name: 'NODE-PLAIN', dataDir: dir }, dir), logger: QUIET }).deliverMessage({ id: 'x' }),
    (err) => err.status === 409 && err.code === 'hub_disabled'
  );
  const disabled = createHubLink({ cfg: normalizeConfig({ name: 'NODE-PLAIN', dataDir: dir }, dir), logger: QUIET });
  assert.equal(disabled.status().state, 'disabled');
  assert.equal(disabled.status().enabled, false);
});

// ---------------------------------------------------------------------- CLI ---

test('hub: CLI initialises, inspects and mints tokens', async () => {
  const dir = await freshDir('cli');
  const init = cliJson(['hub', 'init', '--data-dir', dir, '--name', 'CLI-HUB', '--port', '18765', '--json']);
  assert.equal(init.name, 'CLI-HUB');
  assert.equal(init.url, 'http://127.0.0.1:18765');
  assert.ok(init.adminToken);
  assert.ok(init.frp.provider.secretKey);
  assert.equal(init.config, path.join(dir, 'dshlink-hub.config.json'));
  assert.ok((await fs.readFile(init.config, 'utf8')).includes('CLI-HUB'));

  const status = cliJson(['hub', 'status', '--data-dir', dir, '--json']);
  assert.equal(status.hub.name, 'CLI-HUB');
  assert.equal(status.hub.role, 'hub');
  assert.equal(status.nodes.length, 0);
  assert.equal(status.enrollment.autoApprove, true);
  assert.equal(status.enrollment.tokenTtlHours, 2);

  const token = cliJson(['hub', 'token', 'new', '--data-dir', dir, '--role', 'enroll', '--ttl-hours', '2', '--json']);
  assert.equal(token.role, 'enroll');
  assert.equal(token.maxUses, 1);
  const ttlMs = Date.parse(token.expiresAt) - Date.now();
  assert.ok(ttlMs > 90 * 60 * 1000 && ttlMs <= 121 * 60 * 1000, 'enroll token TTL should be ~2h, got ' + token.expiresAt);

  const list = cliJson(['hub', 'token', 'list', '--data-dir', dir, '--json']);
  assert.equal(list.count, 2);
  const roles = list.tokens.map((entry) => entry.role).sort();
  assert.deepEqual(roles, ['admin', 'enroll']);

  const nodes = cliJson(['hub', 'nodes', '--data-dir', dir, '--json']);
  assert.equal(nodes.count, 0);

  const outbox = cliJson(['hub', 'outbox', '--data-dir', dir, '--json']);
  assert.equal(outbox.count, 0);

  const revoke = runCli(['hub', 'revoke', 'NOPE', '--data-dir', dir]);
  assert.notEqual(revoke.status, 0, 'revoking an unknown node should fail');
  assert.match(revoke.stdout + revoke.stderr, /no such node/i);
});

// --------------------------------------------------------- web console ---

test('hub: web console serves the UI and its admin APIs', async () => {
  const hub = await startHub('ui', { name: 'HUB-UI', defaultNode: null });
  try {
    // The page itself is a login page: no data, no token, but reachable without auth.
    const page = await httpJson(hub.url + '/ui');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(page.text, /dsh-link <span class="pill">hub<\/span>/);
    assert.match(page.text, /\/api\/v1\/hub\/status/);
    // A data-URI favicon keeps browsers from requesting /favicon.ico (a 404 shows up as a console error).
    assert.match(page.text, /<link rel="icon" href="data:image\/svg\+xml/);
    assert.doesNotMatch(page.text, /tok_/, 'the page must not embed tokens');

    const redirect = await fetch(hub.url + '/', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/ui');

    // Every console API still requires an admin token; device/enroll roles are rejected.
    const anonymous = await httpJson(hub.url + '/api/v1/hub/tokens');
    assert.equal(anonymous.status, 401);
    const asDevice = await httpJson(hub.url + '/api/v1/hub/tokens', { token: hub.deviceToken });
    assert.equal(asDevice.status, 403);
    assert.equal(asDevice.json.error.code, 'role_forbidden');

    // Token listing: metadata only, never the secret or its hash.
    const listed = await httpJson(hub.url + '/api/v1/hub/tokens', { token: hub.adminToken });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.count, 3);
    assert.deepEqual(listed.json.tokens.map((t) => t.role).sort(), ['admin', 'device', 'enroll']);
    const listedText = JSON.stringify(listed.json);
    assert.doesNotMatch(listedText, /"hash"/);
    assert.doesNotMatch(listedText, /"token":/);
    for (const entry of listed.json.tokens) {
      assert.ok(entry.id);
      assert.equal(typeof entry.uses, 'number');
    }

    // Mint an enroll token: defaults to the hub's 2h/maxUses policy and returns the plaintext once.
    const minted = await httpJson(hub.url + '/api/v1/hub/tokens', {
      method: 'POST',
      token: hub.adminToken,
      body: { role: 'enroll', label: 'ui-enroll' }
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.json.entry.role, 'enroll');
    assert.equal(minted.json.entry.label, 'ui-enroll');
    assert.equal(minted.json.entry.maxUses, 20, 'enroll tokens inherit enrollment.maxUsesPerToken');
    const ttlMs = Date.parse(minted.json.entry.expiresAt) - Date.now();
    assert.ok(ttlMs > 90 * 60 * 1000 && ttlMs <= 121 * 60 * 1000, 'enroll tokens default to ~2h, got ' + minted.json.entry.expiresAt);
    assert.ok(minted.json.token && minted.json.token.length > 20);
    const verified = verifyHubToken(hub.cfg, minted.json.token);
    assert.equal(verified.role, 'enroll');

    // Explicit ttlHours 0 means "never expires"; a peer token needs its node name.
    const permanent = await httpJson(hub.url + '/api/v1/hub/tokens', {
      method: 'POST',
      token: hub.adminToken,
      body: { role: 'device', label: 'ui-phone', ttlHours: 0, maxUses: 5 }
    });
    assert.equal(permanent.status, 201);
    assert.equal(permanent.json.entry.expiresAt, null);
    assert.equal(permanent.json.entry.maxUses, 5);
    const badPeer = await httpJson(hub.url + '/api/v1/hub/tokens', {
      method: 'POST', token: hub.adminToken, body: { role: 'peer' }
    });
    assert.equal(badPeer.status, 400);

    // Revoking a token deletes it from the live config and from the file.
    const removed = await httpJson(hub.url + '/api/v1/hub/tokens/' + minted.json.entry.id, {
      method: 'DELETE', token: hub.adminToken
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.json.removed, minted.json.entry.id);
    assert.equal(verifyHubToken(hub.cfg, minted.json.token), null);
    const afterRemove = await httpJson(hub.url + '/api/v1/hub/tokens', { token: hub.adminToken });
    assert.equal(afterRemove.json.count, 4);

    // Config view: settings + console URL, no frp secretKey.
    const config = await httpJson(hub.url + '/api/v1/hub/config', { token: hub.adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.json.hub.name, 'HUB-UI');
    assert.ok(config.json.console.url.endsWith('/ui'));
    assert.equal(config.json.settings.enrollment.tokenTtlHours, 2);
    assert.equal(config.json.settings.files.enabled, true);
    assert.equal(typeof config.json.settings.retrySeconds, 'number');
    assert.doesNotMatch(JSON.stringify(config.json), /secretKey/);

    // Settings: whitelisted keys apply live and persist to the hub config file.
    const patched = await httpJson(hub.url + '/api/v1/hub/settings', {
      method: 'PATCH',
      token: hub.adminToken,
      body: {
        retrySeconds: 9,
        messageTtlSeconds: 3600,
        maxPendingPerTarget: 25,
        enrollment: { autoApprove: false, tokenTtlHours: 6 },
        files: { maxBytes: 1048576 }
      }
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json.applied.sort(), [
      'enrollment.autoApprove', 'enrollment.tokenTtlHours', 'files.maxBytes',
      'maxPendingPerTarget', 'messageTtlSeconds', 'retrySeconds'
    ]);
    assert.equal(hub.cfg.retrySeconds, 9);
    assert.equal(hub.cfg.enrollment.autoApprove, false);
    const reloaded = await loadHubConfig({ configPath: hub.cfg.configPath });
    assert.equal(reloaded.retrySeconds, 9);
    assert.equal(reloaded.enrollment.autoApprove, false);
    assert.equal(reloaded.enrollment.tokenTtlHours, 6);
    assert.equal(reloaded.files.maxBytes, 1048576);

    const unknown = await httpJson(hub.url + '/api/v1/hub/settings', {
      method: 'PATCH', token: hub.adminToken, body: { nope: 1 }
    });
    assert.equal(unknown.status, 400);
    assert.match(unknown.json.error.message, /unknown setting/);
    const outOfRange = await httpJson(hub.url + '/api/v1/hub/settings', {
      method: 'PATCH', token: hub.adminToken, body: { retrySeconds: 0 }
    });
    assert.equal(outOfRange.status, 400);
    const devicePatch = await httpJson(hub.url + '/api/v1/hub/settings', {
      method: 'PATCH', token: hub.deviceToken, body: { retrySeconds: 7 }
    });
    assert.equal(devicePatch.status, 403);

    // Outbox: retry marks a pending message and drops it from the console.
    await hub.store.appendOutbox({
      id: 'msg_ui_pending_1', ts: new Date().toISOString(), thread: 'msg_ui_pending_1',
      from: { name: 'HUB-UI' }, to: 'GHOST-NODE', subject: 'queued', body: 'hello', attachments: []
    });
    const outbox = await httpJson(hub.url + '/api/v1/hub/outbox?limit=10&pending=1', { token: hub.adminToken });
    assert.equal(outbox.status, 200);
    assert.ok(outbox.json.messages.some((m) => m.id === 'msg_ui_pending_1'));
    assert.equal(outbox.json.messages.find((m) => m.id === 'msg_ui_pending_1').delivery.state, 'pending');

    const retried = await httpJson(hub.url + '/api/v1/hub/outbox/msg_ui_pending_1/retry', {
      method: 'POST', token: hub.adminToken
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.json.delivery.state, 'pending');
    assert.match(retried.json.delivery.error, /unknown target node/);

    const flush = await httpJson(hub.url + '/api/v1/hub/flush', { method: 'POST', token: hub.adminToken });
    assert.equal(flush.status, 200);
    assert.equal(typeof flush.json.attempted, 'number');

    const dropped = await httpJson(hub.url + '/api/v1/hub/outbox/msg_ui_pending_1', {
      method: 'DELETE', token: hub.adminToken
    });
    assert.equal(dropped.status, 200);
    assert.equal(dropped.json.delivery.state, 'dropped');
    const missing = await httpJson(hub.url + '/api/v1/hub/outbox/msg_nope/retry', {
      method: 'POST', token: hub.adminToken
    });
    assert.equal(missing.status, 404);

    const running = await httpJson(hub.url + '/api/v1/hub/sessions/running', { token: hub.adminToken });
    assert.equal(running.status, 200);
    assert.equal(running.json.count, 0);
    assert.deepEqual(running.json.nodes, []);
  } finally {
    await hub.close();
  }
});

