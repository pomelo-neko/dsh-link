import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { makeNode, resetTmp, TMP } from './helpers.mjs';
import { apply as applyBridge, internals as bridgeInternals } from '../integrations/dsh-link-bridge/lib/index.js';
import { planDshInstall } from '../src/pairing.mjs';

/**
 * Stand-in for the DSH Host context. With strictServices it mirrors what new cordis does:
 * reading a service the plugin did not declare in inject throws instead of returning undefined.
 */
function fakeCtx({ strictServices = false, effect, createId } = {}) {
  const prompts = [];
  const created = [];
  const logs = [];
  const disposers = [];
  const archived = [];
  const renamed = [];
  const push = (level) => (...args) => logs.push(level + ': ' + args.join(' '));
  const core = {
    logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: () => {} },
    workspaceRegistry: {
      create: async (dir) => ({ id: 'ws_test', path: dir }),
      // 0.3: retired topic sessions are handed to the DSH-native archive set.
      archiveSession: async (sessionId) => { archived.push(sessionId); },
      // Used by the capability worker's workspaces.list handler.
      list: () => [{ id: 'ws_test', title: 'test workspace', path: 'D:\\tmp\\ws_test', sessionIds: [] }],
      archivedSessionIds: []
    },
    sessionController: {
      create: async (request) => {
        created.push(request);
        const fallback = createId ? createId(created.length) : 'session-bridge-test';
        return { sessionId: request.sessionId ?? fallback };
      },
      // 0.3: a new session is titled so the sidebar shows which topic it belongs to.
      rename: async (request) => { renamed.push(request); return { sessionId: request.sessionId, title: request.title }; },
      // The real wrapper calls signal.throwIfAborted() before admitting a prompt, so the
      // bridge must pass one; mirror that requirement so a missing signal fails the test.
      prompt: async (request, signal) => {
        if (!signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
        prompts.push({ request, signal });
        return { accepted: true };
      }
    },
    effect: effect ?? ((execute) => { disposers.push(execute()); return () => {}; }),
    on: () => () => {}
  };
  const ctx = strictServices
    ? new Proxy(core, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop in target) return target[prop];
        throw new Error('cannot read ctx.' + String(prop) + ' without declaring it in inject');
      }
    })
    : core;
  return { ctx, prompts, created, logs, disposers, archived, renamed };
}

/**
 * The bridge owns two intervals since 0.3: the message poll (pollSeconds) and the capability
 * worker (commandSeconds). Tests drive the message poll, so pick it out by its period.
 */
function messagePoll(scheduled, ms = 60000) {
  const found = scheduled.find((entry) => entry.ms === ms);
  assert.ok(found, 'the message poll must be scheduled (' + scheduled.map((entry) => entry.ms).join(', ') + ')');
  return found;
}

/**
 * Start the bridge with an isolated state dir: without this a test would write the real
 * $DSH_HOME/plugin-data/dsh-link-bridge/state.json (it did once — see the 0.2.3 notes).
 */
let bridgeRun = 0;
function startBridge(ctx, config) {
  bridgeRun += 1;
  const stateDir = config.stateDir ?? path.join(TMP, 'state-' + bridgeRun);
  applyBridge(ctx, { ...config, stateDir });
  return stateDir;
}

/** Capture the poll loop instead of really scheduling it. */
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

