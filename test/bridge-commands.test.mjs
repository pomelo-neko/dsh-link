// Tests for the dsh-link-bridge capability channel: the command worker that talks to the
// local node (integrations/dsh-link-bridge/lib/commands.js) and the Host handlers it runs
// (integrations/dsh-link-bridge/lib/dshops.js).
//
// The node side is a throwaway http server here, so the protocol is pinned end to end: claim,
// execute, report, heartbeat. The Host side is a fake ctx modelled on test/bridge.test.mjs,
// including the strict-service proxy new cordis uses and the "no signal -> TypeError" rule of
// ctx.sessionController.prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCommandWorker } from '../integrations/dsh-link-bridge/lib/commands.js';
import { createDshOps } from '../integrations/dsh-link-bridge/lib/dshops.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Private subtree: other agents run their own tests against test/.tmp/* in parallel, so this
// file never reuses helpers.mjs TMP (shared) and never touches a live artifact.
const TMP = path.join(HERE, '.tmp', 'bridge-commands-' + process.pid);
const CLOCK = Date.parse('2026-09-12T10:00:00.000Z');

test.before(async () => {
  await fs.mkdir(TMP, { recursive: true });
  await fs.writeFile(path.join(TMP, 'probe.txt'), 'bridge-commands probe\n', 'utf8');
});

