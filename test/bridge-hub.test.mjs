import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeNode, resetTmp, TMP } from './helpers.mjs';
import { createInboundToken } from '../src/config.mjs';
import { apply as applyBridge, internals as bridgeInternals } from '../integrations/dsh-link-bridge/lib/index.js';
import { createDshOps } from '../integrations/dsh-link-bridge/lib/dshops.js';
import { buildHubRoutes, registerHubRoutes } from '../integrations/dsh-link-bridge/lib/hub.js';

/**
 * 0.8 hub surface tests: the sessions.list running flag, the state.json hub section the bridge
 * polls from the local node, the two same-origin proxy routes the host half registers on the DSH
 * web server, and the hand-written Settings bundle (lib/client.js) that renders them.
 *
 * This file owns its fixtures on purpose: test/bridge.test.mjs keeps the wake-loop fakeCtx, and
 * importing it would re-register its tests in the same process (test/run.mjs imports every file).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.join(HERE, '..', 'integrations', 'dsh-link-bridge', 'lib', 'client.js');

// ---- Host context fixture (mirrors test/bridge.test.mjs, plus the optional webServer service) ----

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {};
    }
  };
}

function fakeCtx({ strictServices = false, webServer = null, supportsInject = false, createId } = {}) {
  const prompts = [];
  const created = [];
  const logs = [];
  const disposers = [];
  const archived = [];
  const renamed = [];
  const injected = [];
  const listeners = new Map();
  const push = (level) => (...args) => logs.push(level + ': ' + args.join(' '));
  const core = {
    logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: () => {} },
    workspaceRegistry: {
      create: async (dir) => ({ id: 'ws_test', path: dir }),
      archiveSession: async (sessionId) => { archived.push(sessionId); },
      list: () => [{ id: 'ws_test', title: 'test workspace', path: 'D:\\tmp\\ws_test', sessionIds: [] }],
      archivedSessionIds: []
    },
    sessionController: {
      create: async (request) => {
        created.push(request);
        const fallback = createId ? createId(created.length) : 'session-bridge-test';
        return { sessionId: request.sessionId ?? fallback };
      },
      rename: async (request) => { renamed.push(request); return { sessionId: request.sessionId, title: request.title }; },
      prompt: async (request, signal) => {
        if (!signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
        prompts.push({ request, signal });
        return { accepted: true };
      }
    },
    effect: (execute) => { disposers.push(execute()); return () => {}; },
    on: (name, handler) => {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {};
    }
  };
  if (webServer) core.webServer = webServer;
  if (supportsInject) {
    // cordis ctx.inject(deps, callback) is optional dynamic injection: the callback runs when the
    // service exists. Tests satisfy it immediately; a host without webServer never calls back.
    core.inject = (names, callback) => {
      injected.push(names);
      if (core.webServer) callback(core);
      return Promise.resolve();
    };
  }
  const ctx = strictServices
    ? new Proxy(core, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target) return target[prop];
        throw new Error('cannot read ctx.' + String(prop) + ' without declaring it in inject');
      }
    })
    : core;
  return {
    ctx, prompts, created, logs, disposers, archived, renamed, injected, listeners,
    fire: (name, ...args) => { for (const handler of listeners.get(name) ?? []) handler(...args); }
  };
}

/** The bridge owns two intervals: the message poll (pollSeconds) and the capability worker. */
function messagePoll(scheduled, ms = 60000) {
  const found = scheduled.find((entry) => entry.ms === ms);
  assert.ok(found, 'the message poll must be scheduled (' + scheduled.map((entry) => entry.ms).join(', ') + ')');
  return found;
}

let bridgeRun = 0;
function startBridge(ctx, config) {
  bridgeRun += 1;
  const stateDir = config.stateDir ?? path.join(TMP, 'hub-state-' + bridgeRun);
  applyBridge(ctx, { ...config, stateDir });
  return stateDir;
}

