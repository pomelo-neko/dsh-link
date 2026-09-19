// Tests for the capability policy + bridge command queue (src/capabilities.mjs).
// This file owns a private tmp subtree (test/.tmp/capabilities-<pid>) so it never collides with
// the shared test/.tmp/unit that other test files use.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  CAPABILITY_DEFAULTS, CAPABILITY_METHODS, authorizeCall, createBridgePresence, createCommandQueue,
  normalizeCapabilityConfig
} from '../src/capabilities.mjs';
import { LinkError } from '../src/util.mjs';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TMP = path.join(PROJECT_DIR, 'test', '.tmp', 'capabilities-' + process.pid);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

after(() => fs.rm(TMP, { recursive: true, force: true }));

async function tmpDir(t, name) {
  const dir = path.join(TMP, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const enabledCfg = (extra = {}) => ({ enabled: true, methods: [...CAPABILITY_DEFAULTS.methods], ...extra });

// Command ids are time-sortable at millisecond resolution; a small gap keeps claim() order (and
// therefore these assertions) deterministic.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rewrite a queued command's createdAt so sweep()/claim() see it as old. */
async function backdateCommand(dir, id, ms) {
  const file = path.join(dir, id + '.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.createdAt = new Date(Date.now() - ms).toISOString();
  await fs.writeFile(file, JSON.stringify(record), 'utf8');
}

test('normalizeCapabilityConfig: keeps only known methods and falls back to defaults', () => {
  const defaults = normalizeCapabilityConfig();
  assert.equal(defaults.enabled, false);
  assert.deepEqual(defaults.methods, CAPABILITY_DEFAULTS.methods);
  assert.deepEqual(Object.keys(defaults).sort(), Object.keys(CAPABILITY_DEFAULTS).sort());

  const messy = normalizeCapabilityConfig({
    enabled: 'yes',
    methods: ['sessions.prompt', 'nope.method', 'sessions.prompt', 42],
    peers: { 'my laptop': { allow: ['sessions.prompt', 'bogus'], deny: 'nope' }, broken: null, '': { allow: ['sessions.list'] } },
    maxPending: 0,
    maxResultBytes: 1e9,
    commandTtlSeconds: 'abc'
  });
  assert.equal(messy.enabled, true);
  assert.deepEqual(messy.methods, ['sessions.prompt']);
  assert.deepEqual(messy.peers['my-laptop'], { allow: ['sessions.prompt'], deny: [] });
  assert.deepEqual(messy.peers.broken, { allow: [], deny: [] });
  assert.equal(messy.peers[''], undefined);
  assert.equal(messy.maxPending, 1);
  assert.equal(messy.maxResultBytes, 64 * 1024 * 1024);
  assert.equal(messy.commandTtlSeconds, CAPABILITY_DEFAULTS.commandTtlSeconds);

  // a whole node config is accepted as well: the nested capability section wins
  const nested = normalizeCapabilityConfig({ name: 'node-a', capabilities: { enabled: true, methods: ['sessions.list'] } });
  assert.equal(nested.enabled, true);
  assert.deepEqual(nested.methods, ['sessions.list']);
  assert.deepEqual(normalizeCapabilityConfig(nested), nested, 'normalization must be idempotent');
  assert.equal(CAPABILITY_METHODS['sessions.prompt'].kind, 'action');
});

test('authorizeCall: everything is refused while the channel is disabled', () => {
  const off = normalizeCapabilityConfig({ methods: ['workspaces.list', 'sessions.prompt'] });
  for (const peer of ['', 'laptop']) {
    assert.deepEqual(authorizeCall(off, { peer, method: 'workspaces.list' }), { ok: false, reason: 'capabilities_disabled' });
  }
  // local calls (peer '') are not exempt from enabled + methods
  const on = normalizeCapabilityConfig({ enabled: true });
  assert.equal(authorizeCall(on, { peer: '', method: 'workspaces.list' }).ok, true);
  assert.deepEqual(authorizeCall(on, { peer: '', method: 'sessions.prompt' }), { ok: false, reason: 'method_not_allowed' });
});

test('authorizeCall: an action stays refused until it is enabled', () => {
  const on = normalizeCapabilityConfig({ enabled: true });
  assert.deepEqual(authorizeCall(on, { peer: 'laptop', method: 'sessions.list' }), { ok: true, reason: 'allowed' });
  assert.deepEqual(authorizeCall(on, { peer: 'laptop', method: 'sessions.prompt' }), { ok: false, reason: 'method_not_allowed' });
  assert.deepEqual(authorizeCall(on, { peer: 'laptop', method: 'sessions.create' }), { ok: false, reason: 'method_not_allowed' });

  const enabled = normalizeCapabilityConfig({ enabled: true, methods: [...CAPABILITY_DEFAULTS.methods, 'sessions.prompt'] });
  assert.deepEqual(authorizeCall(enabled, { peer: 'laptop', method: 'sessions.prompt' }), { ok: true, reason: 'allowed' });
});

test('authorizeCall: peer allow/deny overrides the node-wide list', () => {
  const cfg = normalizeCapabilityConfig({
    enabled: true,
    methods: ['workspaces.list', 'sessions.list', 'sessions.prompt'],
    peers: {
      laptop: { deny: ['sessions.prompt'] },
      guest: { allow: ['sessions.list'] },
      auditor: { allow: ['sessions.read'] }
    }
  });
  assert.equal(authorizeCall(cfg, { peer: 'laptop', method: 'workspaces.list' }).ok, true);
  assert.deepEqual(authorizeCall(cfg, { peer: 'laptop', method: 'sessions.prompt' }), { ok: false, reason: 'peer_denied' });
  assert.deepEqual(authorizeCall(cfg, { peer: 'guest', method: 'workspaces.list' }), { ok: false, reason: 'peer_not_allowed' });
  assert.equal(authorizeCall(cfg, { peer: 'guest', method: 'sessions.list' }).ok, true);
  // a peer allow list is an override: it can grant a method the node-wide list omits
  assert.equal(authorizeCall(cfg, { peer: 'auditor', method: 'sessions.read' }).ok, true);
  // peers without a policy fall back to the node-wide list
  assert.equal(authorizeCall(cfg, { peer: 'stranger', method: 'workspaces.list' }).ok, true);
  assert.deepEqual(authorizeCall(cfg, { peer: 'stranger', method: 'sessions.create' }), { ok: false, reason: 'method_not_allowed' });
});

test('authorizeCall: unknown methods are refused even for a trusted peer', () => {
  const cfg = normalizeCapabilityConfig({ enabled: true, peers: { laptop: { allow: ['workspaces.list'] } } });
  assert.deepEqual(authorizeCall(cfg, { peer: 'laptop', method: 'dsh.shell' }), { ok: false, reason: 'unknown_method' });
  assert.deepEqual(authorizeCall(cfg, { peer: 'laptop', method: undefined }), { ok: false, reason: 'unknown_method' });
  assert.deepEqual(authorizeCall(cfg, { peer: 'laptop', method: 'Workspaces.List' }), { ok: false, reason: 'unknown_method' });
  // a peer policy cannot smuggle in a method that is not in the catalogue
  const sneaky = normalizeCapabilityConfig({
    enabled: true,
    methods: ['workspaces.list'],
    peers: { laptop: { allow: ['workspaces.list', 'dsh.shell', 'sessions.prompt'] } }
  });
  assert.deepEqual(sneaky.peers.laptop.allow, ['workspaces.list', 'sessions.prompt']);
});

test('queue: enqueue -> claim -> complete -> wait', async (t) => {
  const dir = await tmpDir(t, 'queue-basic');
  const q = createCommandQueue({ dir, cfg: enabledCfg(), logger: quiet });
  t.after(() => q.close());

  const cmd = await q.enqueue({ method: 'sessions.list', params: { workspace: 'dsh-link' }, origin: { peer: 'laptop', ip: '10.0.0.7' } });
  assert.match(cmd.id, /^cmd_[a-z0-9]+$/);
  assert.equal(cmd.status, 'pending');
  assert.equal(cmd.attempts, 0);
  assert.equal(cmd.claimedBy, null);
  assert.deepEqual(cmd.origin, { peer: 'laptop', ip: '10.0.0.7', label: null });
  assert.ok(!Number.isNaN(Date.parse(cmd.createdAt)));

  // <dir>/<id>.json is the documented on-disk layout
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, cmd.id + '.json'), 'utf8'));
  assert.equal(onDisk.method, 'sessions.list');
  assert.deepEqual(onDisk.params, { workspace: 'dsh-link' });

  const [claimed] = await q.claim({ bridge: 'bridge-a' });
  assert.equal(claimed.id, cmd.id);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimedBy, 'bridge-a');
  assert.equal(claimed.attempts, 1);
  assert.ok(!Number.isNaN(Date.parse(claimed.claimedAt)));
  await fs.access(path.join(dir, cmd.id + '.claim'));
  assert.deepEqual(await q.claim({ bridge: 'bridge-b' }), [], 'a claimed command must not be handed out twice');

  const done = await q.complete(cmd.id, { ok: true, result: { sessions: [{ id: 's1' }] } });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { sessions: [{ id: 's1' }] });
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
  await assert.rejects(() => fs.access(path.join(dir, cmd.id + '.claim')), /ENOENT/);

  const waited = await q.wait(cmd.id, 1000);
  assert.equal(waited.status, 'done');
  assert.deepEqual(waited.result, done.result);
  assert.deepEqual(await q.get(cmd.id), done);
  assert.equal(await q.get('cmd_nope'), null);
  assert.deepEqual(await q.stats(), { pending: 0, claimed: 0, done: 1, failed: 0, expired: 0, oldestPendingAt: null });
});

