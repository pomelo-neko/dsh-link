import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allocateVisitorPort, findFrpc, frpConfigToml, parseFrpcTomlSummary, TunnelManager, visitorsFor } from '../src/tunnel.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { TMP, resetTmp } from './helpers.mjs';

function cfgFor(overrides = {}) {
  const dataDir = overrides.dataDir ?? path.join(TMP, 'tunnel-node');
  const cfg = normalizeConfig({
    name: overrides.name ?? 'tunnelNode',
    dataDir,
    port: overrides.port ?? 18787,
    bind: '127.0.0.1',
    stcp: { proxyName: 'dshlink-tunnelNode', secretKey: 'stcp-secret-abc' },
    tunnel: { enabled: true, serverAddr: 'frps.example.net', serverPort: 7000, token: 'frp-token', user: 'team', adminPort: 7400, logDir: path.join(dataDir, 'frp'), ...(overrides.tunnel ?? {}) },
    peers: overrides.peers ?? [
      { name: 'peerB', stcp: { serverName: 'dshlink-peerB', secretKey: 'secret-b', visitorPort: 19101 } },
      { name: 'peerC', url: 'http://10.0.0.9:8787', token: 't' }
    ]
  }, dataDir);
  cfg.configPath = path.join(dataDir, 'dshlink.config.json');
  return cfg;
}

test('tunnel: generated frpc.toml exposes the local API and binds visitor ports', async () => {
  await resetTmp();
  const cfg = cfgFor();
  const toml = frpConfigToml(cfg);
  const summary = parseFrpcTomlSummary(toml);
  assert.equal(summary.serverAddr, 'frps.example.net');
  assert.equal(summary.serverPort, '7000');
  assert.equal(summary.user, 'team');
  assert.equal(summary.proxies.length, 1);
  assert.equal(summary.proxies[0].name, 'dshlink-tunnelNode');
  assert.equal(summary.proxies[0].type, 'stcp');
  assert.equal(summary.proxies[0].localPort, '18787', 'provider must point at this node\'s API port');
  assert.equal(summary.visitors.length, 1, 'only peers with stcp details get a visitor');
  assert.equal(summary.visitors[0].serverName, 'dshlink-peerB');
  assert.equal(summary.visitors[0].bindPort, '19101');
  assert.ok(!toml.includes('peerC'), 'direct peers need no visitor');
  assert.match(toml, /auth\.token = "frp-token"/);
  assert.match(toml, /transport\.tls\.enable = true/);

  const incomplete = cfgFor({ tunnel: { serverAddr: null } });
  assert.throws(() => frpConfigToml(incomplete), /serverAddr/);
});

test('tunnel: visitor port allocation picks the lowest free port', async () => {
  await resetTmp();
  const cfg = cfgFor();
  assert.equal(allocateVisitorPort(cfg), 19100, 'base is free');
  assert.equal(allocateVisitorPort(cfg, { used: [19100, 19101] }), 19102);
  const collides = cfgFor({ name: 'portClash', dataDir: path.join(TMP, 'port-clash'), port: 19100, peers: [] });
  assert.equal(allocateVisitorPort(collides), 19101, 'never reuse this node\'s own API port');
  assert.equal(visitorsFor(cfg).length, 1);
});

test('tunnel: manager writes config, starts a detached process and stops it', async (t) => {
  await resetTmp();
  const cfg = cfgFor();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const children = [];
  const spawnImpl = (command, args, options) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true, windowsHide: true });
    child.unref();
    children.push(child);
    assert.deepEqual(args, ['-c', path.join(cfg.tunnel.logDir, 'frpc.toml')]);
    assert.equal(options.stdio[0], 'ignore');
    return child;
  };
  const manager = new TunnelManager(cfg, { log: { info() {}, warn() {}, error() {} }, spawnImpl });
  cfg.tunnel.frpcPath = process.execPath;

  const started = await manager.start();
  assert.equal(started.running, true);
  assert.ok(started.pid > 0);
  assert.ok(await fs.readFile(manager.configPath, 'utf8').then((text) => text.includes('dshlink-tunnelNode')));

  const status = await manager.status();
  assert.equal(status.running, true);
  assert.equal(status.pid, started.pid);
  assert.equal(status.visitors.length, 1);

  t.after(async () => { for (const child of children) { try { child.kill(); } catch { /* already gone */ } } });
  const stopped = await manager.stop();
  assert.equal(stopped.stopped, true);
  assert.equal((await manager.status()).running, false);
});

test('tunnel: a disabled tunnel refuses to start', async () => {
  await resetTmp();
  const cfg = cfgFor({ tunnel: { enabled: false } });
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const manager = new TunnelManager(cfg, { log: { info() {}, warn() {}, error() {} } });
  await assert.rejects(() => manager.start(), /disabled/);
  const relaunched = await manager.relaunch();
  assert.equal(relaunched.running, false);
  assert.match(relaunched.reason, /disabled/);
});

test('tunnel: findFrpc honours an explicit path', async () => {
  await resetTmp();
  const cfg = cfgFor({ tunnel: { frpcPath: process.execPath } });
  assert.equal(await findFrpc(cfg), process.execPath);
  const missing = cfgFor({ name: 'other', dataDir: path.join(TMP, 'no-frpc'), tunnel: { frpcPath: path.join(TMP, 'nope-frpc.exe') } });
  assert.equal(await findFrpc(missing), path.join(TMP, 'nope-frpc.exe'));
});