/** Capture the poll loops instead of scheduling them for real. */
function captureSchedule(t) {
  const scheduled = [];
  const realInterval = bridgeInternals.setInterval;
  const realClear = bridgeInternals.clearInterval;
  bridgeInternals.setInterval = (callback, ms) => { scheduled.push({ callback, ms }); return { unref() {} }; };
  bridgeInternals.clearInterval = () => {};
  t.after(() => { bridgeInternals.setInterval = realInterval; bridgeInternals.clearInterval = realClear; });
  return scheduled;
}

async function waitFor(check, label, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for ' + label);
}

async function waitForState(file, predicate, label, timeoutMs = 4000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = JSON.parse(await fs.readFile(file, 'utf8'));
      if (predicate(last)) return last;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for ' + label + ' (last state: ' + JSON.stringify(last) + ')');
}

// ---- Fake dsh-link node (no real node needed for hub payload shapes) ----

async function startFakeNode(t, options = {}) {
  const state = {
    name: options.name ?? 'fake-node',
    hubStatus: options.hubStatus ?? { code: 200, body: { enabled: false, state: 'disabled', url: null } },
    hubReconnect: options.hubReconnect ?? { code: 200, body: { enabled: false, state: 'disabled', url: null } },
    messages: options.messages ?? [],
    requests: []
  };
  const send = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(text);
  };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      let pathname = '/';
      try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch { pathname = String(req.url ?? '/'); }
      state.requests.push({ method: req.method, path: pathname, authorization: req.headers.authorization ?? '' });
      if (req.method === 'GET' && pathname === '/api/v1/info') return send(res, 200, { name: state.name, version: '0.8.0' });
      if (req.method === 'GET' && pathname === '/api/v1/messages') return send(res, 200, { messages: state.messages });
      if (req.method === 'GET' && pathname === '/api/v1/hub/status') return send(res, state.hubStatus.code, state.hubStatus.body);
      if (req.method === 'POST' && pathname === '/api/v1/hub/reconnect') return send(res, state.hubReconnect.code, state.hubReconnect.body);
      if (req.method === 'POST' && pathname === '/api/v1/bridge/bind') return send(res, 200, { ok: true });
      if (req.method === 'GET' && pathname === '/api/v1/bridge/bind') return send(res, 404, { error: { code: 'not_found' } });
      return send(res, 404, { error: { code: 'not_found', message: 'no route: ' + pathname } });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, state, url: 'http://127.0.0.1:' + server.address().port };
}

/** A port nothing listens on any more: bind, take the number, close. */
async function deadUrl() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return 'http://127.0.0.1:' + port;
}

function nodeMessage(id, peer, subject, body, extra = {}) {
  return {
    id,
    ts: new Date().toISOString(),
    from: { nodeId: 'node_' + peer, name: peer, url: 'http://127.0.0.1:1' },
    to: 'fake-node',
    thread: extra.thread ?? id,
    replyTo: null,
    kind: 'message',
    subject,
    body,
    attachments: [],
    ...extra
  };
}

// ---- Route-level fake req/res (the handlers are plain node:http handlers) ----

function mockResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.body = chunk === undefined || chunk === null ? '' : String(chunk); },
    destroy() {}
  };
}

async function callRoute(route, { method = 'GET', url = '/' } = {}) {
  const req = { method, url, headers: {} };
  const res = mockResponse();
  await route.handler(req, res);
  let parsed = null;
  try { parsed = res.body ? JSON.parse(res.body) : null; } catch { parsed = res.body; }
  return { status: res.statusCode, headers: res.headers ?? {}, body: parsed, raw: res.body };
}

// ---- Minimal React harness for the hand-written Settings bundle ----

function createReactHarness() {
  const hooks = [];
  let index = 0;
  let pending = 0;
  let effects = [];
  return {
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child.flat(Infinity));
        else flat.push(child);
      }
      return { type, props: props ?? {}, children: flat };
    },
    useState(initial) {
      const slot = index;
      index += 1;
      if (!(slot in hooks)) hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const entry = hooks[slot];
      return [entry.value, (next) => {
        entry.value = typeof next === 'function' ? next(entry.value) : next;
        pending += 1;
      }];
    },
    useRef(initial) {
      const slot = index;
      index += 1;
      if (!(slot in hooks)) hooks[slot] = { current: initial === undefined ? null : initial };
      return hooks[slot];
    },
    useEffect(fn, deps) {
      const slot = index;
      index += 1;
      const previous = hooks[slot] && hooks[slot].deps;
      const changed = !previous || !Array.isArray(deps) || deps.length !== previous.length
        || deps.some((dep, index2) => dep !== previous[index2]);
      hooks[slot] = { deps };
      if (changed) effects.push(fn);
    },
    begin() { index = 0; effects = []; },
    takeEffects() { const list = effects; effects = []; return list; },
    get pending() { return pending; },
    resetPending() { pending = 0; }
  };
}