test('queue: wait returns null when nothing ever completes the command', async (t) => {
  const dir = await tmpDir(t, 'queue-timeout');
  const q = createCommandQueue({ dir, cfg: enabledCfg(), logger: quiet });
  t.after(() => q.close());

  const cmd = await q.enqueue({ method: 'bridge.status', params: {}, origin: { peer: 'laptop' } });
  const started = Date.now();
  const waited = await q.wait(cmd.id, 300);
  const elapsed = Date.now() - started;
  assert.equal(waited, null);
  assert.ok(elapsed >= 250, 'wait must keep polling until the deadline, got ' + elapsed + 'ms');
  assert.ok(elapsed < 5000);
  assert.equal((await q.get(cmd.id)).status, 'pending', 'a timeout must not touch the command');
  assert.equal(await q.wait('cmd_missing', 50), null);
  assert.equal(await q.wait('../escape', 50), null);
});

test('queue: two bridges racing for the same commands -- exactly one wins each', async (t) => {
  const dir = await tmpDir(t, 'queue-race');
  const cfg = enabledCfg();
  const a = createCommandQueue({ dir, cfg, logger: quiet });
  const b = createCommandQueue({ dir, cfg, logger: quiet });
  t.after(() => { a.close(); b.close(); });

  const queued = [];
  for (let i = 0; i < 5; i += 1) {
    queued.push(await a.enqueue({ method: 'sessions.list', params: { i }, origin: { peer: 'laptop' } }));
  }

  const [fromA, fromB] = await Promise.all([
    a.claim({ bridge: 'bridge-a', limit: 5 }),
    b.claim({ bridge: 'bridge-b', limit: 5 })
  ]);
  const won = [...fromA.map((c) => ['bridge-a', c]), ...fromB.map((c) => ['bridge-b', c])];
  assert.equal(won.length, 5, 'every command must be claimed exactly once');
  assert.equal(new Set(won.map(([, c]) => c.id)).size, 5, 'no command may be claimed twice');
  assert.deepEqual(new Set(won.map(([, c]) => c.id)), new Set(queued.map((c) => c.id)));
  for (const [bridge, cmd] of won) {
    assert.equal(cmd.claimedBy, bridge);
    assert.equal(cmd.attempts, 1);
    const lock = JSON.parse(await fs.readFile(path.join(dir, cmd.id + '.claim'), 'utf8'));
    assert.equal(lock.bridge, bridge, 'the claim file must name the winner');
  }
  assert.equal((await a.stats()).claimed, 5);
});

