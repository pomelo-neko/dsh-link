import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { findMcpSdk, mcpClientFor, makeNode, resetTmp, textOf } from './helpers.mjs';

// This suite drives the node through a real MCP client, which needs the SDK DSH ships with.
const SKIP = findMcpSdk() ? false : 'the MCP client SDK was not found (set DSH_MCP_SDK or DSH_HOME to run this)';

/** Rewrite the node's config file the way the CLI does (peers accept / token new / root add). */
async function rewriteConfig(node, mutate) {
  const file = node.cfg.configPath;
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  await mutate(raw);
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return file;
}

test('reload: a node picks up config-file changes without a restart', { skip: SKIP }, async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'hot-a', watch: true });
  const b = await makeNode({ name: 'hot-b' });
  t.after(async () => { await a.close(); await b.close(); });

  const client = await mcpClientFor(`${a.url}/mcp`, a.token);
  t.after(() => client.close());

  const before = await client.callTool({ name: 'link_send_message', arguments: { peer: 'hot-b', subject: 'too early', body: 'nope' } });
  assert.match(textOf(before), /unknown peer: hot-b/);
  assert.equal((await b.ops.inbox({})).count, 0);

  await rewriteConfig(a, (raw) => {
    raw.peers = [{ name: 'hot-b', url: b.url, token: b.token, stcp: null }];
  });

  // No restart, no manual reload call: the next request must see the new peer.
  const after = await client.callTool({ name: 'link_send_message', arguments: { peer: 'hot-b', subject: 'now it works', body: 'hello' } });
  assert.ok(!after.isError, textOf(after));
  assert.match(textOf(after), /delivered/);
  assert.ok(a.watcher.state().reloads >= 1, 'watcher should have reloaded');

  const inbox = await b.ops.inbox({});
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].subject, 'now it works');

  const status = await fetch(`${a.url}/api/v1/status`).then((r) => r.json());
  assert.equal(status.runtime.configReloads >= 1, true);
});

test('reload: shared folders are rebuilt when the config adds a root', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'hot-roots', watch: true, roots: [] });
  t.after(async () => { await a.close(); });

  const dir = path.join(a.dir, 'newshare');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'note.txt'), 'hello from a freshly added root');

  await rewriteConfig(a, (raw) => {
    raw.files.roots = [{ name: 'share', path: dir, read: true, write: false }];
  });

  const list = await fetch(`${a.url}/api/v1/files?root=share`).then((r) => r.json());
  assert.equal(list.root, 'share');
  assert.deepEqual(list.entries.map((e) => e.name), ['note.txt']);
  assert.equal(a.watcher.state().reloads, 1);
});

test('reload: a broken config file never takes the node down', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'hot-bad', watch: true });
  t.after(async () => { await a.close(); });

  await fs.writeFile(a.cfg.configPath, '{ this is not json', 'utf8');
  const health = await fetch(`${a.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).name, 'hot-bad');

  const status = await fetch(`${a.url}/api/v1/status`).then((r) => r.json());
  assert.match(status.runtime.configLastError, /not valid JSON/);
});