function buildTree(node) {
  if (node === null || node === undefined || node === true || node === false) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(buildTree).filter((child) => child !== null);
  if (typeof node.type === 'function') return buildTree(node.type(node.props));
  return { tag: node.type, props: node.props ?? {}, children: node.children.map(buildTree).filter((child) => child !== null) };
}

function textOf(tree) {
  if (tree === null || tree === undefined) return '';
  if (typeof tree === 'string') return tree;
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  return textOf(tree.children);
}

function elementsOf(tree, list = []) {
  if (tree === null || tree === undefined || typeof tree === 'string') return list;
  if (Array.isArray(tree)) {
    for (const child of tree) elementsOf(child, list);
    return list;
  }
  list.push(tree);
  for (const child of tree.children) elementsOf(child, list);
  return list;
}

function responseOf(status, payload) {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/**
 * Load lib/client.js in a vm sandbox with a window.__ModuleLoader__ stub, apply the plugin export
 * to a fake client context, and return a render() helper.
 */
async function mountBundle({ fetchImpl }) {
  const react = createReactHarness();
  const documentListeners = new Map();
  const intervals = [];
  let loaded = null;
  const documentStub = {
    hidden: false,
    head: { appendChild() {} },
    querySelector() { return null; },
    createElement() { return { dataset: {}, textContent: '' }; },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    removeEventListener(name) { documentListeners.delete(name); }
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(spec) { loaded = spec; } } },
    document: documentStub,
    fetch: fetchImpl,
    setInterval(callback, ms) { const entry = { callback, ms }; intervals.push(entry); return entry; },
    clearInterval(entry) { const at = intervals.indexOf(entry); if (at >= 0) intervals.splice(at, 1); },
    console
  };
  vm.runInNewContext(await fs.readFile(CLIENT_FILE, 'utf8'), sandbox, { filename: 'dsh-link-bridge/lib/client.js' });

  assert.ok(loaded, 'the bundle must call window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-link-bridge');
  const moduleExports = loaded.factory((name) => {
    assert.equal(name, 'react', 'the bundle may only require react');
    return react;
  });
  assert.equal(typeof moduleExports.apply, 'function');
  assert.deepEqual([...moduleExports.inject], ['slots']);

  const registrations = [];
  let injectedSlot = null;
  const clientCtx = {
    slots: {
      inject(slot, callback) { injectedSlot = slot; callback(); },
      register(spec, Component) {
        registrations.push({ spec: { name: spec.name, id: spec.id, order: spec.order, label: spec.label }, Component });
        return () => {};
      }
    }
  };
  moduleExports.apply(clientCtx);
  assert.equal(injectedSlot, 'settings.section');
  assert.equal(registrations.length, 1);
  const { spec, Component } = registrations[0];

  async function render() {
    const cleanups = [];
    let tree = null;
    for (let round = 0; round < 20; round += 1) {
      react.begin();
      tree = buildTree(Component());
      const queued = react.takeEffects();
      for (const effect of queued) {
        const cleanup = effect();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      }
      react.resetPending();
      await new Promise((resolve) => setImmediate(resolve));
      if (react.pending === 0) break;
    }
    return { tree, cleanups };
  }

  return { loaded, moduleExports, spec, Component, react, documentStub, documentListeners, intervals, render };
}

// ============================================================================================
// 1. sessions.list running flag (hub sessions/running aggregation source)
// ============================================================================================

