import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_DEFAULTS, TARGET_SESSION_MAX, authorizeTarget, messagePeer,
  normalizeTargetPolicy, resolveTarget, targetsSummary
} from '../integrations/dsh-link-bridge/lib/targets.js';

const T0 = 1_800_000_000_000;
const message = (extra = {}) => ({
  id: 'msg_target_1', ts: new Date(T0).toISOString(), thread: 'msg_thread_1',
  from: { nodeId: 'node_peer', name: 'LAPTOP-TEST', url: 'http://127.0.0.1:1' },
  to: 'bridge-node', subject: 'hi', body: 'hello', attachments: [], ...extra
});

test('targets: defaults are explicit-by-default and open unless stated otherwise', () => {
  assert.deepEqual(normalizeTargetPolicy(), TARGET_DEFAULTS);
  assert.deepEqual(normalizeTargetPolicy({ enabled: 'yes', peers: 'LAPTOP-*', allow: [' session-1 ', ''], deny: [7] }), {
    enabled: true, peers: [], allow: ['session-1'], deny: []
  });
  assert.equal(normalizeTargetPolicy({ enabled: false }).enabled, false);
  assert.equal(normalizeTargetPolicy(undefined).enabled, true, 'malformed config falls back to the permissive default');
});

test('targets: the session is read from the envelope, then from meta', () => {
  assert.equal(resolveTarget(message({ targetSession: ' session-direct ' })), 'session-direct');
  assert.equal(resolveTarget(message({ meta: { targetSession: 'session-meta' } })), 'session-meta', 'older senders use meta');
  assert.equal(resolveTarget(message({ targetSession: 'session-direct', meta: { targetSession: 'session-meta' } })), 'session-direct', 'the first-class field wins');
  assert.equal(resolveTarget(message()), '');
  assert.equal(resolveTarget(null), '');
  assert.equal(resolveTarget({ targetSession: '   ' }), '');
  assert.equal(resolveTarget({ targetSession: 'x'.repeat(TARGET_SESSION_MAX + 50) }).length, TARGET_SESSION_MAX);
  assert.equal(messagePeer(message()), 'LAPTOP-TEST');
  assert.equal(messagePeer({ from: 'PEER-B' }), 'PEER-B');
  assert.equal(messagePeer({}), '');
});

test('targets: a session may be named when the policy allows it', () => {
  const decision = authorizeTarget(TARGET_DEFAULTS, message({ targetSession: 'session-1' }));
  assert.deepEqual(decision, { ok: true, sessionId: 'session-1', reason: 'allowed' });
  assert.equal(authorizeTarget(TARGET_DEFAULTS, message()).ok, false, 'no target means nothing to authorize');
});

test('targets: policy gates run in order (enabled, id, peers, deny, allow)', () => {
  const targeted = (extra = {}, policy = {}) => authorizeTarget(policy, message({ targetSession: 'session-1', ...extra }));

  assert.match(targeted({}, { enabled: false }).reason, /targets\.enabled/);
  assert.match(targeted({ targetSession: 'not a session id!' }).reason, /不是合法/);
  assert.match(targeted({ from: { name: 'PEER-X' } }, { peers: ['LAPTOP-*'] }).reason, /不在 targets\.peers/);
  assert.equal(targeted({ from: { name: 'LAPTOP-2' } }, { peers: ['LAPTOP-*'] }).ok, true, 'peer globs match case-insensitively');
  assert.equal(targeted({}, { peers: ['desktop-*'] }).ok, false, 'an empty allowlist still means "no peer" when peers is set');

  assert.equal(targeted({}, { allow: ['session-*'] }).ok, true);
  assert.match(targeted({}, { allow: ['other-*'] }).reason, /不在 targets\.allow/);
  assert.match(targeted({}, { deny: ['session-1'] }).reason, /targets\.deny/);
  assert.equal(targeted({}, { deny: ['session-*'], allow: ['session-1'] }).ok, false, 'deny wins over allow');
  assert.equal(targeted({}, { deny: ['other-*'], allow: ['session-*'] }).ok, true);
});

test('targets: summary exposes the normalized policy to state.json and logs', () => {
  assert.deepEqual(targetsSummary({}), { enabled: true, peers: [], allow: [], deny: [], open: true });
  assert.equal(targetsSummary({ peers: ['PEER-*'], allow: ['session-*'], deny: ['session-bad'] }).open, false);
  assert.equal(targetsSummary({ enabled: false }).open, false);
  assert.deepEqual(targetsSummary({ peers: ['PEER-*'] }).peers, ['PEER-*']);
});
