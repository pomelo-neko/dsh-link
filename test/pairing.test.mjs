import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { applyDshInstall, buildInvite, decodeInvite, encodeInvite, peerEntryFromInvite, planDshInstall, upsertPeer } from '../src/pairing.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { TunnelManager, visitorsFor } from '../src/tunnel.mjs';
import { normalizeConfig } from '../src/config.mjs';
import { makeNode, PROJECT_DIR, resetTmp, TMP } from './helpers.mjs';

function cfgWithTunnel(overrides = {}) {
  const dataDir = overrides.dataDir ?? path.join(TMP, 'pairing-node');
  const cfg = normalizeConfig({
    name: overrides.name ?? 'pairNode',
    dataDir,
    port: overrides.port ?? 18801,
    bind: '127.0.0.1',
    stcp: { proxyName: 'dshlink-pairNode', secretKey: 'stcp-secret' },
    tunnel: { enabled: true, serverAddr: 'frps.example.net', serverPort: 7000, token: 'frp-token', ...(overrides.tunnel ?? {}) },
    peers: overrides.peers ?? []
  }, dataDir);
  cfg.configPath = path.join(dataDir, 'dshlink.config.json');
  return cfg;
}

test('invite: round-trips name, urls, token and stcp share', async () => {
  await resetTmp();
  const cfg = cfgWithTunnel();
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const { code, invite } = buildInvite(cfg, { url: 'http://10.0.0.5:8787/' });
  assert.match(code, /^dshlink1:/);
  assert.equal(cfg.auth.tokens.length, 1, 'invite mints an inbound token for the peer');

  const decoded = decodeInvite(code);
  assert.equal(decoded.name, 'pairNode');
  assert.deepEqual(decoded.urls, ['http://10.0.0.5:8787', 'http://127.0.0.1:18801']);
  assert.equal(decoded.token, invite.token);
  assert.equal(decoded.stcp.proxyName, 'dshlink-pairNode');
  assert.equal(decoded.stcp.serverAddr, 'frps.example.net');

  const bare = decodeInvite(Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url'));
  assert.equal(bare.name, 'pairNode', 'the prefix is optional');

  assert.throws(() => decodeInvite('dshlink1:not-json'), /not valid dsh-link invite/);
  assert.throws(() => decodeInvite(encodeInvite({ kind: 'other', v: 1, name: 'x' })), /not a dsh-link invite/);
  assert.throws(() => decodeInvite(encodeInvite({ kind: 'dshlink-invite', v: 9, name: 'x' })), /unsupported invite version/);
  assert.throws(
    () => decodeInvite(encodeInvite({ kind: 'dshlink-invite', v: 1, name: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() })),
    (err) => err.code === 'invite_expired'
  );
});

test('accept: builds a visitor on one frps, falls back to a URL when the frps differs', async () => {
  await resetTmp();
  const local = cfgWithTunnel();
  await fs.mkdir(local.dataDir, { recursive: true });
  const { code } = buildInvite(cfgWithTunnel({ name: 'remoteNode' }), { withToken: true });
  const invite = decodeInvite(code);

  const same = peerEntryFromInvite(local, invite, {});
  assert.equal(same.usedStcp, true);
  assert.equal(same.entry.url, `http://127.0.0.1:${same.entry.stcp.visitorPort}`);
  assert.equal(same.entry.token, invite.token);
  assert.deepEqual(same.warnings, []);

  const otherFrps = cfgWithTunnel({ name: 'otherNode', dataDir: path.join(TMP, 'pairing-other'), tunnel: { serverAddr: 'elsewhere.example.net' } });
  const fallback = peerEntryFromInvite(otherFrps, invite, {});
  assert.equal(fallback.usedStcp, false);
  assert.equal(fallback.entry.url, invite.urls[0]);
  assert.match(fallback.warnings.join(' '), /visitors only work inside one frps/);

  const noTunnel = cfgWithTunnel({ name: 'plainNode', dataDir: path.join(TMP, 'pairing-plain'), tunnel: { enabled: false } });
  const plain = peerEntryFromInvite(noTunnel, invite, {});
  assert.equal(plain.entry.url, invite.urls[0]);
  assert.match(plain.warnings.join(' '), /no tunnel configured/);

  const anonymous = peerEntryFromInvite(local, decodeInvite(buildInvite(cfgWithTunnel({ name: 'anonNode', dataDir: path.join(TMP, 'pairing-anon') }), { withToken: false }).code), {});
  assert.match(anonymous.warnings.join(' '), /carried no token/);

  assert.equal(upsertPeer(local, same.entry).action, 'added');
  const updated = upsertPeer(local, { ...same.entry, note: 'changed' });
  assert.equal(updated.action, 'updated');
  assert.equal(local.peers.length, 1);
});

test('install-dsh: plans, validates, backs up and is idempotent', async () => {
  await resetTmp();
  const dshHome = path.join(TMP, 'fake-dsh');
  const profileDir = path.join(dshHome, 'profiles', 'web');
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), '# comment only\n[]\n', 'utf8');

  const plan = await planDshInstall({ dshHome, profile: 'web', url: 'http://127.0.0.1:8787/mcp', projectDir: PROJECT_DIR });
  assert.equal(plan.patchMode, 'replace-empty');
  assert.match(plan.patchContent, /id: mcp-dshlink/);
  assert.match(plan.patchContent, /url: http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(plan.patchContent, /^# comment only/m, 'existing comments survive');
  assert.equal(plan.skill.action, 'install');

  const dry = await applyDshInstall(plan, { dryRun: true });
  assert.equal(dry.written, false);
  assert.match(await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), /^\s*\[\]\s*$/m, 'dry run must not touch the file');

  const applied = await applyDshInstall(plan, { dryRun: false });
  assert.equal(applied.written, true);
  assert.equal(applied.skillWritten, true);
  assert.ok(applied.backupPath && await fs.readFile(applied.backupPath, 'utf8').then((t) => t.includes('[]')));
  const written = await fs.readFile(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(written, /dsh-mcp-client/);
  assert.match(await fs.readFile(path.join(dshHome, 'skills', 'dshlink', 'SKILL.md'), 'utf8'), /dsh-link/);

  const again = await planDshInstall({ dshHome, profile: 'web', url: 'http://127.0.0.1:8787/mcp', projectDir: PROJECT_DIR });
  assert.equal(again.patchMode, 'unchanged');
  assert.equal(again.skill.action, 'unchanged');

  const moved = await planDshInstall({ dshHome, profile: 'web', url: 'http://127.0.0.1:9999/mcp', projectDir: PROJECT_DIR });
  assert.equal(moved.patchMode, 'update-url');
  assert.match(moved.patchContent, /127\.0\.0\.1:9999/);

  const appended = await planDshInstall({ dshHome: path.join(TMP, 'no-dsh'), profile: 'web', projectDir: PROJECT_DIR });
  assert.equal(appended.patchMode, 'create');
  assert.equal(appended.skill.action, 'install');
});

test('doctor: reports config, http, mcp and peers for a live node', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'docNode', roots: [{ name: 'ws', path: PROJECT_DIR, read: true, write: false }] });
  const dead = await makeNode({ name: 'deadNode' });
  t.after(async () => { await node.close(); await dead.close(); });
  node.connectTo(dead);
  await dead.close();

  const report = await runDoctor({ cfg: node.cfg, store: node.store, roots: node.roots, ops: node.ops, token: node.token });
  const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
  assert.equal(byName.config.status, 'pass');
  assert.equal(byName['data-dir'].status, 'pass');
  assert.equal(byName['root:ws'].status, 'pass');
  assert.equal(byName.http.status, 'pass');
  assert.equal(byName.mcp.status, 'pass', JSON.stringify(byName.mcp));
  assert.match(byName.mcp.detail, /initialize ok/);
  assert.equal(byName['peer:deadNode'].status, 'warn', 'unreachable peers warn, they do not fail the run');
  assert.equal(byName.tunnel.status, 'pass');
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
});

