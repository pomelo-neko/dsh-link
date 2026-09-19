// Integration test: the 0.3 DSH access layers.
//   1. read view   — /api/v1/dsh/* serves workspaces, conversations and transcripts of a DSH home
//   2. virtual root — files.roots[].kind === 'workspaces' exposes every registered workspace
//   3. capability channel — /api/v1/dsh/call is answered by a bridge through /api/v1/bridge/*
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { zstdCompressSync } from 'node:zlib';
import { makeNode, TMP } from './helpers.mjs';
import { saveConfig } from '../src/config.mjs';

const RUN = 'dsh-access-' + process.pid;

/** Write one JSONL session log as concatenated zstd frames (exactly how DSH stores it). */
async function writeSessionLog(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const frames = events.map((event) => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')));
  await fs.writeFile(file, Buffer.concat(frames));
}

async function makeDshHome(suffix = '') {
  const home = path.join(TMP, RUN + '-home' + suffix);
  const wsAlpha = path.join(home, 'ws', 'alpha');
  const wsBeta = path.join(home, 'ws', 'beta');
  await fs.mkdir(wsAlpha, { recursive: true });
  await fs.mkdir(wsBeta, { recursive: true });
  await fs.writeFile(path.join(wsAlpha, 'hello.txt'), 'hello from alpha\n', 'utf8');
  await fs.writeFile(path.join(wsAlpha, '.env'), 'SECRET=1\n', 'utf8');

  const alphaId = 'ws-alpha-0001';
  const betaId = 'ws-beta-0002';
  const sessionA = 'session-11111111-1111-4111-8111-111111111111';
  const sessionB = 'session-22222222-2222-4222-8222-222222222222';
  const sessionOld = 'session-33333333-3333-4333-8333-333333333333';

  const base = 1789124000000;
  await writeSessionLog(path.join(home, 'sessions', '--alpha--', sessionA, 'session.v3.jsonl.zstd'), [
    { type: 'session', version: 3, id: sessionA, createdAt: base, cwd: wsAlpha, agentPreset: 'ptc' },
    { type: 'user/message', seq: 1, time: base + 1000, data: { role: 'user', content: [{ type: 'text', text: 'alpha 的第一个问题' }] } },
    { type: 'session/title', seq: 2, time: base + 2000, data: { title: 'Alpha 对话', messageSeqs: [1] } },
    { type: 'assistant/message', seq: 3, time: base + 3000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: '这是回答' }] } } },
    { type: 'tool/call', seq: 4, time: base + 4000, data: { name: 'pwsh', input: { command: 'echo hi' } } }
  ]);
  await writeSessionLog(path.join(home, 'sessions', '--beta--', sessionB, 'session.v3.jsonl.zstd'), [
    { type: 'session', version: 3, id: sessionB, createdAt: base + 10000, cwd: wsBeta, agentPreset: 'ptc' },
    { type: 'user/message', seq: 1, time: base + 11000, data: { role: 'user', content: [{ type: 'text', text: 'beta 的问题' }] } },
    { type: 'session/title', seq: 2, time: base + 12000, data: { title: 'Beta 对话' } }
  ]);
  await writeSessionLog(path.join(home, 'sessions', '--alpha--', sessionOld, 'session.v3.jsonl.zstd'), [
    { type: 'session', version: 3, id: sessionOld, createdAt: base - 90000, cwd: wsAlpha, agentPreset: 'ptc' },
    { type: 'user/message', seq: 1, time: base - 89000, data: { role: 'user', content: [{ type: 'text', text: '很久以前的对话' }] } }
  ]);

  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [alphaId, betaId], archivedSessionIds: [sessionOld] },
    tables: {
      workspaces: {
        [alphaId]: { path: wsAlpha, title: 'Alpha', sessionIds: [sessionA, sessionOld], createdAt: new Date(base).toISOString(), updatedAt: new Date(base + 5000).toISOString() },
        [betaId]: { path: wsBeta, title: 'Beta', sessionIds: [sessionB], createdAt: new Date(base).toISOString(), updatedAt: new Date(base + 13000).toISOString() }
      }
    }
  };
  await fs.mkdir(path.join(home, 'storages'), { recursive: true });
  await fs.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify(registry, null, 2), 'utf8');
  return { home, wsAlpha, wsBeta, alphaId, betaId, sessionA, sessionB, sessionOld };
}

