import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  TOPIC_DEFAULTS,
  normalizeTopicPolicy,
  normalizeSubject,
  topicKeyFor,
  topicLabel,
  planSession,
  recordUse,
  sweepPool,
  poolSummary
} from '../integrations/dsh-link-bridge/lib/topics.js';

const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// Private scratch dir: test/.tmp/unit is shared with the other suites running in parallel.
const TMP = path.join(PROJECT_DIR, 'test', '.tmp', 'sa3-' + process.pid);

/** Fixed clock: these functions take the time as a value, so no test depends on the wall clock. */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const poolEntry = (over = {}) => ({
  sessionId: 's1',
  wakes: 0,
  createdAt: T0,
  lastUsedAt: T0,
  label: 'LAPTOP: a',
  archived: false,
  ...over
});

const message = (over = {}) => ({
  id: 'msg_01',
  from: { name: 'LAPTOP' },
  subject: 'hello',
  body: 'first line\nsecond line',
  ...over
});

// A policy that trips every branch quickly while keeping the numbers readable.
const POLICY = () => normalizeTopicPolicy({
  maxSessionWakes: 2,
  maxSessionAgeSeconds: 100,
  topicIdleResetSeconds: 50,
  archiveIdleSeconds: 100,
  maxPoolSize: 5
});

test('topics: the exported defaults are the documented contract', () => {
  assert.deepEqual(TOPIC_DEFAULTS, {
    strategy: 'auto',
    maxSessionWakes: 12,
    maxSessionAgeSeconds: 43200,
    topicIdleResetSeconds: 21600,
    archiveIdleSeconds: 86400,
    maxPoolSize: 20
  });
  assert.deepEqual(normalizeTopicPolicy(), TOPIC_DEFAULTS);
  assert.deepEqual(normalizeTopicPolicy(TOPIC_DEFAULTS), TOPIC_DEFAULTS, 'normalizing is idempotent');
  assert.deepEqual(normalizeTopicPolicy(null), TOPIC_DEFAULTS);
  assert.deepEqual(normalizeTopicPolicy('nope'), TOPIC_DEFAULTS);

  assert.deepEqual(
    normalizeTopicPolicy({
      strategy: 'Subject',
      maxSessionWakes: 3.7,
      maxSessionAgeSeconds: 10,
      topicIdleResetSeconds: 0,
      archiveIdleSeconds: '60',
      maxPoolSize: '5'
    }),
    {
      strategy: 'subject',
      maxSessionWakes: 3,
      maxSessionAgeSeconds: 10,
      topicIdleResetSeconds: 0,
      archiveIdleSeconds: 60,
      maxPoolSize: 5
    },
    'counts are floored, numeric strings are accepted, 0 stays meaningful'
  );

  const repaired = normalizeTopicPolicy({ strategy: 'nope', maxSessionWakes: -3, maxPoolSize: NaN, topicIdleResetSeconds: 'soon' });
  assert.deepEqual(repaired, TOPIC_DEFAULTS, 'malformed values fall back instead of throwing');
});

test('topics: normalizeSubject peels reply/forward prefixes', () => {
  assert.equal(normalizeSubject('Re: Re: 你好'), '你好');
  assert.equal(normalizeSubject('RE: 你好'), '你好');
  assert.equal(normalizeSubject('答复：x'), 'x');
  assert.equal(normalizeSubject('回复: x'), 'x');
  assert.equal(normalizeSubject('回覆：x'), 'x');
  assert.equal(normalizeSubject('Fwd: y'), 'y');
  assert.equal(normalizeSubject('Fw: y'), 'y');
  assert.equal(normalizeSubject('Re[2]: z'), 'z');
  assert.equal(normalizeSubject('re(2): q'), 'q');
  assert.equal(normalizeSubject('Re 2: q'), 'q');
  assert.equal(normalizeSubject('转发：报告'), '报告');
  assert.equal(normalizeSubject('Re: Fwd: 回复：deep'), 'deep');
  assert.equal(normalizeSubject('   Re:   spaced  '), 'spaced');

  // A word that merely starts with a marker is not a prefix.
  assert.equal(normalizeSubject('Re: reply: keep'), 'reply: keep');
  assert.equal(normalizeSubject('Read: this'), 'Read: this');
  assert.equal(normalizeSubject('hello'), 'hello');

  // Empty and unusable values are '', never a throw.
  assert.equal(normalizeSubject(''), '');
  assert.equal(normalizeSubject('   '), '');
  assert.equal(normalizeSubject('Re:'), '');
  assert.equal(normalizeSubject('Re:   '), '');
  assert.equal(normalizeSubject(null), '');
  assert.equal(normalizeSubject(undefined), '');
  assert.equal(normalizeSubject({}), '');
  assert.equal(normalizeSubject([]), '');
  assert.equal(normalizeSubject(42), '42', 'a number is still text');
});

