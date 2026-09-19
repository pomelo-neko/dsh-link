import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { findMcpSdk, mcpClientFor, makeNode, PROJECT_DIR, resetTmp, textOf } from './helpers.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// The SDK ships with DSH, so this suite only runs where one is installed.
const SKIP = findMcpSdk() ? false : 'the MCP client SDK was not found (set DSH_MCP_SDK or DSH_HOME to run this)';

test('mcp: a real MCP client drives dsh-link tools over streamable HTTP', { skip: SKIP }, async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA', roots: [{ name: 'ws', path: PROJECT_DIR, read: true, write: false }] });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);

  const client = await mcpClientFor(`${a.url}/mcp`, a.token);
  t.after(() => client.close());

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  for (const expected of ['link_status', 'link_peers', 'link_send_message', 'link_inbox', 'link_pull_file', 'link_push_file', 'link_sync', 'link_flush', 'link_list_files', 'link_stat_file', 'link_read_message', 'link_reply', 'link_help']) {
    assert.ok(names.includes(expected), `missing tool ${expected} (have ${names.join(', ')})`);
  }
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} needs an object input schema`);
  }

  const status = await client.callTool({ name: 'link_status', arguments: {} });
  assert.ok(!status.isError, textOf(status));
  assert.match(textOf(status), /nodeA/);

  const peers = await client.callTool({ name: 'link_peers', arguments: { probe: true } });
  assert.match(textOf(peers), /nodeB/);
  assert.match(textOf(peers), /"reachable": true/);

  const sent = await client.callTool({ name: 'link_send_message', arguments: { peer: 'nodeB', subject: 'from mcp', body: 'hello over mcp' } });
  assert.ok(!sent.isError, textOf(sent));
  assert.match(textOf(sent), /delivered/);
  const inbox = await b.ops.inbox({});
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].body, 'hello over mcp');
  assert.equal(inbox.messages[0].from.name, 'nodeA');

  const listing = await client.callTool({ name: 'link_list_files', arguments: { peer: 'self', root: 'ws', path: 'src' } });
  assert.ok(!listing.isError, textOf(listing));
  assert.match(textOf(listing), /server\.mjs/);

  const localSource = await fs.readFile(path.join(PROJECT_DIR, 'package.json'));
  const pulled = await client.callTool({ name: 'link_pull_file', arguments: { peer: 'self', root: 'ws', path: 'package.json' } });
  assert.ok(!pulled.isError, textOf(pulled));
  const landed = await fs.readFile(path.join(a.dir, 'inbox', 'package.json'));
  assert.equal(sha256(landed), sha256(localSource));

  const blocked = await client.callTool({ name: 'link_pull_file', arguments: { peer: 'self', root: 'ws', path: '../escape.txt' } });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /forbidden/);

  await assert.rejects(() => client.callTool({ name: 'link_not_a_tool', arguments: {} }));

  const help = await client.callTool({ name: 'link_help', arguments: {} });
  assert.match(textOf(help), /dsh-link/);
});

test('mcp: the endpoint honours tokens when localhost trust is off', { skip: SKIP }, async (t) => {
  await resetTmp();
  const strict = await makeNode({ name: 'strict', trustLocalhost: false });
  t.after(() => strict.close());

  await assert.rejects(() => mcpClientFor(`${strict.url}/mcp`, 'not-the-token'));

  const client = await mcpClientFor(`${strict.url}/mcp`, strict.token);
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  await client.close();
});