test.after(async () => {
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

/**
 * Stand-in for the node's capability channel. It hands the queued commands out once (honouring
 * ?limit) and records every heartbeat and result body it receives.
 */
async function startNode(t, options = {}) {
  const state = { queue: [...(options.commands ?? [])], results: [], heartbeats: [], requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
      const send = (status, payload) => {
        const text = payload === undefined ? '' : JSON.stringify(payload);
        res.writeHead(status, text ? { 'content-type': 'application/json' } : {});
        res.end(text);
      };
      if (options.fail) { send(options.fail, { error: 'the node is unhappy' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/v1/bridge/commands') {
        const limit = Number(url.searchParams.get('limit')) || 0;
        const commands = state.queue.splice(0, limit > 0 ? limit : state.queue.length);
        send(200, { count: commands.length, commands });
        return;
      }
      const result = /^\/api\/v1\/bridge\/commands\/(.+)\/result$/.exec(url.pathname);
      if (req.method === 'POST' && result) {
        state.results.push({ id: decodeURIComponent(result[1]), body });
        send(200, { ok: true });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/bridge/heartbeat') {
        state.heartbeats.push(body);
        send(200, { ok: true, at: body ? body.at : null });
        return;
      }
      send(404, { error: 'no route ' + req.method + ' ' + url.pathname });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  t.after(close);
  return { state, port, url: 'http://127.0.0.1:' + port, close };
}

/** fetch seam with a canned response per request. */
function stubFetch(handler) {
  return async (url, options = {}) => {
    const result = handler(String(url), options) ?? {};
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('commands: tick claims the queue, runs each handler, and posts the exact result', async (t) => {
  const node = await startNode(t, {
    commands: [
      { id: 'cmd_01aaa', method: 'workspaces.list', params: {}, origin: { peer: 'LAPTOP' }, attempts: 1 },
      { id: 'cmd_01bbb', method: 'echo', params: { text: 'hi' }, origin: { peer: 'LAPTOP' }, attempts: 2 }
    ]
  });
  const seen = [];
  const worker = createCommandWorker({
    nodeUrl: node.url + '/', // a trailing slash must not double up in the request path
    token: 'test-token',
    version: '9.9.9',
    now: () => CLOCK,
    handlers: {
      'workspaces.list': async (params, context) => { seen.push({ params, context }); return { workspaces: [] }; },
      echo: async (params) => ({ echoed: params.text })
    }
  });

  await worker.tick();

  assert.equal(worker.stats.ticks, 1);
  assert.equal(worker.stats.executed, 2);
  assert.equal(worker.stats.failed, 0);
  assert.equal(worker.stats.lastError, null);
  assert.equal(worker.stats.lastCommandAt, '2026-09-12T10:00:00.000Z');
  assert.equal(worker.stats.lastHeartbeatAt, '2026-09-12T10:00:00.000Z');

  assert.deepEqual(node.state.results, [
    { id: 'cmd_01aaa', body: { ok: true, result: { workspaces: [] } } },
    { id: 'cmd_01bbb', body: { ok: true, result: { echoed: 'hi' } } }
  ]);
  assert.deepEqual(seen[0].context, {
    id: 'cmd_01aaa', method: 'workspaces.list', origin: { peer: 'LAPTOP' }, attempts: 1
  });

  const claim = node.state.requests.find((entry) => entry.method === 'GET');
  assert.equal(claim.path + claim.query, '/api/v1/bridge/commands?limit=5');
  assert.equal(claim.headers.authorization, 'Bearer test-token');
  const post = node.state.requests.find((entry) => entry.method === 'POST');
  assert.equal(post.headers.authorization, 'Bearer test-token');
  assert.equal(post.headers['content-type'], 'application/json');

  assert.deepEqual(node.state.heartbeats, [{
    version: '9.9.9',
    capabilities: ['workspaces.list', 'echo'],
    sessions: 0,
    at: '2026-09-12T10:00:00.000Z'
  }]);
});

test('commands: maxPerTick bounds both the request and what is executed', async (t) => {
  const node = await startNode(t, {
    commands: [
      { id: 'cmd_01a', method: 'ping', params: {} },
      { id: 'cmd_01b', method: 'ping', params: {} },
      { id: 'cmd_01c', method: 'ping', params: {} }
    ]
  });
  const worker = createCommandWorker({
    nodeUrl: node.url, maxPerTick: 2, token: '',
    handlers: { ping: async () => 'pong' }
  });
  await worker.tick();
  assert.equal(worker.stats.executed, 2);
  assert.equal(node.state.results.length, 2);
  assert.equal(node.state.queue.length, 1, 'the rest stays queued for the next tick');
  const claim = node.state.requests.find((entry) => entry.method === 'GET');
  assert.equal(claim.query, '?limit=2');
  assert.equal(claim.headers.authorization, undefined, 'an empty token sends no Authorization header');
});

test('commands: a throwing handler reports ok:false, counts as failed, and does not stop the batch', async (t) => {
  const node = await startNode(t, {
    commands: [
      { id: 'cmd_boom1', method: 'boom', params: {} },
      { id: 'cmd_01good', method: 'fine', params: {} },
      { id: 'cmd_plain1', method: 'plain', params: {} }
    ]
  });
  const worker = createCommandWorker({
    nodeUrl: node.url,
    now: () => CLOCK,
    handlers: {
      boom: async () => { const error = new Error('boom'); error.code = 'E_BOOM'; throw error; },
      fine: async () => ({ ok: true }),
      plain: async () => { throw 'plain string'; }
    }
  });

  await worker.tick();

  assert.equal(worker.stats.executed, 1);
  assert.equal(worker.stats.failed, 2);
  assert.equal(worker.stats.lastError, 'plain string');
  assert.equal(worker.stats.lastErrorAt, '2026-09-12T10:00:00.000Z');
  assert.deepEqual(node.state.results, [
    { id: 'cmd_boom1', body: { ok: false, error: { message: 'boom', code: 'E_BOOM' } } },
    { id: 'cmd_01good', body: { ok: true, result: { ok: true } } },
    { id: 'cmd_plain1', body: { ok: false, error: { message: 'plain string' } } }
  ]);
});

test('commands: an unknown method is reported as unsupported', async (t) => {
  const node = await startNode(t, {
    commands: [{ id: 'cmd_01ccc', method: 'sessions.nope', params: {} }]
  });
  const worker = createCommandWorker({ nodeUrl: node.url, handlers: { 'sessions.list': async () => ({}) } });
  await worker.tick();

  assert.equal(worker.stats.failed, 1);
  assert.equal(worker.stats.executed, 0);
  assert.equal(node.state.results.length, 1);
  assert.deepEqual(node.state.results[0].body, {
    ok: false,
    error: { message: 'unsupported method: sessions.nope' }
  });
  assert.equal(worker.stats.lastError, 'unsupported method: sessions.nope');
});

test('commands: a command id is percent-encoded into the result path', async (t) => {
  const node = await startNode(t, { commands: [{ id: 'cmd_01/x', method: 'ping', params: {} }] });
  const worker = createCommandWorker({ nodeUrl: node.url, handlers: { ping: async () => 'pong' } });
  await worker.tick();
  assert.deepEqual(node.state.results, [{ id: 'cmd_01/x', body: { ok: true, result: 'pong' } }]);
});

test('commands: an unreachable or broken node never makes tick() reject', async (t) => {
  const node = await startNode(t, { commands: [{ id: 'cmd_01ddd', method: 'ping', params: {} }] });
  await node.close(); // the port is now refused

  const worker = createCommandWorker({ nodeUrl: node.url, handlers: { ping: async () => 'pong' } });
  await worker.tick();
  await worker.tick();

  assert.equal(worker.stats.ticks, 2);
  assert.equal(worker.stats.executed, 0);
  assert.ok(worker.stats.lastError, 'the failure is recorded instead of thrown');
  assert.ok(worker.stats.lastErrorAt);
  assert.equal(worker.stats.lastHeartbeatAt, null, 'no heartbeat is claimed when the node is down');

  // A synchronous throw from the transport is contained too.
  const sync = createCommandWorker({
    nodeUrl: 'http://127.0.0.1:1',
    handlers: {},
    fetchImpl: () => { throw new Error('sync boom'); }
  });
  await sync.tick();
  assert.equal(sync.stats.lastError, 'sync boom');

  // A node that answers 500 is an error, not a silent empty queue.
  const broken = await startNode(t, { fail: 500 });
  const failing = createCommandWorker({ nodeUrl: broken.url, handlers: {} });
  await failing.tick();
  assert.match(failing.stats.lastError, /HTTP 500 from GET/);

  // A body the worker cannot understand claims nothing and does not throw.
  const odd = createCommandWorker({
    nodeUrl: 'http://127.0.0.1:1',
    handlers: { ping: async () => 'pong' },
    fetchImpl: stubFetch(() => ({ body: { unexpected: true } }))
  });
  await odd.tick();
  assert.equal(odd.stats.executed, 0);
  assert.equal(odd.stats.failed, 0);
  assert.equal(odd.stats.lastError, null);
});

test('commands: heartbeat is throttled by heartbeatMs against the injectable clock', async (t) => {
  const node = await startNode(t, {
    commands: [
      { id: 'cmd_01e', method: 'ping', params: {} },
      { id: 'cmd_01f', method: 'ping', params: {} }
    ]
  });
  let clock = CLOCK;
  const worker = createCommandWorker({
    nodeUrl: node.url,
    handlers: { ping: async () => 'pong' },
    heartbeatMs: 30000,
    now: () => clock,
    status: () => ({ sessions: 3 })
  });

  await worker.tick();
  assert.equal(node.state.heartbeats.length, 1);
  assert.deepEqual(node.state.heartbeats[0], {
    version: '',
    capabilities: ['ping'],
    sessions: 3,
    at: '2026-09-12T10:00:00.000Z'
  });
  assert.equal(worker.stats.lastHeartbeatAt, '2026-09-12T10:00:00.000Z');

  clock = CLOCK + 29000;
  await worker.tick();
  assert.equal(node.state.heartbeats.length, 1, 'inside the window nothing is sent');
  assert.equal(worker.stats.ticks, 2);

  clock = CLOCK + 30000;
  await worker.tick();
  assert.equal(node.state.heartbeats.length, 2, 'the window has elapsed');
  assert.equal(node.state.heartbeats[1].at, '2026-09-12T10:00:30.000Z');
  assert.equal(worker.stats.executed, 2, 'commands keep flowing while the heartbeat is throttled');

  // heartbeatMs: 0 means "every tick"; an explicit describe() wins over the handler names.
  const every = createCommandWorker({
    nodeUrl: node.url,
    handlers: { ping: async () => 'pong' },
    heartbeatMs: 0,
    now: () => clock,
    describe: () => ['ping', 'bridge.status']
  });
  await every.tick();
  await every.tick();
  assert.equal(node.state.heartbeats.length, 4);
  assert.deepEqual(node.state.heartbeats[3].capabilities, ['ping', 'bridge.status']);
});

test('commands: a failed heartbeat is recorded, keeps the stamp empty, and retries next tick', async () => {
  let attempts = 0;
  const worker = createCommandWorker({
    nodeUrl: 'http://node.test',
    handlers: { ping: async () => 'pong' },
    now: () => CLOCK,
    fetchImpl: stubFetch((url) => {
      if (url.includes('/heartbeat')) { attempts += 1; return { status: 500, body: { error: 'nope' } }; }
      return { body: { count: 0, commands: [] } };
    })
  });
  await worker.tick();
  assert.equal(attempts, 1);
  assert.equal(worker.stats.lastHeartbeatAt, null);
  assert.match(worker.stats.lastError, /HTTP 500 from POST .*\/heartbeat/);
  await worker.tick();
  assert.equal(attempts, 2, 'a failed beat is retried on the next tick');
});

test('commands: concurrent ticks share one poll instead of double-claiming', async (t) => {
  const node = await startNode(t, { commands: [{ id: 'cmd_01g', method: 'slow', params: {} }] });
  const worker = createCommandWorker({ nodeUrl: node.url, handlers: { slow: async () => 'done' } });
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(worker.stats.ticks, 1);
  assert.equal(node.state.results.length, 1);
});

test('commands: a command without an id is recorded and skipped', async () => {
  const worker = createCommandWorker({
    nodeUrl: 'http://node.test',
    handlers: { ping: async () => 'pong' },
    fetchImpl: stubFetch((url, options) => {
      if (options.method === 'GET') return { body: { count: 1, commands: [{ method: 'ping', params: {} }] } };
      if (url.includes('/result')) throw new Error('nothing should be posted: ' + url);
      return { body: { ok: true } };
    })
  });
  await worker.tick();
  assert.equal(worker.stats.executed, 0);
  assert.match(worker.stats.lastError, /without an id/);
});

/**
 * Stand-in for the DSH Host context, modelled on test/bridge.test.mjs. The prompt/list/inspect
 * fakes throw when the caller supplies no AbortSignal, exactly like the real wrapper that calls
 * signal.throwIfAborted() first thing.
 */
function fakeHost(options = {}) {
  const created = [];
  const renamed = [];
  const archived = [];
  const prompts = [];
  const archiveSet = [...(options.archived ?? [])];
  const workspaces = options.workspaces ?? [];
  const core = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((workspace) => workspace.id === id),
      create: async (dir, title) => ({ id: 'ws_new', path: dir, title }),
      archiveSession: async (sessionId) => { archived.push(sessionId); archiveSet.push(sessionId); },
      get archivedSessionIds() { return [...archiveSet]; }
    },
    sessionController: {
      list: async (request, signal) => {
        if (!signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
        return { items: options.sessions ?? [] };
      },
      inspect: async (sessionId, signal) => {
        if (!signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
        return (options.inspected ?? {})[sessionId] ?? null;
      },
      create: async (request) => {
        created.push(request);
        return { sessionId: request.sessionId ?? 'session-new-1', agentPreset: request.agentPreset };
      },
      rename: async (request) => {
        renamed.push(request);
        if (options.renameFails) throw new Error('this deployment mounts no session-title service');
        return { title: options.renameTo ?? request.title, seq: 7 };
      },
      prompt: async (request, signal) => {
        if (!signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
        prompts.push({ request, signal });
        return { accepted: true };
      }
    }
  };
  const ctx = options.strictServices
    ? new Proxy(core, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target) return target[prop];
        throw new Error('cannot read ctx.' + String(prop) + ' without declaring it in inject');
      }
    })
    : core;
  return { ctx, created, renamed, archived, prompts, workspaces, archiveSet };
}

const WORKSPACES = [
  { id: 'ws_1', title: 'proj-a', path: TMP, sessionIds: ['s1', 's2'] },
  { id: 'ws_2', title: 'proj-b', path: TMP + '-b', sessionIds: ['s3'] }
];

const SESSIONS = [
  {
    sessionId: 's1', updatedAt: Date.parse('2026-09-12T09:00:00.000Z'), cwd: TMP,
    projections: { asOfSeq: 4, values: { title: 'First session' } }
  },
  {
    sessionId: 's2', updatedAt: Date.parse('2026-09-12T08:00:00.000Z'), cwd: TMP,
    projections: { asOfSeq: 2, values: { title: null } }
  },
  { sessionId: 's3', updatedAt: Date.parse('2026-09-12T07:00:00.000Z'), cwd: TMP + '-b' }
];

test('dshops: workspaces.list normalizes rows and marks the archived subset', async () => {
  const host = fakeHost({ workspaces: WORKSPACES, sessions: SESSIONS, archived: ['s2'] });
  const ops = createDshOps({ ctx: host.ctx });
  assert.deepEqual(ops.describe(), [
    'workspaces.list', 'sessions.list', 'sessions.read', 'sessions.create',
    'sessions.prompt', 'sessions.rename', 'sessions.archive', 'bridge.status'
  ]);

  const result = await ops.methods['workspaces.list']({});
  assert.deepEqual(result, {
    workspaces: [
      {
        id: 'ws_1', title: 'proj-a', path: TMP, sessionIds: ['s1', 's2'],
        archived: true, archivedSessionIds: ['s2']
      },
      { id: 'ws_2', title: 'proj-b', path: TMP + '-b', sessionIds: ['s3'], archived: false }
    ],
    count: 2
  });
  assert.ok(!('archivedSessionIds' in result.workspaces[1]), 'the field stays out when there is nothing to list');
});

test('dshops: sessions.list joins workspaces, hides archived rows, and filters by selector', async () => {
  const host = fakeHost({ workspaces: WORKSPACES, sessions: SESSIONS, archived: ['s2'] });
  const ops = createDshOps({ ctx: host.ctx });

  const all = await ops.methods['sessions.list']({});
  assert.deepEqual(all, {
    sessions: [
      {
        sessionId: 's1', title: 'First session', workspaceId: 'ws_1', cwd: TMP,
        updatedAt: '2026-09-12T09:00:00.000Z', archived: false
      },
      {
        sessionId: 's3', title: '', workspaceId: 'ws_2', cwd: TMP + '-b',
        updatedAt: '2026-09-12T07:00:00.000Z', archived: false
      }
    ],
    count: 2,
    total: 2
  });

  const withArchived = await ops.methods['sessions.list']({ includeArchived: true });
  assert.equal(withArchived.total, 3);
  const hidden = withArchived.sessions.find((row) => row.sessionId === 's2');
  assert.equal(hidden.archived, true);
  assert.equal(hidden.workspaceId, 'ws_1');

  assert.deepEqual((await ops.methods['sessions.list']({ workspace: 'proj-b' })).sessions.map((row) => row.sessionId), ['s3']);
  assert.deepEqual((await ops.methods['sessions.list']({ workspace: 'ws_2' })).sessions.map((row) => row.sessionId), ['s3']);
  assert.deepEqual((await ops.methods['sessions.list']({ workspace: TMP.toUpperCase() })).sessions.map((row) => row.sessionId), ['s1']);

  await assert.rejects(() => ops.methods['sessions.list']({ workspace: 'nope' }), /no workspace matches "nope"/);
  assert.deepEqual((await ops.methods['sessions.list']({ limit: 1 })).sessions.map((row) => row.sessionId), ['s1']);
});

const EVENTS = [
  {
    type: 'system/message', seq: 0, time: Date.parse('2026-09-12T06:00:00.000Z'),
    data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are DSH' }] } }
  },
  {
    type: 'user/message', seq: 1, time: Date.parse('2026-09-12T06:00:01.000Z'),
    data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } }
  },
  {
    type: 'assistant/message', seq: 2, time: Date.parse('2026-09-12T06:00:02.000Z'),
    data: {
      turn: 1, step: 1, stream: [],
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }, { type: 'tool-call', id: 'call_1', name: 'fs_read', arguments: '{}' }]
      }
    }
  },
  {
    type: 'tool/result', seq: 3, time: Date.parse('2026-09-12T06:00:03.000Z'),
    data: {
      turn: 1, step: 1,
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] }]
      }
    }
  },
  { type: 'session/title', seq: 4, time: Date.parse('2026-09-12T06:00:04.000Z'), data: { title: 'Greeting session' } }
];