/** The heartbeat lands at the end of a tick, so poll for it instead of racing the write. */
async function waitForState(file, predicate, label, timeoutMs = 3000) {
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

async function inboxMessage(node, id, peer, subject, body, ts = new Date().toISOString(), thread) {
  const record = {
    id, ts,
    from: { nodeId: 'node_' + peer, name: peer, url: 'http://127.0.0.1:1' },
    to: node.cfg.name, thread: thread ?? id, replyTo: null, kind: 'message',
    subject, body, attachments: []
  };
  await node.ops.acceptMessage(record);
  return record;
}

test('bridge: an arriving message wakes a session with the message text', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node' });
  t.after(() => node.close());
  await inboxMessage(node, 'msg_01aaa0001', 'LAPTOP-TEST', '请检查构建', '跑一下测试并把结果发回', '2026-09-11T10:00:00.000Z');

  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = path.join(TMP, 'bridge-state');
  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir
  });

  assert.equal(scheduled.filter((entry) => entry.ms === 60000).length, 1, 'exactly one message poll loop');
  await waitFor(() => fake.prompts.length === 1, 'the bridge to prompt a session');
  const { request: prompt, signal } = fake.prompts[0];
  assert.equal(prompt.sessionId, 'session-bridge-test');
  assert.equal(prompt.requestId, 'link-bridge:session-bridge-test:msg_01aaa0001');
  assert.equal(typeof signal.throwIfAborted, 'function', 'prompt must be admitted with a caller signal');
  assert.equal(signal.aborted, false);
  const text = prompt.content[0].text;
  assert.match(text, /跑一下测试并把结果发回/, 'the body reaches the model');
  assert.match(text, /请检查构建/);
  assert.match(text, /LAPTOP-TEST/, 'the peer name is named in the prompt');
  assert.match(text, /bridge-node/, 'the local node name is named in the prompt');
  assert.equal(fake.created[0].workspaceId, 'ws_test');

  const state = await waitForState(
    path.join(stateDir, 'state.json'),
    (snapshot) => snapshot.watermark === 'msg_01aaa0001',
    'the heartbeat to record the wake'
  );
  assert.equal(state.sessionId, 'session-bridge-test');
  assert.equal(state.errors, 0);
  assert.equal(state.notified, 1);

  await messagePoll(scheduled).callback();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fake.prompts.length, 1, 'no duplicate wake-up for the same message');
});

test('bridge: a configured sessionId is reused and older messages stay quiet', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-2' });
  t.after(() => node.close());
  await inboxMessage(node, 'msg_01aaa0001', 'LAPTOP-TEST', 'old', 'already handled', '2026-09-11T10:00:00.000Z');
  await inboxMessage(node, 'msg_01bbb0002', 'LAPTOP-OTHER', 'new', 'please reply', '2026-09-11T10:00:05.000Z');

  captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = path.join(TMP, 'bridge-state-2');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    sessionId: 'session-remembered', watermark: 'msg_01aaa0001',
    watermarkTs: '2026-09-11T10:00:00.000Z', watermarkId: 'msg_01aaa0001', lastNotifyAt: 0
  }));

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-2'),
    sessionId: 'session-fixed',
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir
  });

  await waitFor(() => fake.prompts.length === 1, 'the bridge to prompt the fixed session');
  assert.equal(fake.prompts[0].request.sessionId, 'session-fixed');
  assert.doesNotMatch(fake.prompts[0].request.content[0].text, /already handled/, 'messages below the watermark stay quiet');
  assert.match(fake.prompts[0].request.content[0].text, /please reply/);
});

test('bridge: without a workspace it stays idle instead of inventing one', async (t) => {
  await resetTmp();
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  startBridge(fake.ctx, { nodeUrl: 'http://127.0.0.1:1', workspacePath: '' });
  assert.equal(scheduled.length, 0, 'no polling without a workspace');
  assert.ok(fake.logs.some((line) => line.startsWith('warn: workspacePath is not configured')), fake.logs.join(' | '));

  const off = fakeCtx();
  startBridge(off.ctx, { enabled: false, workspacePath: process.cwd() });
  assert.equal(scheduled.length, 0);
  assert.ok(off.logs.some((line) => line.includes('disabled by config')));
});

test('bridge: never reads an undeclared service (new cordis throws on those reads)', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-3' });
  t.after(() => node.close());
  await inboxMessage(node, 'msg_01ccc0003', 'LAPTOP-TEST', 'guard', 'undeclared service reads must not happen');

  const scheduled = captureSchedule(t);
  const fake = fakeCtx({ strictServices: true });
  assert.throws(() => fake.ctx.interval(() => {}, 1000), /without declaring it in inject/, 'the guard is armed');

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-3'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir: path.join(TMP, 'bridge-state-3')
  });

  assert.ok(scheduled.length >= 1, 'polling still starts under the strict guard');
  await waitFor(() => fake.prompts.length === 1, 'the session to be prompted under the strict guard');
});