async function api(node, pathname, init = {}) {
  const res = await fetch(node.url + pathname, {
    ...init,
    headers: { authorization: 'Bearer ' + node.token, 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  return { status: res.status, body: await res.json() };
}

const bridge = (node, pathname, init = {}) => fetch(node.url + pathname, init).then(async (res) => ({ status: res.status, body: await res.json() }));

test('dsh access: read view, virtual workspace root and the capability channel', async (t) => {
  const dshHome = await makeDshHome();
  const node = await makeNode({
    id: RUN,
    dsh: { enabled: true, home: dshHome.home, exposeWorkspaces: true, exposeTranscripts: true, transcriptMaxChars: 4000 },
    roots: [{ name: 'allws', kind: 'workspaces', read: true }],
    capabilities: { enabled: true, methods: ['workspaces.list', 'sessions.list', 'sessions.read', 'bridge.status'] }
  });
  t.after(() => node.close());

  // ---- 1. workspaces -------------------------------------------------------
  const workspaces = await api(node, '/api/v1/dsh/workspaces');
  assert.equal(workspaces.status, 200);
  assert.equal(workspaces.body.count, 2, 'both registered workspaces must be listed');
  const alpha = workspaces.body.workspaces.find((w) => w.id === dshHome.alphaId);
  assert.equal(alpha.title, 'Alpha');
  assert.equal(alpha.path, dshHome.wsAlpha);
  assert.equal(alpha.sessions, 2);

  // ---- 2. sessions ---------------------------------------------------------
  const all = await api(node, '/api/v1/dsh/sessions');
  assert.equal(all.body.sessions.length, 2, 'the archived conversation must be hidden by default');
  const withArchived = await api(node, '/api/v1/dsh/sessions?includeArchived=1');
  assert.equal(withArchived.body.sessions.length, 3);
  const archived = withArchived.body.sessions.find((s) => s.sessionId === dshHome.sessionOld);
  assert.equal(archived.archived, true, 'archivedSessionIds must be honoured');
  const scoped = await api(node, '/api/v1/dsh/sessions?workspace=' + encodeURIComponent(dshHome.betaId));
  assert.equal(scoped.body.sessions.length, 1);
  assert.equal(scoped.body.sessions[0].sessionId, dshHome.sessionB);
  const titled = all.body.sessions.find((s) => s.sessionId === dshHome.sessionA);
  assert.equal(titled.title, 'Alpha 对话', 'the session/title event must supply the title');

  // ---- 3. transcript -------------------------------------------------------
  const transcript = await api(node, '/api/v1/dsh/sessions/' + dshHome.sessionA + '/transcript');
  assert.equal(transcript.status, 200);
  const kinds = transcript.body.messages.map((m) => m.kind);
  assert.ok(kinds.includes('user') && kinds.includes('assistant'), 'user and assistant text must be present: ' + kinds.join(','));
  assert.ok(transcript.body.messages.some((m) => m.text.includes('alpha 的第一个问题')));
  assert.ok(transcript.body.messages.some((m) => m.kind === 'reasoning' && m.text.includes('内部推理')));

  // ---- 4. virtual workspaces root -----------------------------------------
  const listed = await api(node, '/api/v1/files?root=allws');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.entries.map((e) => e.path).sort(), [dshHome.alphaId, dshHome.betaId].sort());
  const inside = await api(node, '/api/v1/files?root=allws&path=' + dshHome.alphaId);
  assert.ok(inside.body.entries.some((e) => e.name === 'hello.txt'));
  const stat = await api(node, '/api/v1/files/stat?root=allws&path=' + dshHome.alphaId + '/hello.txt');
  assert.equal(stat.body.type, 'file');
  const denied = await api(node, '/api/v1/files/stat?root=allws&path=' + dshHome.alphaId + '/.env');
  assert.equal(denied.status, 403, 'the deny list must still apply inside a virtual workspace');

  // ---- 5. capability channel ----------------------------------------------
  const caps = await api(node, '/api/v1/dsh/capabilities');
  assert.equal(caps.body.enabled, true);
  assert.ok(caps.body.methods.includes('sessions.read'));

  const deniedCall = await api(node, '/api/v1/dsh/call', {
    method: 'POST',
    body: JSON.stringify({ method: 'sessions.prompt', params: { sessionId: 'x', text: 'hi' }, waitSeconds: 1 })
  });
  assert.equal(deniedCall.status, 403, 'an action that is not authorized must be refused');
  assert.equal(deniedCall.body.error.code, 'capability_denied');

  const pendingCall = api(node, '/api/v1/dsh/call', {
    method: 'POST',
    body: JSON.stringify({ method: 'workspaces.list', params: {}, waitSeconds: 5 })
  });
  // The bridge side of the protocol: claim over loopback, then post the result back.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const claimed = await bridge(node, '/api/v1/bridge/commands?limit=5&bridge=test-bridge');
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.count, 1, 'the queued call must be claimable by the bridge');
  const command = claimed.body.commands[0];
  assert.equal(command.method, 'workspaces.list');
  const again = await bridge(node, '/api/v1/bridge/commands?limit=5&bridge=test-bridge');
  assert.equal(again.body.count, 0, 'a claimed command must not be handed out twice');
  const posted = await bridge(node, '/api/v1/bridge/commands/' + command.id + '/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, result: { workspaces: [{ id: 'ws-1' }] } })
  });
  assert.equal(posted.status, 200);
  const answered = await pendingCall;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.status, 'done');
  assert.deepEqual(answered.body.result.workspaces, [{ id: 'ws-1' }]);

  const heartbeat = await bridge(node, '/api/v1/bridge/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.3.0-test', capabilities: ['workspaces.list'], sessions: 2 })
  });
  assert.equal(heartbeat.status, 200);
  const status = await bridge(node, '/api/v1/bridge/status');
  assert.equal(status.body.bridge.version, '0.3.0-test');
  assert.equal(status.body.fresh, true);

  // ---- 6. disabled by default ---------------------------------------------
  const plain = await makeNode({ id: RUN + '-plain' });
  t.after(() => plain.close());
  const off = await api(plain, '/api/v1/dsh/workspaces');
  assert.equal(off.status, 403);
  assert.equal(off.body.error.code, 'dsh_disabled');
});