test('topics: one Re: chain is one topic key', () => {
  const policy = normalizeTopicPolicy({});
  const root = topicKeyFor(message({ id: 'm1', subject: '构建失败' }), policy);
  assert.equal(root, 'topic:LAPTOP/构建失败');
  assert.equal(topicKeyFor(message({ id: 'm2', subject: 'Re: 构建失败' }), policy), root);
  assert.equal(topicKeyFor(message({ id: 'm3', subject: 'Re[2]: Re: 构建失败' }), policy), root);
  assert.equal(topicKeyFor(message({ id: 'm4', subject: '  Fwd: 构建失败  ' }), policy), root, 'trim + prefix stripping normalize incoming subjects');
  assert.notEqual(topicKeyFor(message({ id: 'm5', subject: '另一个话题' }), policy), root);
  assert.notEqual(topicKeyFor(message({ id: 'm6', from: { name: 'OTHER' }, subject: '构建失败' }), policy), root, 'the peer is part of the key');
});

test('topics: topicKeyFor follows the strategy setting', () => {
  const auto = normalizeTopicPolicy({});
  const threaded = message({ id: 'm1', thread: 'tr-1', subject: '构建失败' });
  assert.equal(topicKeyFor(threaded, auto), 'thread:tr-1');
  assert.equal(topicKeyFor(message({ id: 'm2', thread: 'tr-1', subject: 'Re: 构建失败' }), auto), 'thread:tr-1');
  assert.equal(topicKeyFor(message({ id: 'm3', subject: '构建失败' }), auto), 'topic:LAPTOP/构建失败');
  assert.equal(topicKeyFor(message({ id: 'm4', subject: '', body: 'x' }), auto), 'msg:m4', 'no thread and no subject: one session per message');

  const bySubject = normalizeTopicPolicy({ strategy: 'subject' });
  assert.equal(topicKeyFor(threaded, bySubject), 'topic:LAPTOP/构建失败', 'the subject strategy ignores threads');
  assert.equal(topicKeyFor(message({ id: 'm5', subject: '', body: 'x' }), bySubject), 'msg:m5');

  const byThread = normalizeTopicPolicy({ strategy: 'thread' });
  assert.equal(topicKeyFor(threaded, byThread), 'thread:tr-1');
  assert.equal(topicKeyFor(message({ id: 'm6', subject: 'Re: 构建失败' }), byThread), 'topic:LAPTOP/构建失败', 'no thread: fall back to the subject');
  assert.equal(topicKeyFor(message({ id: 'm7', subject: '', body: 'x' }), byThread), 'msg:m7');

  assert.equal(topicKeyFor(null, null), 'msg:unknown');
  assert.equal(topicKeyFor(message({ id: 'm8', from: 'PLAIN-PEER', subject: 'hi' }), auto), 'topic:PLAIN-PEER/hi');

  // A pathological "subject" is bounded so one message cannot bloat state.json.
  const huge = topicKeyFor(message({ id: 'm9', subject: 'x'.repeat(500) }), auto);
  assert.equal(huge, 'topic:LAPTOP/' + 'x'.repeat(120));
});

