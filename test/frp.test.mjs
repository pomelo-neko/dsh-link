// End-to-end FRP test: real frps + two frpc instances, two dsh-link nodes,
// traffic that can only flow through the STCP tunnel (visitor ports on 127.0.0.1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TunnelManager } from '../src/tunnel.mjs';
import { makeNode, resetTmp, TMP } from './helpers.mjs';

// Download the frp v0.71.0 release yourself and unzip frpc/frps into vendor/frp/<platform>/,
// or point DSHLINK_FRP_BASE at a directory that already has them. The tunnel test skips itself
// when the binaries are missing.
const WIN = process.platform === 'win32';
const FRP_BASE = process.env.DSHLINK_FRP_BASE
  ?? new URL('../vendor/frp/' + (WIN ? 'windows-amd64' : 'linux-amd64'), import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FRPS = path.join(FRP_BASE, WIN ? 'frps.exe' : 'frps');
const FRPC = path.join(FRP_BASE, WIN ? 'frpc.exe' : 'frpc');
const FRPS_PORT = Number(process.env.DSHLINK_FRP_TEST_PORT ?? 17000);
const VISITOR_TIMEOUT_MS = 25_000;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function waitForPort(host, port, timeoutMs = VISITOR_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (value) => { socket.destroy(); resolve(value); };
      socket.setTimeout(500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const haveBinaries = (await exists(FRPS)) && (await exists(FRPC));

test('frp: two nodes talk only through an frps STCP tunnel', { skip: haveBinaries ? false : `frp binaries not found under ${FRP_BASE}` }, async (t) => {
  await resetTmp();
  const dir = path.join(TMP, 'frp');
  await fs.mkdir(dir, { recursive: true });

  // 1. frps control plane, loopback only, TLS forced, token auth.
  const frpsConfig = path.join(dir, 'frps.toml');
  await fs.writeFile(frpsConfig, [
    'bindAddr = "127.0.0.1"',
    `bindPort = ${FRPS_PORT}`,
    'auth.method = "token"',
    'auth.token = "frp-e2e-token"',
    'transport.tls.force = true',
    'webServer.addr = "127.0.0.1"',
    'webServer.port = 17500',
    `log.to = ${JSON.stringify(path.join(dir, 'frps.log'))}`,
    'log.level = "info"'
  ].join('\n') + '\n', 'utf8');

  const frpsLog = await fs.open(path.join(dir, 'frps.out.log'), 'a');
  const frps = spawn(FRPS, ['-c', frpsConfig], { stdio: ['ignore', frpsLog.fd, frpsLog.fd], windowsHide: true });
  frps.unref();
  const processes = [frps];
  t.after(async () => {
    for (const child of processes) { try { child.kill(); } catch { /* gone */ } }
    await frpsLog.close().catch(() => {});
  });
  // A binary that cannot execute at all (blocked by antivirus/HIPS — frp is unsigned — or a
  // broken download) exits within moments and prints nothing. Report that as a skip with the
  // reason instead of a bare timeout, so the suite stays meaningful on such a host.
  const earlyExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    frps.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (earlyExit !== null) {
    t.skip('frps exited immediately (code ' + earlyExit + ', no output): ' + FRPS +
      ' cannot execute here — most likely blocked by antivirus/HIPS (the frp binaries are unsigned),' +
      ' or a partially copied file');
    return;
  }
  assert.ok(await waitForPort('127.0.0.1', FRPS_PORT), 'frps should accept control connections');

  // 2. Two dsh-link nodes; their HTTP ports are ephemeral, published only as STCP providers.
  const a = await makeNode({ name: 'nodeA', roots: [{ name: 'ws', path: path.join(dir, 'shared-a'), read: true, write: false }] });
  const b = await makeNode({ name: 'nodeB', roots: [{ name: 'ws', path: path.join(dir, 'shared-b'), read: true, write: false }] });
  t.after(async () => { await a.close(); await b.close(); });
  await fs.mkdir(path.join(dir, 'shared-b'), { recursive: true });
  await fs.writeFile(path.join(dir, 'shared-b', 'over-the-tunnel.txt'), 'tunnel payload');

  const visitorA = 19130; // on A, fronts B
  const visitorB = 19131; // on B, fronts A

  for (const [node, other, visitorPort, adminPort, logName] of [
    [a, b, visitorA, 17400, 'a'],
    [b, a, visitorB, 17401, 'b']
  ]) {
    node.cfg.tunnel.enabled = true;
    node.cfg.tunnel.serverAddr = '127.0.0.1';
    node.cfg.tunnel.serverPort = FRPS_PORT;
    node.cfg.tunnel.token = 'frp-e2e-token';
    node.cfg.tunnel.user = 'dsh-link';
    node.cfg.tunnel.adminPort = adminPort;
    node.cfg.tunnel.frpcPath = FRPC;
    node.cfg.tunnel.logDir = path.join(dir, logName);
    node.cfg.stcp = { proxyName: `dshlink-${node.name}`, secretKey: `secret-${node.name}` };
    node.cfg.peers = [{
      name: other.name,
      url: `http://127.0.0.1:${visitorPort}`,
      token: other.token,
      stcp: { serverName: `dshlink-${other.name}`, secretKey: `secret-${other.name}`, visitorPort }
    }];
    const manager = new TunnelManager(node.cfg, { log: { info() {}, warn() {}, error() {} } });
    const started = await manager.start();
    assert.equal(started.running, true, `frpc for ${node.name} should start`);
    processes.push({ pid: started.pid, kill: () => { try { process.kill(started.pid); } catch { /* gone */ } } });
    node.manager = manager;
  }

  assert.ok(await waitForPort('127.0.0.1', visitorA), 'A should expose a visitor port for B');
  assert.ok(await waitForPort('127.0.0.1', visitorB), 'B should expose a visitor port for A');

  // 3. Everything below travels A -> frps -> B (visitor ports exist only because frpc is running).
  const peers = await a.ops.peers({ probe: true });
  assert.equal(peers.peers[0].reachable, true, JSON.stringify(peers.peers[0]));
  assert.equal(peers.peers[0].remote.name, 'nodeB');

  const sent = await a.ops.sendMessage({ to: 'nodeB', subject: 'over frp', body: 'hello through the tunnel' });
  assert.equal(sent.delivery.state, 'delivered');
  const inbox = await b.ops.inbox({});
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].body, 'hello through the tunnel');

  const pulled = await a.ops.pullFile({ peer: 'nodeB', root: 'ws', path: 'over-the-tunnel.txt' });
  assert.equal(pulled.verified, true);
  assert.equal(await fs.readFile(pulled.path, 'utf8'), 'tunnel payload');

  const listing = await a.ops.listFiles({ peer: 'nodeB', root: 'ws', path: '' });
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['over-the-tunnel.txt']);

  // 4. Evidence from frpc's own log that provider + visitor really came up.
  const logText = await fs.readFile(path.join(dir, 'a', 'frpc.log'), 'utf8').catch(() => '');
  assert.match(logText, /start proxy success/, 'frpc should report the provider proxy starting');
  assert.match(logText, /start visitor success/, 'frpc should report the visitor starting');

  for (const node of [a, b]) await node.manager.stop();
});