test('bridge-hub: sessions.list reports a running boolean for every session', async () => {
  const listed = [
    { sessionId: 's-running', running: true, updatedAt: '2026-11-04T10:00:00.000Z', projections: { values: { title: 'live' } } },
    { sessionId: 's-idle', running: false, updatedAt: '2026-11-04T09:00:00.000Z' },
    { sessionId: 's-unknown', updatedAt: '2026-11-04T08:00:00.000Z' },
    { sessionId: 's-weird', running: 'yes', updatedAt: '2026-11-04T07:00:00.000Z' }
  ];
  const ctx = {
    sessionController: {
      list: async (request, signal) => {
        assert.equal(typeof signal.throwIfAborted, 'function', 'the Host call needs a caller signal');
        return { items: listed };
      }
    },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] }
  };
  const ops = createDshOps({ ctx, log: {} });
  const result = await ops.methods['sessions.list']({});
  const rows = result.sessions;
  assert.equal(rows.length, 4);
  const byId = new Map(rows.map((row) => [row.sessionId, row]));
  assert.equal(byId.get('s-running').running, true);
  assert.equal(byId.get('s-idle').running, false, 'an explicit idle session reports false');
  assert.ok(!('running' in byId.get('s-unknown')), 'a Host that does not report running yields no field (unknown, not idle)');
  assert.ok(!('running' in byId.get('s-weird')), 'only a real boolean is relayed');
  for (const row of rows) {
    if ('running' in row) assert.equal(typeof row.running, 'boolean', 'running is a boolean when present');
  }
  assert.equal(rows[0].sessionId, 's-running', 'rows stay newest-first');
  assert.equal(byId.get('s-running').title, 'live', 'the title projection still comes through');
});

// ============================================================================================
// 2. state.json hub section
// ============================================================================================

test('bridge-hub: a 0.7 node writes state.hub as disabled', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-hub-node' });
  t.after(() => node.close());
  // The hub routes are bridge/admin only: the bridge authenticates with a dedicated bridge token,
  // not with a peer token (a peer token would be 403 bridge_forbidden, see src/server.mjs requireBridge).
  const bridgeToken = createInboundToken(node.cfg, 'bridge-test', { role: 'bridge' }).token;

  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: bridgeToken,
    workspacePath: path.join(TMP, 'hub-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'hub-state-disabled')
  });
  await messagePoll(scheduled).callback();

  const state = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'disabled', 'state.hub to be written');
  assert.deepEqual(state.hub, {
    enabled: false,
    state: 'disabled',
    url: null,
    lastHeartbeatAt: null,
    lastError: null,
    pendingOutbox: 0,
    pendingTargets: [],
    enrolled: null,
    updatedAt: state.hub.updatedAt
  });
  assert.match(state.hub.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(fake.logs.some((line) => line.startsWith('error:')), false, 'an unprepared node must not count as a bridge error');
});

test('bridge-hub: state.hub normalizes an enrolled node hub payload', async (t) => {
  await resetTmp();
  const hubBody = {
    enabled: true,
    state: 'online',
    url: 'http://127.0.0.1:8787',
    lastHeartbeatAt: '2026-11-04T12:00:00.000Z',
    lastError: null,
    pendingOutbox: 2,
    pendingTargets: ['PEER-A', 'PEER-B'],
    enrolled: {
      hubName: 'HUB-TEST',
      nodeName: 'NODE-A',
      enrolledAt: '2026-11-04T11:59:00.000Z',
      visitorPort: 18790,
      downlinkUrl: 'http://127.0.0.1:18790'
    },
    bridge: { version: '0.8.0' },
    now: '2026-11-04T12:00:10.000Z'
  };
  const node = await startFakeNode(t, { hubStatus: { code: 200, body: hubBody } });
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: 'bridge-token',
    workspacePath: path.join(TMP, 'hub-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'hub-state-online')
  });
  await messagePoll(scheduled).callback();

  const state = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'online', 'state.hub online');
  assert.deepEqual(state.hub, {
    enabled: true,
    state: 'online',
    url: 'http://127.0.0.1:8787',
    lastHeartbeatAt: '2026-11-04T12:00:00.000Z',
    lastError: null,
    pendingOutbox: 2,
    pendingTargets: ['PEER-A', 'PEER-B'],
    enrolled: {
      hubName: 'HUB-TEST',
      nodeName: 'NODE-A',
      enrolledAt: '2026-11-04T11:59:00.000Z',
      visitorPort: 18790,
      downlinkUrl: 'http://127.0.0.1:18790'
    },
    updatedAt: state.hub.updatedAt
  });

  const statusRequests = node.state.requests.filter((request) => request.path === '/api/v1/hub/status');
  assert.ok(statusRequests.length >= 1, 'the bridge must poll the node hub route');
  assert.equal(statusRequests[0].authorization, 'Bearer bridge-token', 'the node token must be sent from the host, never the browser');
});