const INSPECTED = {
  s1: {
    meta: {
      id: 's1', createdAt: Date.parse('2026-09-12T06:00:00.000Z'), cwd: TMP,
      agentPreset: 'default', isSeeded: false
    },
    inheritedEventCount: 0,
    events: EVENTS
  },
  s2: {
    meta: { id: 's2', createdAt: Date.parse('2026-09-12T05:00:00.000Z'), cwd: TMP, isSeeded: false },
    inheritedEventCount: 0,
    events: [{
      type: 'user/message', seq: 0, time: Date.parse('2026-09-12T05:00:01.000Z'),
      data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'archived note' }], source: { kind: 'user' } }
    }]
  }
};

test('dshops: sessions.read normalizes the transcript and folds the durable title', async () => {
  const host = fakeHost({ workspaces: WORKSPACES, sessions: SESSIONS, inspected: INSPECTED, archived: ['s2'] });
  const ops = createDshOps({ ctx: host.ctx });

  const result = await ops.methods['sessions.read']({ sessionId: 's1' });
  assert.deepEqual(result.session, {
    sessionId: 's1',
    title: 'Greeting session',
    cwd: TMP,
    createdAt: '2026-09-12T06:00:00.000Z',
    agentPreset: 'default',
    parentSession: '',
    origin: 'session',
    workspaceId: 'ws_1',
    archived: false,
    messages: 4,
    hasMore: false
  });
  assert.deepEqual(result.messages, [
    { role: 'system', kind: 'system/message', text: 'You are DSH', time: '2026-09-12T06:00:00.000Z', truncated: false },
    { role: 'user', kind: 'user/message', text: 'hello there', time: '2026-09-12T06:00:01.000Z', truncated: false },
    { role: 'assistant', kind: 'assistant/message', text: 'hi\n[tool-call: fs_read]', time: '2026-09-12T06:00:02.000Z', truncated: false },
    { role: 'tool', kind: 'tool/result', text: 'file body', time: '2026-09-12T06:00:03.000Z', truncated: false }
  ]);

  const head = await ops.methods['sessions.read']({ sessionId: 's1', limit: 2 });
  assert.deepEqual(head.messages.map((row) => row.role), ['system', 'user']);
  assert.equal(head.session.hasMore, true);
  const tail = await ops.methods['sessions.read']({ sessionId: 's1', limit: 2, tail: true });
  assert.deepEqual(tail.messages.map((row) => row.role), ['assistant', 'tool']);

  await assert.rejects(() => ops.methods['sessions.read']({}), /sessionId is required/);
  await assert.rejects(() => ops.methods['sessions.read']({ sessionId: 'ghost' }), /session "ghost" was not found/);

  // Archived sessions are reported, not hidden, on a direct read.
  const archivedRead = await ops.methods['sessions.read']({ sessionId: 's2' });
  assert.equal(archivedRead.session.archived, true);
});