test('queue: a bridge that died mid-claim is superseded by the next bridge', async (t) => {
  const dir = await tmpDir(t, 'queue-stale');
  const cfg = enabledCfg({ claimStaleSeconds: 1 });
  const dead = createCommandQueue({ dir, cfg, logger: quiet });
  const alive = createCommandQueue({ dir, cfg, logger: quiet });
  t.after(() => { dead.close(); alive.close(); });

  const cmd = await dead.enqueue({ method: 'sessions.list', params: {}, origin: { peer: 'laptop' } });
  const [taken] = await dead.claim({ bridge: 'bridge-dead' });
  assert.equal(taken.claimedBy, 'bridge-dead');
  assert.deepEqual(await alive.claim({ bridge: 'bridge-alive' }), [], 'a live lease must not be stolen');

  const claimFile = path.join(dir, cmd.id + '.claim');
  const past = new Date(Date.now() - 5000);
  await fs.utimes(claimFile, past, past);
  const [superseded] = await alive.claim({ bridge: 'bridge-alive' });
  assert.equal(superseded.id, cmd.id);
  assert.equal(superseded.claimedBy, 'bridge-alive');
  assert.equal(superseded.attempts, 2);
  assert.equal(JSON.parse(await fs.readFile(claimFile, 'utf8')).bridge, 'bridge-alive');
  assert.equal((await alive.complete(cmd.id, { ok: true, result: { ok: true } })).status, 'done');
});