test('topics: planSession reuses a healthy session and explains every rotation', () => {
  const policy = POLICY();
  const key = 'topic:LAPTOP/a';
  const call = (entryOver, extra = {}) => planSession({
    pool: entryOver === null ? {} : { [key]: poolEntry(entryOver) },
    key,
    label: 'LAPTOP: a',
    now: T0,
    policy,
    ...extra
  });

  assert.deepEqual(call(null), {
    action: 'create', sessionId: null, reason: 'new-topic', archive: [], entry: null
  });

  const healthy = poolEntry({ lastUsedAt: T0 - 1000, createdAt: T0 - 1000 });
  const reused = planSession({ pool: { [key]: healthy }, key, label: 'LAPTOP: a', now: T0, policy });
  assert.deepEqual(reused, { action: 'reuse', sessionId: 's1', reason: 'reuse', archive: [], entry: healthy });

  assert.deepEqual(call({ archived: true }), {
    action: 'create', sessionId: null, reason: 'archived', archive: [], entry: poolEntry({ archived: true })
  });
  assert.equal(call({ sessionId: '' }).reason, 'missing');
  assert.equal(call({}).reason, 'reuse', 'an unknown probe means the session is still there');
  assert.equal(call({}, { exists: () => true }).reason, 'reuse');
  assert.equal(call({}, { exists: () => undefined }).reason, 'reuse');
  assert.equal(call({}, { exists: () => false }).reason, 'missing');
  assert.equal(call({}, { exists: (id) => id !== 's1' }).reason, 'missing');

  // The three rotation reasons, each naming the session to archive.
  const idle = call({ lastUsedAt: T0 - 51_000, createdAt: T0 - 60_000 });
  assert.equal(idle.action, 'create');
  assert.equal(idle.sessionId, null);
  assert.equal(idle.reason, 'idle-reset');
  assert.deepEqual(idle.archive, [{ key, sessionId: 's1', reason: 'idle-reset' }]);

  const budget = call({ wakes: 2, lastUsedAt: T0 - 1000 });
  assert.equal(budget.reason, 'wake-budget');
  assert.deepEqual(budget.action, 'create');
  assert.deepEqual(budget.archive, [{ key, sessionId: 's1', reason: 'wake-budget' }]);

  const aged = call({ createdAt: T0 - 101_000, lastUsedAt: T0 - 1000 });
  assert.equal(aged.reason, 'session-age');
  assert.deepEqual(aged.archive, [{ key, sessionId: 's1', reason: 'session-age' }]);

  // Precedence is fixed: idle first, then the wake budget, then the age of the session.
  assert.equal(call({ lastUsedAt: T0 - 999_000, createdAt: T0 - 999_000, wakes: 99 }).reason, 'idle-reset');
  assert.equal(call({ lastUsedAt: T0 - 1000, createdAt: T0 - 999_000, wakes: 99 }).reason, 'wake-budget');
  assert.equal(call({ lastUsedAt: T0 - 51_000, createdAt: T0 - 999_000, wakes: 0 }).reason, 'idle-reset');

  // Boundaries: idle and age rotate only past the window, the wake budget rotates on the cap.
  assert.equal(call({ lastUsedAt: T0 - 50_000, createdAt: T0 - 50_000 }).reason, 'reuse');
  assert.equal(call({ lastUsedAt: T0 - 1000, createdAt: T0 - 100_000 }).reason, 'reuse');
  assert.equal(call({ lastUsedAt: T0 - 1000, wakes: 1 }).reason, 'reuse');
  assert.equal(call({ lastUsedAt: T0 - 1000, wakes: 2 }).reason, 'wake-budget');

  // planning never writes to the pool.
  const pool = { [key]: poolEntry({ lastUsedAt: T0 - 51_000 }) };
  const before = JSON.parse(JSON.stringify(pool));
  planSession({ pool, key, now: T0, policy });
  assert.deepEqual(pool, before);
});

test('topics: recordUse keeps a per-session budget and resets it on rotation', () => {
  const pool = {};
  const key = 'topic:LAPTOP/a';

  const first = recordUse(pool, key, { sessionId: 's1', label: 'LAPTOP: a', now: T0, messages: 3 });
  assert.deepEqual(first, { sessionId: 's1', wakes: 3, createdAt: T0, lastUsedAt: T0, label: 'LAPTOP: a', archived: false });
  assert.equal(pool[key], first, 'the entry is stored in the pool');

  const more = recordUse(pool, key, { sessionId: 's1', label: 'LAPTOP: a', now: T0 + 1000, messages: 2 });
  assert.equal(pool[key], more, 'the returned entry is the one the pool holds');
  assert.notEqual(more, first, 'each call stores a fresh canonical entry');
  assert.equal(more.wakes, 5);
  assert.equal(more.createdAt, T0, 'the session clock does not move while the same session is in use');
  assert.equal(more.lastUsedAt, T0 + 1000);
  assert.equal(recordUse(pool, key, { sessionId: 's1', label: 'LAPTOP: a', now: T0 + 2000 }).wakes, 6, 'messages defaults to 1');

  const rotated = recordUse(pool, key, { sessionId: 's2', label: 'LAPTOP: a', now: T0 + 3000 });
  assert.equal(rotated.wakes, 1, 'a new session starts with a fresh budget');
  assert.equal(rotated.createdAt, T0 + 3000);
  assert.equal(rotated.lastUsedAt, T0 + 3000);

  // Recording a use revives an archived topic and drops the archive bookkeeping.
  pool[key].archived = true;
  pool[key].archivedAt = T0;
  const revived = recordUse(pool, key, { sessionId: 's2', label: 'LAPTOP: a', now: T0 + 4000 });
  assert.equal(revived.archived, false);
  assert.equal('archivedAt' in revived, false);
  assert.equal(revived.wakes, 2);

  // A label is optional and an older one is inherited.
  const relabelled = recordUse(pool, key, { sessionId: 's2', now: T0 + 5000 });
  assert.equal(relabelled.label, 'LAPTOP: a');
  assert.equal(recordUse(pool, key, { sessionId: 's3', now: T0 + 6000 }).label, 'LAPTOP: a', 'a rotation without a label keeps the topic label');

  // A pool that cannot hold the entry still yields the entry to the caller.
  assert.equal(recordUse(null, key, { sessionId: 's9', now: T0 }).sessionId, 's9');
  assert.doesNotThrow(() => recordUse('nope', key, { sessionId: 's9', now: T0 }));
});