test('dshops: sessions.read clips message text to limits.maxChars', async () => {
  const host = fakeHost({ inspected: INSPECTED });
  const ops = createDshOps({ ctx: host.ctx, limits: { maxChars: 5 } });
  const result = await ops.methods['sessions.read']({ sessionId: 's1' });
  assert.deepEqual(result.messages.slice(0, 2), [
    { role: 'system', kind: 'system/message', text: 'You a', time: '2026-09-12T06:00:00.000Z', truncated: true },
    { role: 'user', kind: 'user/message', text: 'hello', time: '2026-09-12T06:00:01.000Z', truncated: true }
  ]);
});

test('dshops: sessions.read works without a workspace registry', async () => {
  const host = fakeHost({ inspected: INSPECTED });
  delete host.ctx.workspaceRegistry;
  const ops = createDshOps({ ctx: host.ctx });
  const result = await ops.methods['sessions.read']({ sessionId: 's1' });
  assert.equal(result.session.workspaceId, '');
  assert.equal(result.session.archived, false);
  assert.equal(result.messages.length, 4);
});

test('dshops: sessions.create sends one location and applies the title through rename', async () => {
  const host = fakeHost({ workspaces: WORKSPACES, sessions: SESSIONS });
  const ops = createDshOps({ ctx: host.ctx });

  const created = await ops.methods['sessions.create']({
    workspaceId: 'ws_1', cwd: 'D:\\ignored', agentPreset: 'fast', title: 'Remote title'
  });
  assert.deepEqual(host.created, [{ workspaceId: 'ws_1', agentPreset: 'fast' }]);
  assert.deepEqual(host.renamed, [{ sessionId: 'session-new-1', title: 'Remote title' }]);
  assert.deepEqual(created, { sessionId: 'session-new-1', title: 'Remote title' });

  const bare = await ops.methods['sessions.create']({ cwd: TMP });
  assert.deepEqual(host.created[1], { cwd: TMP });
  assert.deepEqual(bare, { sessionId: 'session-new-1', title: '' });
});