test('doctor: fails when the node does not answer and its port is occupied', async (t) => {
  await resetTmp();
  const node = await makeNode({ name: 'notRunning' });
  t.after(() => node.close());
  // Simulate "nothing answers on my advertised URL" without opening a second socket:
  // cfg.port is the live listener, so the port-availability probe still sees it taken.
  const stubbedOps = { ...node.ops, localUrl: () => 'http://127.0.0.1:1' };

  const report = await runDoctor({ cfg: node.cfg, store: node.store, roots: node.roots, ops: stubbedOps });
  const http = report.checks.find((check) => check.name === 'http');
  assert.equal(http.status, 'fail');
  assert.match(http.detail, /port .* is taken/);
  assert.equal(report.checks.find((check) => check.name === 'mcp').status, 'warn');
  assert.equal(report.ok, false);
});

test('tunnel: occupied visitor ports are moved before frpc starts', async () => {
  await resetTmp();
  const cfg = cfgWithTunnel({
    peers: [{ name: 'peerB', stcp: { serverName: 'dshlink-peerB', secretKey: 's', visitorPort: 19500 } }]
  });
  await fs.mkdir(cfg.dataDir, { recursive: true });
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(19500, '127.0.0.1', resolve));
  try {
    const manager = new TunnelManager(cfg, { log: { info() {}, warn() {}, error() {} }, spawnImpl: () => { throw new Error('must not spawn'); } });
    const moved = await manager.ensureVisitorPorts();
    assert.deepEqual(moved, [{ peer: 'peerB', from: 19500, to: 19501 }]);
    assert.equal(cfg.peers[0].stcp.visitorPort, 19501);
    assert.equal(cfg.peers[0].url, 'http://127.0.0.1:19501');
    assert.equal(manager.dirty, true);
    assert.equal(visitorsFor(cfg)[0].bindPort, 19501);
    assert.deepEqual(await manager.ensureVisitorPorts(), [], 'second pass is a no-op');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