test('queue: maxPending refuses new work with a 429 LinkError', async (t) => {
  const dir = await tmpDir(t, 'queue-full');
  const q = createCommandQueue({ dir, cfg: enabledCfg({ maxPending: 2 }), logger: quiet });
  t.after(() => q.close());
  const origin = { peer: 'laptop' };

  const first = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  await sleep(5);
  await q.enqueue({ method: 'sessions.list', params: {}, origin });
  await assert.rejects(
    () => q.enqueue({ method: 'sessions.list', params: {}, origin }),
    (err) => err instanceof LinkError && err.status === 429 && err.code === 'too_many_commands' && /2 >= 2/.test(err.message)
  );
  assert.equal((await q.stats()).oldestPendingAt, first.createdAt);

  // claimed work still occupies the queue
  const [claimed] = await q.claim({ bridge: 'bridge-a' });
  assert.equal(claimed.id, first.id);
  await assert.rejects(() => q.enqueue({ method: 'sessions.list', params: {}, origin }), (err) => err.code === 'too_many_commands');

  // finishing one frees the slot (the second command is still claimed, so it still holds one)
  await q.complete(first.id, { ok: true, result: { ok: 1 } });
  const replacement = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  const stats = await q.stats();
  assert.deepEqual(
    { pending: stats.pending, claimed: stats.claimed, done: stats.done },
    { pending: 1, claimed: 1, done: 1 }
  );
  assert.equal(stats.oldestPendingAt, replacement.createdAt);
  await assert.rejects(() => q.enqueue({ method: 'sessions.list', params: {}, origin }),
    (err) => err.code === 'too_many_commands', 'the queue is full again');
});