test('dshops: sessions.create reports a rename miss without failing the creation', async () => {
  const host = fakeHost({ renameFails: true });
  const ops = createDshOps({ ctx: host.ctx });
  const result = await ops.methods['sessions.create']({ cwd: TMP, title: 'Untitled' });
  assert.equal(result.sessionId, 'session-new-1');
  assert.equal(result.title, '');
  assert.match(result.renameError, /no session-title service/);
});

test('dshops: sessions.prompt always passes an AbortSignal and a stable request id', async () => {
  const host = fakeHost({});
  const ops = createDshOps({ ctx: host.ctx });

  const result = await ops.methods['sessions.prompt']({ sessionId: 's1', text: 'do the thing' }, { id: 'cmd_01zzz' });
  assert.deepEqual(result, { accepted: true, sessionId: 's1' });
  assert.equal(host.prompts.length, 1);
  const { request, signal } = host.prompts[0];
  assert.deepEqual(request, {
    sessionId: 's1',
    requestId: 'bridge-command:cmd_01zzz',
    mode: 'queue',
    content: [{ type: 'text', text: 'do the thing' }]
  });
  assert.equal(typeof signal.throwIfAborted, 'function', 'prompt must be admitted with a caller signal');
  assert.equal(signal.aborted, false);

  await ops.methods['sessions.prompt']({ sessionId: 's1', text: 'again', requestId: 'caller-supplied' });
  assert.equal(host.prompts[1].request.requestId, 'caller-supplied');

  await ops.methods['sessions.prompt']({ sessionId: 's1', text: 'no context' });
  assert.match(host.prompts[2].request.requestId, /^bridge-command:/);

  await assert.rejects(() => ops.methods['sessions.prompt']({ sessionId: 's1', text: '   ' }), /text is required/);
  await assert.rejects(() => ops.methods['sessions.prompt']({ text: 'x' }), /sessionId is required/);
});