test('bridge: a setup failure disables the bridge instead of breaking the boot', async (t) => {
  await resetTmp();
  captureSchedule(t);
  const broken = fakeCtx({ effect: () => { throw new Error('INACTIVE_EFFECT'); } });
  startBridge(broken.ctx, { nodeUrl: 'http://127.0.0.1:1', workspacePath: path.join(TMP, 'x') });
  assert.equal(broken.prompts.length, 0);

  const hostile = fakeCtx({ strictServices: true });
  Object.defineProperty(hostile.ctx, 'logger', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => startBridge(hostile.ctx, { workspacePath: path.join(TMP, 'y') }), 'apply must never throw');
});

test('bridge: install-dsh plans an idempotent patch entry', async () => {
  await resetTmp();
  const home = path.join(TMP, 'dsh-home');
  const profileDir = path.join(home, 'profiles', 'web');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), [
    '- insert:',
    "    - id: mcp-dshlink",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        url: http://127.0.0.1:8787/mcp',
    ''
  ].join('\n'));

  await assert.rejects(
    () => planDshInstall({ dshHome: home, bridge: true, includeSkill: false }),
    /needs a workspace path/
  );

  const plan = await planDshInstall({
    dshHome: home,
    bridge: true,
    bridgeWorkspace: 'D:\\work\\remote-inbox',
    includeSkill: false
  });
  assert.equal(plan.bridge.mode, 'append');
  assert.match(plan.patchContent, /id: dsh-link-bridge/);
  assert.match(plan.patchContent, /workspacePath: "D:\\\\work\\\\remote-inbox"/, plan.patchContent);

  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), plan.patchContent);
  const again = await planDshInstall({ dshHome: home, bridge: true, bridgeWorkspace: 'D:\\work\\remote-inbox', includeSkill: false });
  assert.equal(again.bridge.mode, 'unchanged', 're-planning the same settings must be a no-op');
  assert.equal(again.patchContent, plan.patchContent);
});
test('bridge: a foreign id that sorts above real ids cannot block the queue', async (t) => {
  // Regression: an id-only watermark was poisoned by a synthetic self-check id — the string
  // "msg_bridgecheck…" sorts ABOVE every real ULID ("msg_01m28…"), so all later messages looked
  // older than the watermark and the bridge stayed silent while unread mail piled up.
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-5' });
  t.after(() => node.close());
  await inboxMessage(node, 'msg_01aaa0001', 'LAPTOP', 'old', 'handled earlier', '2026-09-11T10:00:00.000Z');

  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = path.join(TMP, 'bridge-state-5');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'state.json'), JSON.stringify({
    sessionId: 'session-poisoned',
    watermark: 'msg_bridgecheckmtwybutt',
    watermarkTs: '2026-09-11T10:00:00.000Z',
    watermarkId: 'msg_bridgecheckmtwybutt',
    lastNotifyAt: 0
  }));

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-5'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    stateDir
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.prompts.length, 0, 'a message at/below the watermark stays quiet');

  await inboxMessage(node, 'msg_01bbb0002', 'LAPTOP', 'new', 'please handle this', '2026-09-11T10:00:30.000Z');
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 1, 'the later real message to wake a session');
  assert.match(fake.prompts[0].request.content[0].text, /please handle this/);
});
test('bridge: the loop guard stops two auto-waking machines from ping-ponging', async (t) => {
  // Two machines that both run this bridge can bounce automated replies forever: our wake ->
  // our reply -> their wake -> their reply -> ... Each round is a new message, so the watermark
  // alone never stops it. The per-thread wake budget does.
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-6' });
  t.after(() => node.close());
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = path.join(TMP, 'bridge-state-6');

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-6'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    threadCooldownSeconds: 0,
    maxThreadWakes: 2,
    maxWakesPerHour: 50,
    stateDir
  });

  const thread = 'msg_thread0001';
  await inboxMessage(node, thread, 'LAPTOP', 'start', 'hello there', '2026-09-11T12:00:00.000Z');
  await waitFor(() => fake.prompts.length === 1, 'the first wake');

  await inboxMessage(node, 'msg_reply0002', 'LAPTOP', 'Re: start', 'auto reply one', '2026-09-11T12:00:30.000Z', thread);
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 2, 'the second wake');

  await inboxMessage(node, 'msg_reply0003', 'LAPTOP', 'Re: Re: start', 'auto reply two', '2026-09-11T12:01:00.000Z', thread);
  await messagePoll(scheduled).callback();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.prompts.length, 2, 'the third wake in one thread is cut off');

  const state = await waitForState(
    path.join(stateDir, 'state.json'),
    (snapshot) => snapshot.suppressed >= 1,
    'the guard to record the suppression'
  );
  assert.match(state.lastSuppressed.reason, /thread budget/);
  assert.equal(state.lastSuppressed.dropped, true);
  // 0.3 keys the loop guard by topic: a thread message maps to "thread:<id>".
  assert.equal(state.lastSuppressed.thread, 'thread:' + thread);
  assert.equal(state.watermarkId, 'msg_reply0003', 'the dropped message still advances the watermark');
});