test('queue: enqueue enforces the same policy as authorizeCall', async (t) => {
  const root = await tmpDir(t, 'queue-policy');
  const off = createCommandQueue({ dir: path.join(root, 'off'), cfg: { methods: ['sessions.list'] }, logger: quiet });
  const on = createCommandQueue({ dir: path.join(root, 'on'), cfg: enabledCfg(), logger: quiet });
  const scoped = createCommandQueue({ dir: path.join(root, 'scoped'), cfg: enabledCfg({ peers: { laptop: { deny: ['sessions.read'] } } }), logger: quiet });
  t.after(() => { off.close(); on.close(); scoped.close(); });
  const origin = { peer: 'laptop' };

  await assert.rejects(() => off.enqueue({ method: 'sessions.list', params: {}, origin }),
    (err) => err instanceof LinkError && err.status === 403 && err.code === 'capabilities_disabled');
  await assert.rejects(() => on.enqueue({ method: 'sessions.prompt', params: {}, origin }),
    (err) => err instanceof LinkError && err.status === 403 && err.code === 'method_not_allowed');
  await assert.rejects(() => scoped.enqueue({ method: 'sessions.read', params: {}, origin }),
    (err) => err instanceof LinkError && err.status === 403 && err.code === 'peer_denied');
  await assert.rejects(() => scoped.enqueue({ method: 'dsh.shell', params: {}, origin }),
    (err) => err instanceof LinkError && err.status === 404 && err.code === 'unknown_method');

  const circular = {};
  circular.self = circular;
  await assert.rejects(() => on.enqueue({ method: 'sessions.list', params: circular, origin }),
    (err) => err instanceof LinkError && err.status === 400 && err.code === 'bad_request');

  assert.ok((await scoped.enqueue({ method: 'sessions.read', params: {}, origin: { peer: 'desktop' } })).id);
  assert.equal((await scoped.stats()).pending, 1, 'refused calls must not reach the queue');
  assert.equal((await on.stats()).pending, 0);

  // setConfig swaps the policy for later calls (the node reloads its config in place)
  off.setConfig({ enabled: true, methods: ['sessions.list'] });
  assert.ok((await off.enqueue({ method: 'sessions.list', params: {}, origin })).id);
  assert.equal(off.config().enabled, true);
});

test('queue: an untouched queue answers instead of throwing', async (t) => {
  const root = await tmpDir(t, 'queue-empty');
  const q = createCommandQueue({ dir: path.join(root, 'not-created-yet'), cfg: enabledCfg(), logger: quiet });
  t.after(() => q.close());

  assert.deepEqual(await q.sweep(), 0);
  assert.deepEqual(await q.stats(), { pending: 0, claimed: 0, done: 0, failed: 0, expired: 0, oldestPendingAt: null });
  assert.deepEqual(await q.claim({ bridge: 'bridge-a' }), []);
  assert.equal(await q.get('cmd_x'), null);
  assert.equal(await q.wait('cmd_x', 50), null);
  await assert.rejects(() => q.complete('cmd_x', { ok: true, result: {} }), (err) => err instanceof LinkError && err.status === 404);

  // a missing dir is a usage error, not a crash deep inside a request
  assert.throws(() => createCommandQueue({}), (err) => err instanceof LinkError && err.status === 2 && err.code === 'usage');
  assert.throws(() => createBridgePresence({}), (err) => err instanceof LinkError && err.status === 2 && err.code === 'usage');
});