test('bridge-hub: a failing hub poll never stops message delivery (and recovers)', async (t) => {
  await resetTmp();
  const node = await startFakeNode(t, {
    hubStatus: { code: 500, body: { error: { code: 'internal', message: 'boom' } } },
    messages: [nodeMessage('msg_01hub0001', 'PEER-A', '请检查构建', 'run the full test suite')]
  });
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: 'bridge-token',
    workspacePath: path.join(TMP, 'hub-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'hub-state-fail')
  });
  await messagePoll(scheduled).callback();

  const failed = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'unknown', 'state.hub unknown after a failed poll');
  assert.match(failed.hub.lastError, /HTTP 500/, 'the node status travels in lastError');
  assert.equal(failed.hub.enabled, false);

  await waitFor(() => fake.prompts.length === 1, 'the message to wake a session despite the hub failure');
  assert.match(fake.prompts[0].request.content[0].text, /run the full test suite/);
  assert.equal(fake.logs.some((line) => line.startsWith('error:')), false, 'hub failures are contained');

  // The next poll sees a healthy node: the hub section recovers without a restart.
  node.state.hubStatus = { code: 200, body: { enabled: false, state: 'disabled', url: null } };
  node.state.messages = [];
  await messagePoll(scheduled).callback();
  await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'disabled', 'state.hub recovery');
});

test('bridge-hub: a restored hub snapshot survives a failing poll', async (t) => {
  await resetTmp();
  const node = await startFakeNode(t, { hubStatus: { code: 503, body: { error: { code: 'unavailable', message: 'hub down' } } } });
  const stateDir = path.join(TMP, 'hub-state-restore');
  await fs.mkdir(stateDir, { recursive: true });
  // 0.8 upgrade path: the previous run persisted a hub snapshot. A failing poll must keep that
  // identity (the panel still says which hub the node was on) and only downgrade the live state.
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    sessionId: 'session-legacy',
    watermark: { ts: '2026-01-01T00:00:00.000Z', id: 'msg_legacy0001' },
    ticks: 7,
    hub: {
      enabled: true,
      state: 'online',
      url: 'http://old-hub:8787',
      lastHeartbeatAt: '2026-10-01T00:00:00.000Z',
      lastError: null,
      pendingOutbox: 3,
      pendingTargets: ['PEER-A'],
      enrolled: {
        hubName: 'OLD-HUB',
        nodeName: 'OLD-NODE',
        enrolledAt: '2026-10-01T00:00:00.000Z',
        visitorPort: 18790,
        downlinkUrl: null
      },
      updatedAt: '2026-10-01T00:00:00.000Z'
    }
  }), 'utf8');

  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: 'bridge-token',
    workspacePath: path.join(TMP, 'hub-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir
  });
  await messagePoll(scheduled).callback();

  const state = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'unknown', 'state.hub unknown after restoring a snapshot');
  assert.equal(state.sessionId, 'session-legacy', 'a 0.8 state file restores the previous session');
  assert.equal(state.hub.enabled, true, 'the restored snapshot still says the node is enrolled');
  assert.equal(state.hub.url, 'http://old-hub:8787', 'the last known hub URL is kept while the node does not answer');
  assert.equal(state.hub.lastHeartbeatAt, '2026-10-01T00:00:00.000Z');
  assert.equal(state.hub.pendingOutbox, 3);
  assert.deepEqual(state.hub.pendingTargets, ['PEER-A']);
  assert.equal(state.hub.enrolled.hubName, 'OLD-HUB');
  assert.match(state.hub.lastError, /HTTP 503/, 'the failing poll is reported, not invented');
  assert.equal(fake.logs.some((line) => line.startsWith('error:')), false, 'a hub failure stays contained');
});