test('dshops: rename, archive, and bridge.status report normalized values', async () => {
  const host = fakeHost({ renameTo: 'Normalized title' });
  let statusCalls = 0;
  const ops = createDshOps({
    ctx: host.ctx,
    status: () => { statusCalls += 1; return { ok: true, sessions: 2, ticks: 5, note: 'from the plugin' }; }
  });

  assert.deepEqual(await ops.methods['sessions.rename']({ sessionId: 's1', title: 'raw' }), {
    sessionId: 's1', title: 'Normalized title'
  });
  assert.deepEqual(host.renamed, [{ sessionId: 's1', title: 'raw' }]);
  await assert.rejects(() => ops.methods['sessions.rename']({ sessionId: 's1' }), /title is required/);

  assert.deepEqual(await ops.methods['sessions.archive']({ sessionId: 's1' }), { archived: true });
  assert.deepEqual(host.archived, ['s1']);
  assert.deepEqual(host.archiveSet, ['s1']);

  assert.deepEqual(await ops.methods['bridge.status']({}), { ok: true, sessions: 2, ticks: 5, note: 'from the plugin' });
  assert.equal(statusCalls, 1);

  const plain = await createDshOps({ ctx: host.ctx }).methods['bridge.status']({});
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.methods, createDshOps({ ctx: host.ctx }).describe());
  assert.equal(plain.limits.maxChars, 8000);
  assert.equal(plain.limits.maxResultChars, 200000);
});