test('queue: sweep expires commands nobody finished', async (t) => {
  const dir = await tmpDir(t, 'queue-sweep');
  const q = createCommandQueue({ dir, cfg: enabledCfg(), logger: quiet });
  t.after(() => q.close());
  const origin = { peer: 'laptop' };

  const pending = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  await sleep(5);
  const working = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  await sleep(5);
  const fresh = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  const claimed = await q.claim({ bridge: 'bridge-a', limit: 2 });
  assert.deepEqual(claimed.map((c) => c.id), [pending.id, working.id], 'claim drains oldest first');

  await backdateCommand(dir, pending.id, 10 * 60 * 1000);
  await backdateCommand(dir, working.id, 10 * 60 * 1000);
  assert.equal(await q.sweep(), 2);
  assert.equal(await q.sweep(), 0, 'sweep must not re-expire terminal commands');

  assert.equal((await q.get(pending.id)).status, 'expired');
  assert.equal((await q.get(pending.id)).error, 'expired');
  assert.equal((await q.get(working.id)).status, 'expired');
  assert.equal((await q.get(fresh.id)).status, 'pending');
  await assert.rejects(() => fs.access(path.join(dir, working.id + '.claim')), /ENOENT/);

  const stats = await q.stats();
  assert.deepEqual(stats, { pending: 1, claimed: 0, done: 0, failed: 0, expired: 2, oldestPendingAt: fresh.createdAt });
  assert.equal((await q.wait(pending.id, 200)).status, 'expired', 'an expired command is terminal');
  const [survivor] = await q.claim({ bridge: 'bridge-b' });
  assert.equal(survivor.id, fresh.id, 'the command that is still young stays claimable');
});

test('queue: an oversized result is clipped and marked truncated', async (t) => {
  const dir = await tmpDir(t, 'queue-truncate');
  const q = createCommandQueue({ dir, cfg: enabledCfg({ maxResultBytes: 512 }), logger: quiet });
  t.after(() => q.close());
  const origin = { peer: 'laptop' };

  const small = await q.enqueue({ method: 'sessions.list', params: {}, origin });
  await q.claim({ bridge: 'bridge-a' });
  const kept = await q.complete(small.id, { ok: true, result: { sessions: 3 } });
  assert.deepEqual(kept.result, { sessions: 3 }, 'a small result must be stored untouched');
  assert.equal(kept.result.truncated, undefined);

  const big = await q.enqueue({ method: 'sessions.read', params: {}, origin });
  await q.claim({ bridge: 'bridge-a' });
  const huge = { transcript: 'x'.repeat(4000) };
  const clipped = await q.complete(big.id, { ok: true, result: huge });
  assert.equal(clipped.status, 'done');
  assert.equal(clipped.result.truncated, true);
  assert.equal(clipped.result.originalBytes, Buffer.byteLength(JSON.stringify(huge), 'utf8'));
  assert.ok(clipped.result.originalBytes > 512);
  assert.ok(clipped.result.preview.length > 0);
  assert.equal(clipped.result.preview.includes('x'.repeat(4000)), false);
  assert.ok(Buffer.byteLength(JSON.stringify(clipped.result), 'utf8') <= 512);
  assert.deepEqual((await q.get(big.id)).result, clipped.result, 'the clipped result is what lands on disk');
  assert.equal((await q.wait(big.id, 200)).result.truncated, true);
});

test('queue: failures settle once and late retries cannot rewrite them', async (t) => {
  const dir = await tmpDir(t, 'queue-failed');
  const q = createCommandQueue({ dir, cfg: enabledCfg({ methods: [...CAPABILITY_DEFAULTS.methods, 'sessions.create'] }), logger: quiet });
  t.after(() => q.close());

  const cmd = await q.enqueue({ method: 'sessions.create', params: { workspace: 'w' }, origin: { peer: 'laptop' } });
  await q.claim({ bridge: 'bridge-a' });
  const failed = await q.complete(cmd.id, { ok: false, error: new Error('DSH refused to create the session') });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'DSH refused to create the session');
  assert.equal(failed.result, null);
  assert.ok(!Number.isNaN(Date.parse(failed.finishedAt)));

  const again = await q.complete(cmd.id, { ok: true, result: { late: true } });
  assert.deepEqual(again, failed, 'a terminal command is immutable');
  assert.equal((await q.stats()).failed, 1);

  await assert.rejects(() => q.complete('cmd_missing', { ok: true, result: {} }),
    (err) => err instanceof LinkError && err.status === 404 && err.code === 'not_found');
  await assert.rejects(() => q.complete('../escape', { ok: true }),
    (err) => err instanceof LinkError && err.status === 400 && err.code === 'bad_request');
});