test('topics: poolSummary is a small JSON-safe snapshot for state.json', async (t) => {
  const pool = {};
  recordUse(pool, 'topic:A/x', { sessionId: 's1', label: 'A: x', now: T0, messages: 2 });
  recordUse(pool, 'thread:t2', { sessionId: 's2', label: 'A: y', now: T0 + 10 });

  const summary = poolSummary(pool);
  assert.deepEqual(Object.keys(summary), ['topic:A/x', 'thread:t2']);
  assert.deepEqual(summary['topic:A/x'], {
    sessionId: 's1', wakes: 2, createdAt: T0, lastUsedAt: T0, label: 'A: x', archived: false
  });
  assert.deepEqual(summary['thread:t2'], {
    sessionId: 's2', wakes: 1, createdAt: T0 + 10, lastUsedAt: T0 + 10, label: 'A: y', archived: false
  });

  // The summary is what the bridge writes to state.json, so it must survive a round trip.
  await fs.mkdir(TMP, { recursive: true });
  t.after(async () => { await fs.rm(TMP, { recursive: true, force: true }).catch(() => {}); });
  const file = path.join(TMP, 'state.json');
  await fs.writeFile(file, JSON.stringify({ topics: summary }, null, 2) + '\n', 'utf8');
  const back = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(back.topics, summary);
  assert.deepEqual(poolSummary(back.topics), summary);

  assert.deepEqual(poolSummary(null), {});
  assert.deepEqual(poolSummary('nope'), {});
  assert.deepEqual(poolSummary({ k: 5 }), {}, 'a malformed entry is skipped');
  assert.deepEqual(poolSummary({ k: { sessionId: 7, wakes: -2 } }), {
    k: { sessionId: '7', wakes: 0, createdAt: 0, lastUsedAt: 0, label: '', archived: false }
  });
});

test('topics: sweepPool archives idle topics and forgets old ones', () => {
  const policy = normalizeTopicPolicy({ archiveIdleSeconds: 100, maxPoolSize: 20 });
  const now = T0;
  const pool = {
    old: poolEntry({ sessionId: 's-old', lastUsedAt: now - 200_000, createdAt: now - 900_000 }),
    fresh: poolEntry({ sessionId: 's-fresh', lastUsedAt: now, createdAt: now }),
    live: poolEntry({ sessionId: 's-live', lastUsedAt: now - 1000, createdAt: now - 10_000 })
  };

  const first = sweepPool({ pool, now, policy });
  assert.deepEqual(first.archive, [{ key: 'old', sessionId: 's-old', reason: 'archive-idle' }]);
  assert.deepEqual(first.drop, [], 'nothing is forgotten in the same sweep it was archived');
  assert.equal(pool.old.archived, true);
  assert.equal(pool.old.archivedAt, now);
  assert.equal(pool.old.sessionId, 's-old', 'the session id is kept so the next message knows what to replace');
  assert.equal(pool.fresh.archived, false, 'a topic used at exactly now stays untouched');
  assert.equal(pool.live.archived, false);

  // A topic on an archived key is a fresh session, not a reuse.
  assert.equal(planSession({ pool, key: 'old', now, policy }).reason, 'archived');

  // Two archive windows later the entry is forgotten; the once-live topic is archived in passing.
  const later = now + 200_000;
  const second = sweepPool({ pool, now: later, policy });
  assert.deepEqual(second.drop, ['old'], 'the entry archived two windows ago is forgotten');
  assert.deepEqual(second.archive, [
    { key: 'fresh', sessionId: 's-fresh', reason: 'archive-idle' },
    { key: 'live', sessionId: 's-live', reason: 'archive-idle' }
  ], 'the topics that went quiet in the meantime are archived now');
  assert.equal('old' in pool, false);
  assert.equal('live' in pool, true);

  // An idle-entry sweep never resurrects an archived one.
  const third = sweepPool({ pool, now: later + 1, policy });
  assert.deepEqual(third.drop, []);
});

