import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_DEFAULTS,
  forgetRoutesForSession,
  isSendTool,
  normalizeRoutePolicy,
  registerRoute,
  routeFor,
  routesSummary,
  sentMessageFromResult,
  sweepRoutes
} from '../integrations/dsh-link-bridge/lib/routes.js';

const T0 = 1_800_000_000_000;

/** The exact shape the node's link_send_message answers with (src/mcp.mjs textResult). */
function sendResult(message) {
  return {
    content: [{
      type: 'text',
      text: 'message ' + message.id + ' to LAPTOP-TEST: delivered via push\n\n' + JSON.stringify({ message, delivery: { state: 'delivered', via: 'push' } }, null, 2)
    }]
  };
}

function outbound(id, thread) {
  return { id, thread, to: 'LAPTOP-TEST', subject: 'ping', body: 'ping', from: { name: 'DESKTOP-TEST' } };
}

test('routes: only the send tools register a route', () => {
  assert.equal(isSendTool('mcp__dshlink__link_send_message'), true);
  assert.equal(isSendTool('mcp__dshlink__link_reply'), true);
  assert.equal(isSendTool('link_send_message'), true);
  assert.equal(isSendTool('link_reply'), true);
  assert.equal(isSendTool('mcp__other__link_send_message'), true, 'any dsh-link MCP server counts');
  assert.equal(isSendTool('mcp__dshlink__link_inbox'), false);
  assert.equal(isSendTool('mcp__dshlink__link_status'), false);
  assert.equal(isSendTool('my_link_send_message'), false, 'a lookalike tool name must not route');
  assert.equal(isSendTool(undefined), false);
});

test('routes: the created message is read from the tool result', () => {
  const sent = sentMessageFromResult(sendResult(outbound('msg_01abc', 'thread_01abc')));
  assert.deepEqual(sent, { id: 'msg_01abc', thread: 'thread_01abc' });
  // A fresh send has thread === id, and structuredContent wins when a server sends one.
  assert.deepEqual(sentMessageFromResult({ structuredContent: { message: { id: 'msg_02' } } }), { id: 'msg_02', thread: 'msg_02' });
  // A reply carries the parent thread in the argument when the result is unreadable.
  assert.deepEqual(sentMessageFromResult({ content: [{ type: 'text', text: 'queued' }] }, { thread: 'thread_09' }), { id: '', thread: 'thread_09' });
  assert.equal(sentMessageFromResult({ content: [{ type: 'text', text: 'no json here' }] }), null);
  assert.equal(sentMessageFromResult(undefined), null);
});

test('routes: an inbound message on a registered thread is answered into that session', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({});
  const entry = registerRoute(routes, { thread: 'thread_01', messageId: 'msg_01', sessionId: 'session-asker', now: T0, policy });
  assert.equal(entry.sessionId, 'session-asker');
  assert.deepEqual(entry.messageIds, ['msg_01']);

  const hit = routeFor(routes, { id: 'msg_peer', thread: 'thread_01', replyTo: 'msg_01' }, { now: T0 + 1000, policy });
  assert.deepEqual({ sessionId: hit.sessionId, key: hit.key, matched: hit.matched }, { sessionId: 'session-asker', key: 'thread_01', matched: 'thread' });
  assert.equal(routes.thread_01.hits, 1, 'a hit refreshes the entry so a long exchange does not expire');
  assert.equal(routes.thread_01.lastAt, T0 + 1000);

  // An unregistered thread falls back to the topic pool.
  assert.equal(routeFor(routes, { id: 'msg_new', thread: 'thread_other' }, { now: T0 + 1000, policy }), null);
});

test('routes: a replyTo-only message still finds the asking session', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({});
  registerRoute(routes, { thread: 'thread_02', messageId: 'msg_02', sessionId: 'session-b', now: T0, policy });
  const hit = routeFor(routes, { id: 'msg_peer2', thread: '', replyTo: 'msg_02' }, { now: T0 + 5, policy });
  assert.equal(hit.sessionId, 'session-b');
  assert.equal(hit.matched, 'replyTo');
});

test('routes: a second session sending on the same thread takes it over', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({});
  registerRoute(routes, { thread: 'thread_03', messageId: 'msg_03', sessionId: 'session-first', now: T0, policy });
  registerRoute(routes, { thread: 'thread_03', messageId: 'msg_04', sessionId: 'session-second', now: T0 + 10, policy });
  const hit = routeFor(routes, { thread: 'thread_03' }, { now: T0 + 11, policy });
  assert.equal(hit.sessionId, 'session-second', 'the newest asker gets the answer');
  assert.deepEqual(routes.thread_03.messageIds, ['msg_04']);
});

