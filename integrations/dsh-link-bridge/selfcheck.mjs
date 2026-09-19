#!/usr/bin/env node
// dsh-link-bridge self-check: inject one unmistakable message into the local node and
// wait for the bridge to move its watermark past it. Exits 0 on success, 3 on timeout.
//
//   node integrations/dsh-link-bridge/selfcheck.mjs [--node http://127.0.0.1:8787] [--wait 60]
//
// The bridge writes $DSH_HOME/plugin-data/dsh-link-bridge/state.json; if that file never
// appears the plugin is not loaded (usually: host not restarted after installing the entry).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const args = parse(process.argv.slice(2));
const nodeUrl = String(args.node ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const waitSeconds = Number(args.wait ?? 60);
const stateDir = args['state-dir'] ?? path.join(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'), 'plugin-data', 'dsh-link-bridge');
const stateFile = path.join(stateDir, 'state.json');

const id = 'msg_selfcheck' + Date.now().toString(36);
const record = {
  id,
  ts: new Date().toISOString(),
  from: { nodeId: 'node_selfcheck', name: 'BRIDGE-SELFCHECK', url: 'http://127.0.0.1:9' },
  to: 'self',
  // A stable thread keeps every self-check in ONE topic session under 0.3 topic routing; a fresh
  // thread per run would open a new (otherwise useless) conversation each time.
  thread: 'selfcheck-bridge',
  replyTo: null,
  kind: 'message',
  subject: 'bridge 自检',
  body: [
    '这是一条 dsh-link-bridge 自检消息，用来确认「收到消息 → 自动唤醒对话」这条链路是通的。',
    '收到后请：1) 不要回复对端（BRIDGE-SELFCHECK 不存在）；',
    '2) 在回复中说明「bridge 自检通过」，并列出本机节点名、本条消息 id；',
    '3) 不要修改任何文件。'
  ].join('\n'),
  attachments: []
};

const posted = await fetch(nodeUrl + '/api/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(record)
});
if (!posted.ok) {
  console.error('could not inject the self-check message: HTTP ' + posted.status + ' — is the node running at ' + nodeUrl + '?');
  process.exit(2);
}
console.log('injected ' + id + ' into ' + nodeUrl);
console.log('waiting up to ' + waitSeconds + 's for ' + stateFile + ' to move past it…');

const deadline = Date.now() + waitSeconds * 1000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let state = null;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch { /* not written yet */ }
  // The bridge records a (timestamp, id) watermark; either signal means it handled this message.
  const handled = state && (state.watermark === id ||
    (typeof state.watermarkTs === 'string' && state.watermarkTs >= record.ts));
  if (handled) {
    console.log('PASS  bridge woke session ' + (state.sessionId || '(unknown)') + ' for ' + id);
    console.log('      ticks=' + state.ticks + ' notified=' + state.notified + ' errors=' + (state.errors ?? 0) + (state.lastError ? ' lastError=' + state.lastError : ''));
    console.log('      note: the woken conversation usually tries to reply to BRIDGE-SELFCHECK and queues it');
    console.log('            (that peer does not exist) — clear it with: dshlink outbox drop --to BRIDGE-SELFCHECK');
    process.exit(0);
  }
}
console.error('TIMEOUT  the bridge did not react. Most likely the plugin is not loaded:');
console.error('  - the profile patch needs the dsh-link-bridge insert (dshlink install-dsh --bridge … --write)');
console.error('  - a NEW plugin entry only loads at boot: stop the host and start it again');
console.error('  - check the host console for lines starting with "dsh-link-bridge"');
process.exit(3);