test('topics: sweepPool never archives a topic that is in use at now', () => {
  // archiveIdleSeconds 0 is the degenerate "archive everything idle" setting; the in-use guard
  // is the only thing protecting a topic that is literally being used right now.
  const policy = normalizeTopicPolicy({ archiveIdleSeconds: 0, maxPoolSize: 10 });
  const pool = {
    busy: poolEntry({ sessionId: 's-busy', lastUsedAt: T0, createdAt: T0 }),
    idle: poolEntry({ sessionId: 's-idle', lastUsedAt: T0 - 1, createdAt: T0 - 1 })
  };
  const result = sweepPool({ pool, now: T0, policy });
  assert.deepEqual(result.archive, [{ key: 'idle', sessionId: 's-idle', reason: 'archive-idle' }]);
  assert.equal(pool.busy.archived, false);
  assert.deepEqual(result.drop, ['idle'], 'with a zero window a topic is archived and forgotten at once');
  assert.deepEqual(Object.keys(pool), ['busy']);
});

test('topics: sweepPool caps the pool without evicting a topic in use', () => {
  const policy = normalizeTopicPolicy({ archiveIdleSeconds: 86400, maxPoolSize: 2 });
  const now = T0;
  const pool = {
    a: poolEntry({ sessionId: 's-a', lastUsedAt: now - 5000, createdAt: now - 5000 }),
    b: poolEntry({ sessionId: 's-b', lastUsedAt: now - 4000, createdAt: now - 4000 }),
    busy: poolEntry({ sessionId: 's-busy', lastUsedAt: now, createdAt: now }),
    c: poolEntry({ sessionId: 's-c', lastUsedAt: now - 3000, createdAt: now - 3000 })
  };

  const capped = sweepPool({ pool, now, policy });
  assert.deepEqual(capped.drop, ['a', 'b'], 'the oldest keys go first');
  assert.deepEqual(capped.archive, [
    { key: 'a', sessionId: 's-a', reason: 'pool-cap' },
    { key: 'b', sessionId: 's-b', reason: 'pool-cap' }
  ]);
  assert.deepEqual(Object.keys(pool).sort(), ['busy', 'c']);

  // A topic without a session has nothing to archive, but still leaves the pool.
  const pool2 = {
    empty: poolEntry({ sessionId: '', lastUsedAt: now - 9000, createdAt: now - 9000 }),
    keep: poolEntry({ sessionId: 's-keep', lastUsedAt: now - 8000, createdAt: now - 8000 }),
    other: poolEntry({ sessionId: 's-other', lastUsedAt: now - 7000, createdAt: now - 7000 })
  };
  const capped2 = sweepPool({ pool: pool2, now, policy });
  assert.deepEqual(capped2.drop, ['empty']);
  assert.deepEqual(capped2.archive, []);

  // When every topic is in use the cap cannot be met without touching them: leave the pool alone.
  const pool3 = {
    x: poolEntry({ sessionId: 's-x', lastUsedAt: now }),
    y: poolEntry({ sessionId: 's-y', lastUsedAt: now }),
    z: poolEntry({ sessionId: 's-z', lastUsedAt: now })
  };
  const capped3 = sweepPool({ pool: pool3, now, policy: normalizeTopicPolicy({ maxPoolSize: 1, archiveIdleSeconds: 86400 }) });
  assert.deepEqual(capped3.drop, []);
  assert.deepEqual(capped3.archive, []);
  assert.deepEqual(Object.keys(pool3), ['x', 'y', 'z']);
});

