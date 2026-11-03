import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, resetTmp } from './helpers.mjs';

const json = async (response) => {
  const body = await response.json();
  assert.ok(response.ok, 'expected a 2xx response, got ' + response.status + ': ' + JSON.stringify(body));
  return body;
};

test('directed: targetSession/originSession travel in the envelope over HTTP', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA' });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);

  const sent = await a.ops.sendMessage({
    to: 'nodeB', subject: 'please handle', body: 'run the build',
    targetSession: 'session-remote-1', originSession: 'session-local-1'
  });
  assert.equal(sent.message.targetSession, 'session-remote-1');
  assert.equal(sent.message.originSession, 'session-local-1');

  const inbox = await b.ops.inbox({});
  assert.equal(inbox.count, 1);
  const received = inbox.messages[0];
  assert.equal(received.targetSession, 'session-remote-1', 'the push keeps the target');
  assert.equal(received.originSession, 'session-local-1', 'the push keeps the origin');

  // The same fields must survive the raw HTTP delivery a non-MCP sender uses.
  const response = await fetch(b.url + '/api/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'msg_http_directed_1', ts: new Date().toISOString(),
      from: { nodeId: 'node_raw', name: 'RAW-PEER', url: 'http://127.0.0.1:1' },
      to: b.cfg.name, thread: 'msg_thread_http_1', replyTo: null, kind: 'message',
      subject: 'raw', body: 'raw body', attachments: [],
      targetSession: 'session-http-target', originSession: 'session-http-origin'
    })
  });
  const body = await json(response);
  assert.equal(body.id, 'msg_http_directed_1');
  assert.equal(body.stored, 'inbox');
  const found = (await b.ops.inbox({ thread: 'msg_thread_http_1' })).messages[0];
  assert.equal(found.targetSession, 'session-http-target');
  assert.equal(found.originSession, 'session-http-origin');
});

test('directed: the bridge bind endpoint is loopback-only and round-trips a binding', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'node-bind' });
  t.after(() => node.close());

  const created = await json(await fetch(node.url + '/api/v1/bridge/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread: 'msg_thread_bind_1', sessionId: 'session-bound-1' })
  }));
  assert.equal(created.binding.thread, 'msg_thread_bind_1');
  assert.equal(created.binding.sessionId, 'session-bound-1');
  assert.equal((await node.ops.binding({ thread: 'msg_thread_bind_1' })).binding.sessionId, 'session-bound-1');

  const queried = await json(await fetch(node.url + '/api/v1/bridge/bind?thread=msg_thread_bind_1'));
  assert.equal(queried.binding.sessionId, 'session-bound-1');
  assert.equal((await json(await fetch(node.url + '/api/v1/bridge/bind?thread=msg_thread_missing'))).binding, null);

  // Without localhost trust the bridge channel must stay closed even with a valid token:
  // it is a this-machine channel, not a peer API.
  const strict = await makeNode({ name: 'strict-bind', trustLocalhost: false });
  t.after(() => strict.close());
  const denied = await fetch(strict.url + '/api/v1/bridge/bind', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + strict.token },
    body: JSON.stringify({ thread: 'msg_thread_bind_2', sessionId: 'session-bound-2' })
  });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error?.message ?? '', /only reachable from this machine/);
});

test('directed: a thread binding supplies originSession automatically', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA' });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);

  await a.ops.bindSession({ thread: 'msg_thread_abc', sessionId: 'session-local-x' });
  const sent = await a.ops.sendMessage({ to: 'nodeB', subject: 'ask', body: 'question', thread: 'msg_thread_abc' });
  assert.equal(sent.message.originSession, 'session-local-x', 'the binding names the asking conversation');
  assert.equal(sent.message.targetSession, null, 'no target is invented locally');

  const explicit = await a.ops.sendMessage({ to: 'nodeB', subject: 'ask', body: 'again', thread: 'msg_thread_abc', originSession: 'session-explicit' });
  assert.equal(explicit.message.originSession, 'session-explicit', 'an explicit origin wins over the binding');

  // This is what link_reply does: answer the thread and address the peer's origin session.
  const reply = await a.ops.sendMessage({
    to: 'nodeB', subject: 'Re: ask', body: 'answer', thread: 'msg_thread_abc',
    replyTo: 'msg_remote_question_1', targetSession: sent.message.originSession
  });
  assert.equal(reply.message.targetSession, 'session-local-x');
  const received = (await b.ops.inbox({ thread: 'msg_thread_abc' })).messages.find((m) => m.id === reply.message.id);
  assert.equal(received.targetSession, 'session-local-x');
});
