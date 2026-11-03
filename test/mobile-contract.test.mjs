// 0.6.0: the Android control app's node-side contract.
//
// The app talks to an existing node over the same public API as everything else. This suite pins
// the exact requests it makes and the role boundary it relies on, so a future server change cannot
// silently break the phone build. It needs a real DSH installation to read a transcript from; set
// DSH_HOME (or run the suite on a machine where D:/dsh-home exists) to enable it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { makeNode, resetTmp } from './helpers.mjs';
import { createInboundToken } from '../src/config.mjs';

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && existsSync(path.join(fromEnv, 'storages', 'workspace.json'))) return fromEnv;
  if (existsSync('D:/dsh-home/storages/workspace.json')) return 'D:/dsh-home';
  return '';
}

async function request(node, pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(node.url + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { status: res.status, body: payload };
}

test('mobile: the control app contract works with a device token', async (t) => {
  const home = dshHome();
  if (!home) return t.skip('set DSH_HOME to a DSH installation to run the mobile contract test');
  await resetTmp();
  const node = await makeNode({
    name: 'mobile-contract',
    trustLocalhost: false,
    dsh: { enabled: true, home, exposeWorkspaces: true, exposeTranscripts: true },
    capabilities: {
      enabled: true,
      methods: ['workspaces.list', 'sessions.list', 'sessions.read', 'sessions.prompt']
    }
  });
  t.after(() => node.close());
  const device = createInboundToken(node.cfg, 'phone', { role: 'device' }).token;
  const admin = node.token;

  // 1) capability discovery (MainActivity: GET /api/v1/info)
  const info = await request(node, '/api/v1/info', { token: device });
  assert.equal(info.status, 200);
  assert.equal(info.body.dsh?.workspaces, true);
  assert.equal(info.body.dsh?.transcripts, true);
  assert.equal(info.body.capabilities?.enabled, true);
  assert.ok(info.body.capabilities?.methods?.includes('sessions.prompt'));

  // 2) workspaces → sessions → transcript (list screens)
  const workspaces = await request(node, '/api/v1/dsh/workspaces', { token: device });
  assert.equal(workspaces.status, 200);
  if (!Array.isArray(workspaces.body.workspaces) || workspaces.body.workspaces.length === 0) {
    return t.skip('the configured DSH home has no visible workspaces');
  }
  let session = null;
  for (const workspace of workspaces.body.workspaces.slice(0, 3)) {
    const sessions = await request(node, '/api/v1/dsh/sessions?workspace=' + encodeURIComponent(workspace.id) + '&limit=50', { token: device });
    assert.equal(sessions.status, 200);
    session = (sessions.body.sessions ?? []).find((entry) => (entry.messages ?? 0) > 1);
    if (session) break;
  }
  if (!session) return t.skip('the visible workspaces have no non-empty session');

  const snapshot = await request(node, '/api/v1/dsh/sessions/' + encodeURIComponent(session.sessionId) + '/transcript?tail=1&limit=20', { token: device });
  assert.equal(snapshot.status, 200);
  assert.ok(Array.isArray(snapshot.body.messages));
  assert.ok(snapshot.body.latestSeq > 0, 'latestSeq is the cursor the app stores');
  const cursor = Math.max(0, snapshot.body.latestSeq - 2);
  const increment = await request(node, '/api/v1/dsh/sessions/' + encodeURIComponent(session.sessionId) + '/transcript?sinceSeq=' + cursor + '&limit=20', { token: device });
  assert.equal(increment.status, 200);
  assert.equal(increment.body.sinceSeq, cursor);
  assert.ok((increment.body.messages ?? []).every((message) => (message.seq ?? 0) > cursor));
  const row = (increment.body.messages ?? [])[0];
  if (row) assert.equal(typeof row.kind, 'string');

  // 3) send a prompt through the capability channel (SessionActivity: POST /api/v1/dsh/call)
  const queued = await request(node, '/api/v1/dsh/call', {
    method: 'POST',
    token: device,
    body: { method: 'sessions.prompt', params: { sessionId: session.sessionId, text: 'mobile contract' }, waitSeconds: 0 }
  });
  assert.equal(queued.status, 200);
  assert.ok(queued.body.commandId);
  assert.equal(queued.body.pending, true);

  // 4) pretend to be the bridge so the command reaches a terminal state
  const claimed = await node.ops.claimCommands({ limit: 5, bridge: 'contract' });
  assert.equal(claimed.count, 1);
  assert.equal(claimed.commands[0].method, 'sessions.prompt');
  await node.ops.completeCommand(queued.body.commandId, { ok: true, result: { accepted: true } });
  const result = await request(node, '/api/v1/dsh/call/' + encodeURIComponent(queued.body.commandId), { token: device });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.ok, true);

  // 5) a method outside capabilities.methods is refused, and the device token stays out of the
  //    message/admin planes (the app never needs them).
  const denied = await request(node, '/api/v1/dsh/call', {
    method: 'POST',
    token: device,
    body: { method: 'sessions.create', params: { title: 'nope' }, waitSeconds: 0 }
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'capability_denied');
  assert.equal((await request(node, '/api/v1/messages', { token: device })).status, 403);
  assert.equal((await request(node, '/api/v1/peers', { token: device })).status, 403);
  assert.equal((await request(node, '/api/v1/bridge/commands', { token: device })).status, 403);
  assert.equal((await request(node, '/api/v1/dsh/workspaces')).status, 401, 'no token, no view');
  assert.equal((await request(node, '/api/v1/peers', { token: admin })).status, 200, 'admin still works');
});