test('topics: topicLabel is a short human title with a body fallback', () => {
  assert.equal(topicLabel(message({ subject: 'Re: 构建失败', body: 'ignored' })), 'LAPTOP: 构建失败');
  assert.equal(topicLabel(message({ subject: '答复：x' })), 'LAPTOP: x');
  assert.equal(topicLabel(message({ subject: '', body: '\n  第一行  \n第二行' })), 'LAPTOP: 第一行');
  assert.equal(topicLabel(message({ from: 'PLAIN-PEER', subject: 'hi' })), 'PLAIN-PEER: hi');
  assert.equal(topicLabel(message({ subject: '多\n行 主题' })), 'LAPTOP: 多 行 主题');

  const long = topicLabel(message({ subject: 'x'.repeat(200), body: '' }));
  assert.equal(long, 'LAPTOP: ' + 'x'.repeat(52) + '…');
  assert.equal(long.length, 61, '60 characters plus the ellipsis marker');
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('\n'));

  assert.equal(topicLabel(message({ id: 'msg_9', subject: '', body: '   ' })), 'LAPTOP: msg_9');
  assert.equal(topicLabel(message({ id: '', from: { name: '' }, subject: '', body: '' })), 'untitled');
  assert.equal(topicLabel(null), '');
  assert.equal(topicLabel(42), '');
  assert.equal(topicLabel('nope'), '');
});

test('topics: malformed input degrades instead of throwing', () => {
  assert.doesNotThrow(() => normalizeTopicPolicy(42));
  assert.doesNotThrow(() => normalizeTopicPolicy([]));
  assert.deepEqual(normalizeTopicPolicy([]), TOPIC_DEFAULTS);

  assert.doesNotThrow(() => planSession());
  assert.doesNotThrow(() => planSession({ pool: null, key: null, now: NaN, policy: 'x', exists: 42 }));
  assert.equal(planSession({ pool: null, key: 'k', now: NaN, policy: null }).action, 'create');
  assert.equal(planSession({ pool: 'nope', key: 'k', now: T0 }).reason, 'new-topic');
  assert.equal(planSession({ pool: { k: 'nope' }, key: 'k', now: T0 }).reason, 'new-topic');
  assert.equal(planSession({ pool: { k: null }, key: 'k', now: T0 }).reason, 'new-topic');
  assert.equal(planSession({ pool: { k: [] }, key: 'k', now: T0 }).reason, 'new-topic');
  assert.equal(planSession({ pool: { k: {} }, key: 'k', now: T0 }).reason, 'missing', 'an entry without a session is missing, not brand new');

  // A probe that blows up (or answers with a promise) must not churn the live session.
  const pool = { k: poolEntry({ lastUsedAt: T0, createdAt: T0 }) };
  assert.equal(planSession({ pool, key: 'k', now: T0, exists: () => { throw new Error('boom'); } }).action, 'reuse');
  assert.equal(planSession({ pool, key: 'k', now: T0, exists: () => Promise.resolve(false) }).action, 'reuse');
  assert.equal(planSession({ pool, key: 'k', now: T0, exists: null }).action, 'reuse');

  // Entries with missing or unusable timestamps are treated as freshly used, never as ancient.
  const loose = { k: { sessionId: 's1', wakes: 'x', createdAt: null, lastUsedAt: undefined, archived: false } };
  const decision = planSession({ pool: loose, key: 'k', now: T0 });
  assert.equal(decision.action, 'reuse');
  assert.equal(decision.reason, 'reuse');

  assert.doesNotThrow(() => sweepPool());
  assert.deepEqual(sweepPool({ pool: null, now: T0, policy: {} }), { archive: [], drop: [] });
  assert.deepEqual(sweepPool({ pool: 'nope', now: T0, policy: {} }), { archive: [], drop: [] });
  assert.deepEqual(sweepPool({ pool: { k: 5, j: null }, now: T0, policy: {} }), { archive: [], drop: [] });
  assert.deepEqual(sweepPool({ pool: { k: {} }, now: T0, policy: {} }), { archive: [], drop: [] }, 'an entry without a session is not archived');

  assert.doesNotThrow(() => topicKeyFor(undefined, undefined));
  assert.doesNotThrow(() => topicLabel(undefined));
  assert.doesNotThrow(() => poolSummary(undefined));
  assert.doesNotThrow(() => recordUse(undefined, undefined, undefined));
  assert.doesNotThrow(() => recordUse({}, 'k', { sessionId: 7, now: 'x', messages: NaN }));
  assert.equal(recordUse({}, 'k', { sessionId: 7, now: 'x', messages: NaN }).sessionId, '7');
});
