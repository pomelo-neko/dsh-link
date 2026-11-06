import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { TMP } from './helpers.mjs';
import { findOpenssl } from '../src/phoneca.mjs';
import { decodePhoneBootstrap } from '../src/phonebootstrap.mjs';

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const OPENSSL = findOpenssl();
const SKIP = OPENSSL ? false : 'openssl was not found; set DSHLINK_OPENSSL or install OpenSSL';
const PROJECT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CLI = path.join(PROJECT, 'bin', 'dshlink.mjs');

function run(args) {
  const out = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJECT, encoding: 'utf8', timeout: 60000 });
  if (out.status !== 0) throw new Error('CLI failed: ' + args.join(' ') + '\n' + (out.stderr || out.stdout));
  const text = String(out.stdout ?? '').trim();
  // --json writes one JSON document; stderr carries the CA generation notice.
  return { json: JSON.parse(text), stderr: String(out.stderr ?? '') };
}

test('CLI: hub phone setup/bootstrap/devices/status round-trip', SKIP, async () => {
  const dir = path.join(TMP, 'cli-phone-' + process.pid);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  try {
    const init = run(['hub', 'init', '--data-dir', dir, '--name', 'CLI-PHONE-HUB', '--port', '18893', '--json']).json;
    assert.match(init.adminToken, /^[A-Za-z0-9_-]+$/);
    assert.equal(init.name, 'CLI-PHONE-HUB');

    const setup = run(['hub', 'phone', 'setup', '--data-dir', dir, '--no-tunnel', '--json']).json;
    assert.equal(setup.gateway.enabled, true);
    assert.match(setup.gateway.caFingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(setup.gateway.url, 'https://127.0.0.1:8791');
    assert.ok(setup.hubToken.token.startsWith('tok_') === false);
    assert.equal(setup.hubToken.token.length > 20, true);

    const codeFile = path.join(dir, 'phone.code');
    const boot = run(['hub', 'phone', 'bootstrap', '--data-dir', dir, '--label', 'pixel-cli', '--ttl-hours', '1', '--no-tunnel', '--url', 'https://127.0.0.1:8791', '--out', codeFile, '--json']).json;
    assert.match(boot.code, /^dshlink2:/);
    assert.equal(boot.summary.label, 'pixel-cli');
    assert.equal(boot.summary.hasTunnel, false);
    assert.equal(JSON.stringify(boot.summary).includes('pbs_'), false);
    const stored = (await fs.readFile(codeFile, 'utf8')).trim();
    assert.equal(stored, boot.code);
    const decoded = decodePhoneBootstrap(boot.code);
    assert.equal(decoded.bootstrap.id, boot.bootstrapId);
    assert.equal(decoded.entry.url, 'https://127.0.0.1:8791');
    assert.equal(decoded.gateway.caFingerprint, setup.gateway.caFingerprint);

    const devices = run(['hub', 'phone', 'devices', '--data-dir', dir, '--json']).json;
    assert.equal(devices.count, 0);
    assert.deepEqual(devices.devices, []);

    const status = run(['hub', 'phone', 'status', '--data-dir', dir, '--json']).json;
    assert.equal(status.gateway.enabled, true);
    assert.equal(status.gateway.hubTokenSet, true);
    assert.equal(status.gateway.bootstraps.active, 1);
    assert.equal(status.phoneFrp.enabled, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