test('bridge-hub: a 0.7 state file without a hub section still loads', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-hub-legacy' });
  t.after(() => node.close());
  const bridgeToken = createInboundToken(node.cfg, 'bridge-test', { role: 'bridge' }).token;
  const stateDir = path.join(TMP, 'hub-state-legacy');
  await fs.mkdir(stateDir, { recursive: true });
  // A state.json written by 0.7 has no hub key at all: loading it must not fail, and the next
  // tick appends the snapshot while keeping the existing fields.
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    sessionId: 'session-from-0.7',
    watermark: { ts: '2026-01-01T00:00:00.000Z', id: 'msg_legacy0002' },
    threads: {},
    updatedAt: '2026-01-01T00:00:00.000Z'
  }), 'utf8');

  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: bridgeToken,
    workspacePath: path.join(TMP, 'hub-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir
  });
  await messagePoll(scheduled).callback();

  const state = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'disabled', 'a hub snapshot appended to a 0.7 state file');
  assert.equal(state.sessionId, 'session-from-0.7', 'the existing 0.7 fields survive the upgrade');
  assert.deepEqual(state.hub, {
    enabled: false,
    state: 'disabled',
    url: null,
    lastHeartbeatAt: null,
    lastError: null,
    pendingOutbox: 0,
    pendingTargets: [],
    enrolled: null,
    updatedAt: state.hub.updatedAt
  });
  assert.equal(fake.logs.some((line) => line.startsWith('error:')), false, 'upgrading a 0.7 state file is not an error');
});

// ============================================================================================
// 3. Host-side proxy routes (what the DSH web server exposes to the GUI)
// ============================================================================================

