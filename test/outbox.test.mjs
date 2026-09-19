import test from 'node:test';
import assert from 'node:assert/strict';
import { makeNode, resetTmp } from './helpers.mjs';

test('outbox: a stuck message can be dropped and is no longer retried', async (t) => {
  await resetTmp();
  const a = await makeNode({ name: 'queue-a' });
  t.after(() => a.close());
  a.connectTo({ name: 'ghost', url: 'http://127.0.0.1:9', token: 'nope' });

  const sent = await a.ops.sendMessage({ to: 'ghost', subject: 'stuck', body: 'hello' });
  assert.equal(sent.delivery.state, 'pending');
  assert.equal((await a.store.pendingOutbox()).length, 1);

  await assert.rejects(() => a.ops.dropOutbox({}), /pass --id/);

  const dropped = await a.ops.dropOutbox({ to: 'ghost' });
  assert.deepEqual(dropped.ids, [sent.message.id]);
  assert.equal(dropped.remaining, 0);
  assert.equal((await a.store.pendingOutbox()).length, 0);

  const flush = await a.ops.flush({});
  assert.equal(flush.attempted, 0, 'a dropped message must not be retried');

  const list = await a.store.list('outbox', {});
  assert.equal(list.messages[0].delivery.state, 'dropped');
  assert.equal((await a.store.stats()).outboxPending, 0, 'stats must agree with pendingOutbox');
});