test('bridge: a per-thread cooldown holds later replies instead of dropping them', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-7' });
  t.after(() => node.close());
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  const stateDir = path.join(TMP, 'bridge-state-7');

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-7'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    threadCooldownSeconds: 600,
    stateDir
  });

  const thread = 'msg_thread0002';
  await inboxMessage(node, thread, 'LAPTOP', 'start', 'first', '2026-09-11T12:00:00.000Z');
  await waitFor(() => fake.prompts.length === 1, 'the first wake');

  await inboxMessage(node, 'msg_reply0004', 'LAPTOP', 'Re: start', 'second', '2026-09-11T12:00:30.000Z', thread);
  await messagePoll(scheduled).callback();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fake.prompts.length, 1, 'the cooldown holds the second wake');

  const state = await waitForState(
    path.join(stateDir, 'state.json'),
    (snapshot) => snapshot.suppressed >= 1 && snapshot.lastSuppressed && snapshot.lastSuppressed.dropped === false,
    'the cooldown to be recorded as a soft hold'
  );
  assert.match(state.lastSuppressed.reason, /thread cooldown/);
  assert.equal(state.watermarkId, thread, 'a soft hold leaves the watermark alone so nothing is lost');
});

test('bridge: one session per topic, and a retired session is archived', async (t) => {
  // 0.2.x reused a single session forever, so unrelated topics piled into one context.
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-8' });
  t.after(() => node.close());
  const scheduled = captureSchedule(t);
  const fake = fakeCtx({ createId: (n) => 'session-topic-' + n });
  const stateDir = path.join(TMP, 'bridge-state-8');

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-8'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    threadCooldownSeconds: 0,
    maxThreadWakes: 10,
    topics: { maxSessionWakes: 2 },
    stateDir
  });

  await inboxMessage(node, 'msg_alpha001', 'LAPTOP', '构建失败', '看一下构建', '2026-09-11T13:00:00.000Z', 'thread-alpha');
  await waitFor(() => fake.prompts.length === 1, 'the first topic wake');
  assert.equal(fake.created.length, 1, 'a new topic opens its own session');
  assert.equal(fake.prompts[0].request.sessionId, 'session-topic-1');
  assert.match(fake.renamed[0].title, /^\[dsh-link\] /, 'the session is titled so the sidebar shows the topic');

  await inboxMessage(node, 'msg_alpha002', 'LAPTOP', 'Re: 构建失败', '补充说明', '2026-09-11T13:00:30.000Z', 'thread-alpha');
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 2, 'the second wake on the same topic');
  assert.equal(fake.created.length, 1, 'the same topic keeps its session');
  assert.equal(fake.prompts[1].request.sessionId, 'session-topic-1');

  await inboxMessage(node, 'msg_alpha003', 'LAPTOP', 'Re: Re: 构建失败', '还在失败', '2026-09-11T13:01:00.000Z', 'thread-alpha');
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 3, 'the rotation wake');
  assert.equal(fake.created.length, 2, 'an exhausted topic rotates to a fresh session');
  assert.equal(fake.prompts[2].request.sessionId, 'session-topic-2');
  assert.deepEqual(fake.archived, ['session-topic-1'], 'the retired session is archived');

  await inboxMessage(node, 'msg_beta001', 'LAPTOP', '另一个问题', '别的主题', '2026-09-11T13:02:00.000Z', 'thread-beta');
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 4, 'the other topic wake');
  assert.equal(fake.created.length, 3, 'a different thread is a different topic');
  assert.equal(fake.prompts[3].request.sessionId, 'session-topic-3');

  const state = await waitForState(
    path.join(stateDir, 'state.json'),
    (snapshot) => snapshot.sessionsCreated >= 3,
    'the heartbeat to record the topic pool'
  );
  assert.equal(state.sessionsArchived, 1);
  assert.deepEqual(Object.keys(state.pool).sort(), ['thread:thread-alpha', 'thread:thread-beta'], 'every topic is remembered');
  assert.equal(state.pool['thread:thread-alpha'].archived, false);
  assert.equal(state.pool['thread:thread-alpha'].sessionId, 'session-topic-2', 'the pool points at the live session');
});