test('dshops: a missing or undeclared service is a readable error, never a construction throw', async () => {
  const bare = createDshOps({});
  assert.equal(bare.describe().length, 8, 'the map is complete without any Host service');
  await assert.rejects(() => bare.methods['workspaces.list']({}), /workspaceRegistry is unavailable$/);
  await assert.rejects(() => bare.methods['sessions.list']({}), /sessionController is unavailable$/);
  await assert.rejects(() => bare.methods['sessions.read']({ sessionId: 's' }), /sessionController is unavailable$/);
  await assert.rejects(() => bare.methods['sessions.archive']({ sessionId: 's' }), /workspaceRegistry is unavailable$/);

  // New cordis throws when a plugin reads a service it did not declare in inject: the strict
  // host reproduces that, and the map is built without reading anything, so construction is
  // safe and the failure surfaces per method as a readable error.
  const strictHost = fakeHost({ strictServices: true });
  delete strictHost.ctx.workspaceRegistry;
  delete strictHost.ctx.sessionController;
  assert.throws(() => strictHost.ctx.interval, /without declaring it in inject/, 'the strict guard is armed');
  const strictOps = createDshOps({ ctx: strictHost.ctx });
  await assert.rejects(() => strictOps.methods['workspaces.list']({}), /workspaceRegistry is unavailable$/);
  await assert.rejects(() => strictOps.methods['sessions.list']({}), /sessionController is unavailable$/);

  // A service whose getter itself explodes reads as unavailable too.
  const exploding = createDshOps({ ctx: new Proxy({}, { get() { throw new Error('boom'); } }) });
  await assert.rejects(() => exploding.methods['sessions.list']({}), /sessionController is unavailable/);
});