test('routes: entries expire, are swept, and can be forgotten per session', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({ ttlSeconds: 60 });
  registerRoute(routes, { thread: 'thread_a', messageId: 'msg_a', sessionId: 'session-a', now: T0, policy });
  registerRoute(routes, { thread: 'thread_b', messageId: 'msg_b', sessionId: 'session-b', now: T0, policy });
  assert.equal(routeFor(routes, { thread: 'thread_a' }, { now: T0 + 61_000, policy }), null, 'expired routes answer nothing');
  const swept = sweepRoutes(routes, { now: T0 + 61_000, policy });
  assert.deepEqual(swept, { expired: 2, malformed: 0, overflow: 0 });
  assert.deepEqual(Object.keys(routes), []);

  registerRoute(routes, { thread: 'thread_c', messageId: 'msg_c', sessionId: 'session-c', now: T0, policy });
  registerRoute(routes, { thread: 'thread_d', messageId: 'msg_d', sessionId: 'session-c', now: T0, policy });
  registerRoute(routes, { thread: 'thread_e', messageId: 'msg_e', sessionId: 'session-d', now: T0, policy });
  assert.equal(forgetRoutesForSession(routes, 'session-c'), 2);
  assert.deepEqual(Object.keys(routes), ['thread_e']);
  assert.equal(forgetRoutesForSession(routes, 'session-missing'), 0);
});

test('routes: the table stays bounded and drops the least recently used route', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({ max: 2 });
  registerRoute(routes, { thread: 'thread_old', messageId: 'msg_1', sessionId: 'session-1', now: T0, policy });
  registerRoute(routes, { thread: 'thread_mid', messageId: 'msg_2', sessionId: 'session-2', now: T0 + 10, policy });
  registerRoute(routes, { thread: 'thread_new', messageId: 'msg_3', sessionId: 'session-3', now: T0 + 20, policy });
  assert.deepEqual(Object.keys(routes).sort(), ['thread_mid', 'thread_new']);
  const swept = sweepRoutes(routes, { now: T0 + 21, policy });
  assert.equal(swept.overflow, 0, 'the cap is already enforced on write');
  assert.equal(swept.malformed, 0);
});

test('routes: malformed state is reported and dropped instead of throwing', () => {
  const routes = { thread_bad: { sessionId: '' }, thread_null: null, thread_ok: { sessionId: 'session-z', lastAt: T0, messageIds: [] } };
  const policy = normalizeRoutePolicy({});
  assert.equal(routeFor(routes, { thread: 'thread_bad' }, { now: T0, policy }), null);
  const swept = sweepRoutes(routes, { now: T0, policy });
  assert.equal(swept.malformed, 2);
  assert.deepEqual(Object.keys(routes), ['thread_ok']);
});

test('routes: routing can be turned off from config', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({ enabled: false });
  assert.equal(registerRoute(routes, { thread: 'thread_off', messageId: 'msg_off', sessionId: 'session-off', now: T0, policy }), null);
  assert.deepEqual(routes, {});
  const summary = routesSummary(routes, { now: T0, policy });
  assert.equal(summary.enabled, false);
  assert.equal(summary.count, 0);
  assert.equal(normalizeRoutePolicy({}).ttlSeconds, ROUTE_DEFAULTS.ttlSeconds);
  assert.equal(normalizeRoutePolicy({ ttlSeconds: 1 }).ttlSeconds, 60, 'a nonsense ttl is clamped');
});

test('routes: the summary counts live routes and their sessions', () => {
  const routes = {};
  const policy = normalizeRoutePolicy({});
  registerRoute(routes, { thread: 'thread_1', messageId: 'msg_1', sessionId: 'session-1', now: T0, policy });
  registerRoute(routes, { thread: 'thread_2', messageId: 'msg_2', sessionId: 'session-1', now: T0 + 5, policy });
  registerRoute(routes, { thread: 'thread_3', messageId: 'msg_3', sessionId: 'session-2', now: T0 + 9, policy });
  const summary = routesSummary(routes, { now: T0 + 10, policy });
  assert.equal(summary.count, 3);
  assert.equal(summary.sessions, 2);
  assert.equal(summary.last.thread, 'thread_3');
  assert.equal(summary.last.sessionId, 'session-2');
});