test('queue: close() releases waiters instead of stranding them', async (t) => {
  const dir = await tmpDir(t, 'queue-close');
  const q = createCommandQueue({ dir, cfg: enabledCfg(), logger: quiet });
  const cmd = await q.enqueue({ method: 'sessions.list', params: {}, origin: { peer: 'laptop' } });
  const waiting = q.wait(cmd.id, 30000);
  const stopper = setTimeout(() => q.close(), 50);
  t.after(() => clearTimeout(stopper));
  assert.equal(await waiting, null);
});

test('presence: beat / read / staleness', async (t) => {
  const dir = await tmpDir(t, 'presence');
  const p = createBridgePresence({ dir, logger: quiet });
  assert.equal(await p.read(), null);
  assert.deepEqual(await p.staleness(), { fresh: false, ageMs: null });
  assert.equal(path.basename(p.path), 'bridge.json');

  const beaten = await p.beat({
    node: 'laptop',
    version: '0.2.3',
    capabilities: ['sessions.prompt', 'sessions.prompt', 7, 'workspaces.list'],
    sessions: 4
  });
  assert.equal(beaten.node, 'laptop');
  assert.equal(beaten.version, '0.2.3');
  assert.deepEqual(beaten.capabilities, ['sessions.prompt', 'workspaces.list']);
  assert.equal(beaten.sessions, 4);
  assert.ok(!Number.isNaN(Date.parse(beaten.at)));
  assert.deepEqual(await p.read(), beaten);

  const fresh = await p.staleness(60000);
  assert.equal(fresh.fresh, true);
  assert.ok(fresh.ageMs >= 0 && fresh.ageMs < 60000);

  // age the beat itself, then look again
  const file = path.join(dir, 'bridge.json');
  const aged = JSON.parse(await fs.readFile(file, 'utf8'));
  aged.at = new Date(Date.now() - 120000).toISOString();
  await fs.writeFile(file, JSON.stringify(aged), 'utf8');
  const old = await p.staleness(60000);
  assert.equal(old.fresh, false);
  assert.ok(old.ageMs >= 60000);

  // a bridge that does not declare capabilities is reported as whatever the node allows
  const fallback = createBridgePresence({ dir: path.join(dir, 'node-a'), cfg: { enabled: true, methods: ['sessions.list', 'bridge.status'] } });
  assert.deepEqual((await fallback.beat({ node: 'node-a' })).capabilities, ['sessions.list', 'bridge.status']);
  const silent = createBridgePresence({ dir: path.join(dir, 'node-b'), cfg: {} });
  const silentBeat = await silent.beat({});
  assert.deepEqual(silentBeat.capabilities, []);
  assert.equal(silentBeat.node, null);
  assert.equal(silentBeat.sessions, null);

  // a torn presence file reads as "no bridge at all"
  await fs.writeFile(file, '{ not json', 'utf8');
  assert.equal(await p.read(), null);
  assert.deepEqual(await p.staleness(1000), { fresh: false, ageMs: null });
  assert.equal((await p.beat({ node: 'laptop', sessions: '9' })).sessions, 9, 'beat repairs a torn file');
});

test('capabilities: a queue and a presence can share one dir', async (t) => {
  const dir = await tmpDir(t, 'shared-dir');
  const q = createCommandQueue({ dir, cfg: enabledCfg(), logger: quiet });
  const p = createBridgePresence({ dir, logger: quiet });
  t.after(() => q.close());

  await p.beat({ node: 'laptop', capabilities: ['sessions.list'] });
  const cmd = await q.enqueue({ method: 'sessions.list', params: {}, origin: { peer: 'laptop' } });
  assert.equal((await q.stats()).pending, 1, 'bridge.json must not be counted as a command');
  const [claimed] = await q.claim({ bridge: 'bridge-a' });
  assert.equal(claimed.id, cmd.id);
  assert.equal((await p.read()).node, 'laptop', 'the queue must not clobber the presence file');
});