test('dsh access: a running node follows a changed dsh.home', async (t) => {
  // Regression: the resolved home depends on cfg.home / DSH_HOME / ~/.dsh, and a node started by a
  // task or service has no DSH_HOME — so a config edit must move the view, not need a restart.
  const homeA = await makeDshHome('-a');
  const homeB = await makeDshHome('-b');
  const node = await makeNode({
    id: RUN + '-home',
    watch: true,
    watchIntervalMs: 0,
    dsh: { enabled: true, home: homeA.home, exposeWorkspaces: true, exposeTranscripts: true }
  });
  t.after(() => node.close());

  const before = await api(node, '/api/v1/dsh/workspaces');
  assert.equal(before.body.home, homeA.home);
  assert.equal(before.body.count, 2);

  node.cfg.dsh.home = homeB.home;
  await saveConfig(node.cfg);

  let after = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await api(node, '/api/v1/dsh/workspaces');
    if (probe.body.home === homeB.home) { after = probe; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(after, 'the node must pick up the new dsh.home without a restart');
  assert.equal(after.body.count, 2);
  assert.deepEqual(after.body.workspaces.map((w) => w.title).sort(), ['Alpha', 'Beta']);
  assert.equal(after.body.workspaces.find((w) => w.id === homeB.alphaId).path, homeB.wsAlpha);
});

test('dsh access: the bridge channel refuses remote callers', async (t) => {
  const node = await makeNode({
    id: RUN + '-guard',
    dsh: { enabled: true, home: path.join(TMP, RUN + '-home'), exposeWorkspaces: true, exposeTranscripts: true },
    capabilities: { enabled: true, methods: ['workspaces.list'] }
  });
  t.after(() => node.close());
  // A token-authenticated caller is not loopback: it must not touch the bridge endpoints.
  const remote = await fetch(node.url + '/api/v1/bridge/commands', { headers: { authorization: 'Bearer ' + node.token } });
  assert.equal(remote.status, 403);
  const body = await remote.json();
  assert.equal(body.error.code, 'bridge_loopback_only');
});

test('dsh access: the new MCP tools are listed and answer over the wire', async (t) => {
  const dshHome = await makeDshHome();
  const node = await makeNode({
    id: RUN + '-mcp',
    dsh: { enabled: true, home: dshHome.home, exposeWorkspaces: true, exposeTranscripts: true },
    capabilities: { enabled: true, methods: ['workspaces.list'] }
  });
  t.after(() => node.close());

  const rpc = async (method, params) => {
    const res = await fetch(node.url + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + node.token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return res.json();
  };

  const listed = await rpc('tools/list', {});
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ['link_dsh_workspaces', 'link_dsh_sessions', 'link_dsh_transcript', 'link_call']) {
    assert.ok(names.includes(name), name + ' must be exposed (got: ' + names.join(', ') + ')');
  }

  const called = await rpc('tools/call', { name: 'link_dsh_workspaces', arguments: {} });
  assert.ok(!called.result.isError, JSON.stringify(called.result));
  assert.match(called.result.content[0].text, /2 workspace\(s\)/);
  assert.match(called.result.content[0].text, /Alpha/);

  const refused = await rpc('tools/call', { name: 'link_call', arguments: { method: 'sessions.prompt', params: { sessionId: 'x', text: 'hi' }, waitSeconds: 1 } });
  assert.equal(refused.result.isError, true, 'an unauthorized action must surface as a tool error');
  assert.match(refused.result.content[0].text, /capability_denied|denied/);
});