test('bridge-hub: the host status route proxies the node payload', async (t) => {
  const hubBody = {
    enabled: true,
    state: 'online',
    url: 'http://127.0.0.1:8787',
    lastHeartbeatAt: '2026-11-04T12:00:00.000Z',
    lastError: null,
    pendingOutbox: 1,
    pendingTargets: ['PEER-A'],
    enrolled: { hubName: 'HUB-TEST', nodeName: 'NODE-A', enrolledAt: null, visitorPort: 18790, downlinkUrl: null },
    bridge: { version: '0.8.0' },
    now: '2026-11-04T12:00:10.000Z'
  };
  const node = await startFakeNode(t, { hubStatus: { code: 200, body: hubBody } });
  const routes = buildHubRoutes({ baseUrl: node.url, token: 'node-token' });
  assert.deepEqual(routes.map((route) => route.kind + ' ' + route.path), [
    'exact /api/v1/hub/status',
    'exact /api/v1/hub/reconnect'
  ]);

  const answer = await callRoute(routes[0]);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, hubBody, 'the node payload is relayed unchanged');
  assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(typeof answer.headers['content-length'], 'number');
  const statusRequests = node.state.requests.filter((request) => request.path === '/api/v1/hub/status');
  assert.equal(statusRequests.at(-1).authorization, 'Bearer node-token');

  const wrongMethod = await callRoute(routes[0], { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(wrongMethod.body, { error: { code: 'method_not_allowed', message: 'use GET' } });
  assert.equal(wrongMethod.headers.allow, 'GET');
});

test('bridge-hub: the host reconnect route passes node statuses through', async (t) => {
  const node = await startFakeNode(t, {
    hubStatus: { code: 200, body: { enabled: false, state: 'disabled', url: null } },
    hubReconnect: {
      code: 409,
      body: { error: { code: 'hub_disabled', message: 'this node is not enrolled in a hub' } }
    }
  });
  const routes = buildHubRoutes({ baseUrl: node.url, token: 'node-token' });
  const reconnect = routes[1];
  assert.equal(reconnect.path, '/api/v1/hub/reconnect');

  const refused = await callRoute(reconnect, { method: 'POST' });
  assert.equal(refused.status, 409, 'a 409 hub_disabled from the node is not rewritten into a proxy error');
  assert.deepEqual(refused.body, { error: { code: 'hub_disabled', message: 'this node is not enrolled in a hub' } });

  const acceptedBody = {
    enabled: true,
    state: 'connecting',
    url: 'http://127.0.0.1:8787',
    lastHeartbeatAt: null,
    lastError: null,
    pendingOutbox: 0,
    pendingTargets: [],
    enrolled: null,
    bridge: { version: '0.8.0' },
    now: '2026-11-04T12:00:20.000Z'
  };
  node.state.hubReconnect = { code: 200, body: acceptedBody };
  const accepted = await callRoute(reconnect, { method: 'POST' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, acceptedBody);
  assert.equal(node.state.requests.filter((request) => request.path === '/api/v1/hub/reconnect').at(-1).authorization, 'Bearer node-token');

  const wrongMethod = await callRoute(reconnect, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
});

test('bridge-hub: an unreachable node becomes a 502 node_unreachable', async () => {
  const url = await deadUrl();
  const routes = buildHubRoutes({ baseUrl: url, token: 'node-token', timeoutMs: 500 });
  const status = await callRoute(routes[0]);
  assert.equal(status.status, 502);
  assert.equal(status.body.error.code, 'node_unreachable');
  assert.match(status.body.error.message, /unreachable/);

  const reconnect = await callRoute(routes[1], { method: 'POST' });
  assert.equal(reconnect.status, 502);
  assert.equal(reconnect.body.error.code, 'node_unreachable');
});

// ============================================================================================
// 4. Registration on the DSH web server
// ============================================================================================

test('bridge-hub: apply registers the proxy routes through optional webServer inject', async (t) => {
  await resetTmp();
  const node = await startFakeNode(t, {});
  const webServer = fakeWebServer();
  const fake = fakeCtx({ webServer, supportsInject: true });
  const scheduled = captureSchedule(t);
  startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: 'bridge-token',
    workspacePath: path.join(TMP, 'apply-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'apply-state')
  });

  assert.deepEqual(fake.injected, [['webServer']], 'cordis ctx.inject is used so a strict host accepts the read');
  assert.deepEqual(webServer.routes.map((route) => route.path), ['/api/v1/hub/status', '/api/v1/hub/reconnect']);
  assert.ok(
    fake.logs.some((line) => line.includes('hub panel:') && line.includes('register once')),
    'the plugin logs that the routes wait for the DSH web server'
  );

  // The registered handlers really proxy: the browser half has no token of its own.
  const proxied = await callRoute(webServer.routes[0]);
  assert.equal(proxied.status, 200);
  assert.equal(proxied.body.state, 'disabled');

  await waitForState(path.join(TMP, 'apply-state', 'state.json'), (saved) => saved.hub && saved.hub.state === 'disabled', 'first state write');
  assert.ok(scheduled.length >= 2, 'the wake loop and the command worker are still scheduled');
});

test('bridge-hub: a plain context with a direct web server still gets the routes', async (t) => {
  await resetTmp();
  const node = await startFakeNode(t, {});
  const webServer = fakeWebServer();
  const fake = fakeCtx({ webServer });
  const result = registerHubRoutes(fake.ctx, { baseUrl: node.url, token: 'bridge-token' });
  assert.deepEqual(result, {
    registered: ['/api/v1/hub/status', '/api/v1/hub/reconnect'],
    deferred: false,
    unavailable: null
  });
  const proxied = await callRoute(webServer.routes[1], { method: 'POST' });
  assert.equal(proxied.status, 200);
});

test('bridge-hub: a context with neither inject nor web server stays quiet', () => {
  const fake = fakeCtx();
  const result = registerHubRoutes(fake.ctx, { baseUrl: 'http://127.0.0.1:1' });
  assert.deepEqual(result, {
    registered: [],
    deferred: false,
    unavailable: 'the DSH host exposes no webServer service'
  });
});

test('bridge-hub: a strict host without a web server still wakes sessions', async (t) => {
  await resetTmp();
  const node = await startFakeNode(t, {
    messages: [nodeMessage('msg_01strict01', 'PEER-B', 'strict host', 'hello from a strict host')]
  });
  const scheduled = captureSchedule(t);
  const fake = fakeCtx({ strictServices: true });
  const stateDir = startBridge(fake.ctx, {
    nodeUrl: node.url,
    token: 'bridge-token',
    workspacePath: path.join(TMP, 'strict-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'strict-state')
  });
  await messagePoll(scheduled).callback();

  await waitFor(() => fake.prompts.length === 1, 'a message wake under a strict context');
  assert.match(fake.prompts[0].request.content[0].text, /hello from a strict host/);
  const state = await waitForState(path.join(stateDir, 'state.json'), (saved) => saved.hub && saved.hub.state === 'disabled', 'state.hub under a strict context');
  assert.equal(state.hub.state, 'disabled');
});

// ============================================================================================
// 5. The Settings bundle (lib/client.js)
// ============================================================================================

test('bridge-hub: the Settings bundle registers a dsh-link section for 0.7 mode', async () => {
  const disabled = {
    enabled: false,
    state: 'disabled',
    url: null,
    lastHeartbeatAt: null,
    lastError: null,
    pendingOutbox: 0,
    pendingTargets: [],
    enrolled: null
  };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, method: (init && init.method) || 'GET' }); return responseOf(200, disabled); };
  const mounted = await mountBundle({ fetchImpl });

  assert.deepEqual(mounted.spec, { name: 'settings.section', id: 'dsh-link', order: 700, label: 'dsh-link' });
  assert.equal(typeof mounted.Component, 'function', 'the section component is registered');

  const { tree, cleanups } = await mounted.render();
  const text = textOf(tree);
  assert.match(text, /dsh-link hub/, 'the panel is titled');
  assert.match(text, /hub 未启用（当前为 0.7 点对点模式）/, '0.7 deployments are explained');
  assert.match(text, /最后心跳/);
  assert.match(text, /本地待发队列/);

  const buttons = elementsOf(tree).filter((element) => element.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true, 'reconnect is disabled without a hub');
  assert.deepEqual(mounted.intervals.map((entry) => entry.ms), [5000], 'the panel polls every 5s');
  assert.deepEqual(calls.map((call) => call.url), ['/api/v1/hub/status'], 'the first read goes through the same-origin proxy');
  for (const cleanup of cleanups) cleanup();
});

