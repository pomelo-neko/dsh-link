import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { makeNode, PROJECT_DIR, resetTmp } from './helpers.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

test('auth: token required, health stays open', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'authnode', trustLocalhost: false });
  t.after(() => node.close());

  const health = await fetch(`${node.url}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).name, 'authnode');

  assert.equal((await fetch(`${node.url}/api/v1/info`)).status, 401);
  assert.equal((await fetch(`${node.url}/api/v1/info`, { headers: { authorization: 'Bearer wrong' } })).status, 401);

  const ok = await fetch(`${node.url}/api/v1/info`, { headers: { authorization: `Bearer ${node.token}` } });
  assert.equal(ok.status, 200);
  const info = await ok.json();
  assert.equal(info.name, 'authnode');
  assert.equal(info.software, 'dsh-link');

  const altHeader = await fetch(`${node.url}/api/v1/info`, { headers: { 'x-dshlink-token': node.token } });
  assert.equal(altHeader.status, 200);
});

test('messages: delivery, thread, inline attachment, mark-read', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA' });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);
  b.connectTo(a);

  const sent = await a.ops.sendMessage({
    to: 'nodeB',
    subject: 'hello',
    body: 'ping',
    attachments: [{ name: 'note.txt', contentBase64: Buffer.from('attached-bytes').toString('base64') }]
  });
  assert.equal(sent.delivery.state, 'delivered');
  assert.equal(sent.delivery.via, 'nodeB');

  const inbox = await b.ops.inbox({});
  assert.equal(inbox.count, 1);
  assert.equal(inbox.unread, 1);
  const message = inbox.messages[0];
  assert.equal(message.body, 'ping');
  assert.equal(message.from.name, 'nodeA');
  assert.equal(message.thread, message.id);
  assert.equal(message.attachments.length, 1);
  assert.equal(Buffer.from(message.attachments[0].contentBase64, 'base64').toString(), 'attached-bytes');

  const reply = await b.ops.sendMessage({ to: 'nodeA', body: 'pong', thread: message.thread, replyTo: message.id, kind: 'reply' });
  assert.equal(reply.delivery.state, 'delivered');
  const back = await a.ops.inbox({ thread: message.thread });
  assert.equal(back.count, 1);
  assert.equal(back.messages[0].replyTo, message.id);

  await b.ops.readMessage({ id: message.id });
  assert.equal((await b.ops.inbox({ unreadOnly: true })).count, 0);
});

test('queue and sync: writes survive an unreachable peer', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA' });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);
  b.connectTo(a);
  a.cfg.peers[0].url = 'http://127.0.0.1:1';

  const sent = await a.ops.sendMessage({ to: 'nodeB', body: 'while you were out' });
  assert.equal(sent.delivery.state, 'pending');
  const stats = await a.store.stats();
  assert.equal(stats.outboxPending, 1);

  const synced = await b.ops.sync({ peer: 'nodeA' });
  assert.equal(synced.imported, 1, 'peer pulls the queued message from our outbox');
  assert.equal((await b.ops.inbox({})).messages[0].body, 'while you were out');
  assert.equal((await b.ops.sync({ peer: 'nodeA' })).imported, 0, 'sync is idempotent');

  // Retry once the peer is reachable again.
  a.cfg.peers[0].url = b.url;
  a.cfg.peers[0].token = b.token;
  const flushed = await a.ops.flush({});
  assert.equal(flushed.delivered, 1);
  assert.equal((await a.store.stats()).outboxPending, 0);
});

test('files: list, pull with hash verification, confinement and deny list', async (t) => {
  await resetTmp();
  const shared = path.join(PROJECT_DIR, 'test', '.tmp', 'shared');
  await fs.mkdir(path.join(shared, 'sub'), { recursive: true });
  await fs.writeFile(path.join(shared, 'hello.txt'), 'hello dsh-link');
  await fs.writeFile(path.join(shared, 'sub', 'nested.txt'), 'nested');
  await fs.writeFile(path.join(shared, '.env'), 'SECRET=1');

  const a = await makeNode({ name: 'nodeA', roots: [{ name: 'ws', path: shared, read: true, write: false }] });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  b.connectTo(a);

  const listing = await b.ops.listFiles({ peer: 'nodeA', root: 'ws', path: '' });
  assert.deepEqual(listing.entries.map((e) => e.name).sort(), ['hello.txt', 'sub']);

  const pulled = await b.ops.pullFile({ peer: 'nodeA', root: 'ws', path: 'hello.txt' });
  assert.equal(pulled.verified, true);
  assert.equal(await fs.readFile(pulled.path, 'utf8'), 'hello dsh-link');
  assert.equal(pulled.sha256, sha256(Buffer.from('hello dsh-link')));

  await assert.rejects(
    () => b.ops.pullFile({ peer: 'nodeA', root: 'ws', path: '../shared/hello.txt' }),
    (err) => err.code === 'forbidden'
  );
  await assert.rejects(
    () => b.ops.pullFile({ peer: 'nodeA', root: 'ws', path: '..\\..\\Windows\\win.ini' }),
    (err) => err.code === 'forbidden'
  );
  await assert.rejects(
    () => b.ops.listFiles({ peer: 'nodeA', root: 'ws', path: '.env' }),
    (err) => err.code === 'forbidden'
  );
  await assert.rejects(
    () => b.ops.pullFile({ peer: 'nodeA', root: 'nope', path: 'hello.txt' }),
    (err) => err.code === 'not_found'
  );
});

test('uploads are refused unless the serving node opts in', async (t) => {
  await resetTmp();
  const writable = path.join(PROJECT_DIR, 'test', '.tmp', 'dropbox');
  await fs.mkdir(writable, { recursive: true });
  const source = path.join(PROJECT_DIR, 'test', '.tmp', 'payload.bin');
  await fs.writeFile(source, Buffer.from([1, 2, 3, 4, 5]));

  const closed = await makeNode({ name: 'closed', roots: [{ name: 'box', path: writable, read: true, write: true }] });
  const open = await makeNode({ name: 'open', allowUpload: true, roots: [{ name: 'box', path: writable, read: true, write: true }] });
  const sender = await makeNode({ name: 'sender' });
  t.after(async () => { await closed.close(); await open.close(); await sender.close(); });
  sender.connectTo(closed);
  sender.connectTo(open);

  await assert.rejects(
    () => sender.ops.pushFile({ peer: 'closed', root: 'box', path: 'payload.bin', file: source }),
    (err) => err.code === 'forbidden'
  );

  const pushed = await sender.ops.pushFile({ peer: 'open', root: 'box', path: 'payload.bin', file: source });
  assert.equal(pushed.size, 5);
  assert.deepEqual([...await fs.readFile(path.join(writable, 'payload.bin'))], [1, 2, 3, 4, 5]);
});

test('relay: a hub forwards messages addressed to a third node', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA' });
  const hub = await makeNode({ name: 'hub' });
  const c = await makeNode({ name: 'nodeC' });
  t.after(async () => { await a.close(); await hub.close(); await c.close(); });
  a.connectTo(hub);
  hub.connectTo(c);

  const sent = await a.ops.sendMessage({ to: 'nodeC', subject: 'via hub', body: 'relayed' });
  assert.equal(sent.delivery.state, 'delivered');
  assert.equal(sent.delivery.via, 'hub');

  const inbox = await c.ops.inbox({});
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].body, 'relayed');
  assert.equal(inbox.messages[0].via, 'push');
});

test('status reports identity, roots and peer state', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'nodeA', roots: [{ name: 'ws', path: PROJECT_DIR, read: true, write: false }] });
  const b = await makeNode({ name: 'nodeB' });
  t.after(async () => { await a.close(); await b.close(); });
  a.connectTo(b);

  const status = await a.ops.status({ probe: true });
  assert.equal(status.node.name, 'nodeA');
  assert.equal(status.roots[0].name, 'ws');
  assert.equal(status.peers[0].name, 'nodeB');
  assert.equal(status.peers[0].reachable, true);
  assert.equal(status.peers[0].remote.name, 'nodeB');

  const unreachable = await makeNode({ name: 'nodeD' });
  a.connectTo(unreachable);
  await unreachable.close();
  const after = await a.ops.status({ probe: true });
  assert.equal(after.peers[1].reachable, false);
});