test('bridge: a topic that goes quiet is archived by the sweeper', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'bridge-node-9' });
  t.after(() => node.close());
  const scheduled = captureSchedule(t);
  const fake = fakeCtx({ createId: (n) => 'session-sweep-' + n });
  const stateDir = path.join(TMP, 'bridge-state-9');

  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-9'),
    pollSeconds: 60,
    cooldownSeconds: 0,
    threadCooldownSeconds: 0,
    topics: { archiveIdleSeconds: 1 },
    stateDir
  });

  await inboxMessage(node, 'msg_quiet001', 'LAPTOP', '稍后处理', '先放着', '2026-09-11T14:00:00.000Z', 'thread-quiet');
  await waitFor(() => fake.prompts.length === 1, 'the first wake');
  assert.equal(fake.archived.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 1100));
  await messagePoll(scheduled).callback(); // no new messages: the tick still sweeps the pool
  await waitFor(() => fake.archived.length === 1, 'the idle session to be archived');
  assert.equal(fake.prompts.length, 1, 'sweeping must not wake anything');

  const state = await waitForState(
    path.join(stateDir, 'state.json'),
    (snapshot) => snapshot.pool && Object.values(snapshot.pool).some((entry) => entry.archived === true),
    'the pool to mark the topic archived'
  );
  assert.equal(state.lastArchive.reason, 'archive-idle');
  assert.equal(state.lastArchive.ok, true);
  // The next message on that topic must open a fresh session instead of reusing the archived one.
  await inboxMessage(node, 'msg_quiet002', 'LAPTOP', '稍后处理', '现在可以了', '2026-09-11T14:05:00.000Z', 'thread-quiet');
  await messagePoll(scheduled).callback();
  await waitFor(() => fake.prompts.length === 2, 'the revived topic wake');
  assert.equal(fake.prompts[1].request.sessionId, 'session-sweep-2');
});

test('bridge: a capability call from the node is executed through the worker', async (t) => {
  // End to end over the real HTTP contract: node queue -> bridge worker -> Host handler -> result.
  await resetTmp();
  const node = await makeNode({
    name: 'bridge-node-10',
    capabilities: { enabled: true, methods: ['workspaces.list'] }
  });
  t.after(() => node.close());
  const scheduled = captureSchedule(t);
  const fake = fakeCtx();
  startBridge(fake.ctx, {
    nodeUrl: node.url,
    workspacePath: path.join(TMP, 'bridge-ws-10'),
    pollSeconds: 600,
    cooldownSeconds: 0,
    commandSeconds: 1,
    stateDir: path.join(TMP, 'bridge-state-10')
  });

  // The schedule is captured (no real timers), so drive one worker tick by hand.
  const commandPoll = scheduled.find((entry) => entry.ms === 1000);
  assert.ok(commandPoll, 'the capability worker schedules its own poll');

  const queued = await node.ops.dshCallLocal({
    method: 'workspaces.list',
    params: {},
    waitSeconds: 0,
    origin: { peer: 'TEST-PEER', ip: '127.0.0.1', label: 'peer' }
  });
  assert.equal(queued.pending, true, 'without a wait the call is queued');
  // The scheduled callback starts worker.tick() without awaiting it, so drive one tick and then
  // poll the queue for the terminal state instead of assuming the callback finished the work.
  await commandPoll.callback();
  let result = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const snapshot = await node.ops.dshCallResult({ id: queued.commandId });
    if (snapshot.status !== 'pending') { result = snapshot; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(result, 'the worker must answer the queued command');
  assert.equal(result.status, 'done', JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.equal(result.result.workspaces[0].id, 'ws_test');
  assert.equal(result.result.workspaces[0].title, 'test workspace');
  assert.equal(result.origin.peer, 'TEST-PEER', 'the audit trail keeps who asked');
});