test('bridge-hub: the Settings bundle renders a live hub and reconnects', async () => {
  const online = {
    enabled: true,
    state: 'online',
    url: 'http://127.0.0.1:8787',
    lastHeartbeatAt: '2026-11-04T12:00:00.000Z',
    lastError: null,
    pendingOutbox: 2,
    pendingTargets: ['PEER-A', 'PEER-B'],
    enrolled: { hubName: 'HUB-TEST', nodeName: 'NODE-A' }
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET' });
    if (url === '/api/v1/hub/reconnect') return responseOf(200, { ...online, state: 'connecting' });
    return responseOf(200, online);
  };
  const mounted = await mountBundle({ fetchImpl });
  const { tree, cleanups } = await mounted.render();
  const text = textOf(tree);
  assert.match(text, /在线/, 'the hub state label is displayed');
  assert.match(text, /NODE-A/);
  assert.match(text, /HUB-TEST/);
  assert.match(text, /2 条/);
  assert.match(text, /PEER-A/);

  const button = elementsOf(tree).filter((element) => element.tag === 'button')[0];
  assert.equal(button.props.disabled, false, 'a live hub can be reconnected');
  await button.props.onClick();
  const reconnects = calls.filter((call) => call.url === '/api/v1/hub/reconnect');
  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].method, 'POST');
  assert.ok(calls.filter((call) => call.url === '/api/v1/hub/status').length >= 2, 'the panel refreshes after reconnecting');
  for (const cleanup of cleanups) cleanup();
});

test('bridge-hub: the Settings bundle reports an unreachable node', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  const mounted = await mountBundle({ fetchImpl });
  const { tree, cleanups } = await mounted.render();
  const text = textOf(tree);
  assert.match(text, /面板读取失败：fetch failed/);
  const button = elementsOf(tree).filter((element) => element.tag === 'button')[0];
  assert.equal(button.props.disabled, true);
  for (const cleanup of cleanups) cleanup();
});