test('dshops: an oversized result is trimmed and marked truncated', async () => {
  const filler = 'x'.repeat(200);
  const workspaces = Array.from({ length: 40 }, (ignored, index) => ({
    id: 'ws_' + index, title: 'workspace ' + index, path: TMP + '\\' + filler, sessionIds: []
  }));
  const host = fakeHost({ workspaces });
  const ops = createDshOps({ ctx: host.ctx, limits: { maxResultChars: 400 } });
  const result = await ops.methods['workspaces.list']({});
  assert.equal(result.truncated, true);
  assert.ok(result.dropped > 0, 'the dropped count is reported');
  assert.ok(result.workspaces.length < 40);
  assert.ok(JSON.stringify(result).length <= 400, 'the envelope fits the budget');

  const unlimited = createDshOps({ ctx: host.ctx });
  const full = await unlimited.methods['workspaces.list']({});
  assert.equal(full.truncated, undefined);
  assert.equal(full.workspaces.length, 40);
});

test('dshops: sessions.list names the workspace handle it was given', async () => {
  const host = fakeHost({ workspaces: WORKSPACES, sessions: SESSIONS });
  const ops = createDshOps({ ctx: host.ctx });
  const rows = (await ops.methods['sessions.list']({ workspace: 'proj-a', limit: 1000 })).sessions;
  assert.deepEqual(rows.map((row) => row.sessionId), ['s1', 's2']);

  // The session account is smaller than the requested limit; nothing is invented.
  const nothing = fakeHost({ workspaces: [{ id: 'ws_9', title: 'empty', path: TMP, sessionIds: [] }], sessions: SESSIONS });
  const empty = await createDshOps({ ctx: nothing.ctx }).methods['sessions.list']({ workspace: 'ws_9' });
  assert.deepEqual(empty, { sessions: [], count: 0, total: 0 });
});
