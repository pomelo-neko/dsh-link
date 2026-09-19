import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeNode, resetTmp } from './helpers.mjs';
import { MessageStore } from '../src/store.mjs';

test('state: a second process (CLI) does not clobber the node\'s read/delivery marks', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'state-a' });
  t.after(() => node.close());

  const record = { id: "msg_state_test", ts: new Date().toISOString(), from: { name: "x" }, to: "state-a", subject: "hi", body: "b", attachments: [] };
  await node.store.append('inbox', record);

  // Simulate the running node and a CLI invocation working on the same data dir.
  const daemon = await new MessageStore(node.dir).init();
  const cli = await new MessageStore(node.dir).init();

  await daemon.markRead([record.id]);
  await cli.setDelivery(record.id, { state: "dropped", updatedAt: new Date(Date.now() + 1000).toISOString() });
  await daemon.markRead([record.id]);            // daemon writes again from its cached view

  const listed = await daemon.list('inbox', {});
  assert.equal(listed.messages[0].read, true, 'read mark must survive');
  assert.equal(listed.messages[0].delivery.state, 'dropped', 'delivery written by the other process must survive');
});
test('state: markRead reporting reflects the mark that was just applied', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'state-b' });
  t.after(() => node.close());
  for (const id of ["m1", "m2"]) {
    await node.store.append('inbox', { id, ts: new Date().toISOString(), from: { name: 'x' }, to: 'state-b', subject: id, body: 'b', attachments: [] });
  }

  const before = await node.ops.inbox({});
  assert.equal(before.unread, 2);

  const marked = await node.ops.inbox({ markRead: true });
  assert.equal(marked.unread, 0, 'the summary must not still say unread');
  assert.ok(marked.messages.every((m) => m.read === true), 'returned messages must carry the new read flag');

  const after = await node.ops.inbox({});
  assert.equal(after.unread, 0);
});
