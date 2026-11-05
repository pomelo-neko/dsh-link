import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { PROJECT_DIR, TMP, resetTmp } from './helpers.mjs';

// Regression for 0.9.1: one-shot CLI commands create a HubLink but never start it, so a node that
// was actually online showed `hub state disabled` in `dshlink status`. The CLI must label the
// value as a snapshot instead of reporting a phantom outage.

const CLI = path.join(PROJECT_DIR, 'bin', 'dshlink.mjs');

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: PROJECT_DIR, encoding: 'utf8', windowsHide: true, timeout: 20000
  });
  assert.equal(result.status, 0, 'CLI failed: ' + (result.stderr || result.stdout));
  return result;
}

async function writeConfig(dir, hub) {
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'dshlink.config.json');
  await fs.writeFile(configPath, JSON.stringify({
    name: 'cli-status',
    bind: '127.0.0.1',
    port: 18797,
    dataDir: dir,
    auth: { trustLocalhost: true, tokens: [] },
    files: { roots: [{ name: 'ws', path: dir, read: true, write: false }] },
    capabilities: { enabled: false, methods: [] },
    dsh: { enabled: false },
    tunnel: { enabled: false },
    hub,
    peers: []
  }, null, 2) + '\n', 'utf8');
  return configPath;
}

test('CLI status labels an unstarted hub uplink as an unknown snapshot', async () => {
  await resetTmp();
  const dir = path.join(TMP, 'cli-status');
  const configPath = await writeConfig(dir, {
    enabled: true, url: 'http://127.0.0.1:18790', token: 'hub-token-for-the-cli-test',
    enrolled: { hubName: 'CLI-HUB', nodeName: 'cli-status' }
  });
  const { stdout } = runCli(['status', '--config', configPath, '--json']);
  const status = JSON.parse(stdout);
  assert.equal(status.hub.enabled, true);
  assert.equal(status.hub.state, 'unknown');
  assert.equal(status.hub.snapshot, true);
  assert.match(status.hub.note, /CLI snapshot/);
  assert.equal(status.hub.enrolled.hubName, 'CLI-HUB');

  const human = runCli(['status', '--config', configPath]).stdout;
  assert.match(human, /hub\s+enrolled CLI-HUB \(state unknown from this CLI snapshot; see the running node\)/);
});

test('CLI hub status --node labels the same snapshot', async () => {
  await resetTmp();
  const dir = path.join(TMP, 'cli-hub-status');
  const configPath = await writeConfig(dir, {
    enabled: true, url: 'http://127.0.0.1:18790', token: 'hub-token-for-the-cli-test',
    enrolled: { hubName: 'CLI-HUB', nodeName: 'cli-status' }
  });
  const { stdout } = runCli(['hub', 'status', '--node', '--config', configPath, '--json']);
  const status = JSON.parse(stdout);
  assert.equal(status.enabled, true);
  assert.equal(status.state, 'unknown');
  assert.equal(status.snapshot, true);
  assert.match(status.note, /CLI snapshot/);
});

test('CLI status keeps disabled honest when hub mode is off', async () => {
  await resetTmp();
  const dir = path.join(TMP, 'cli-status-off');
  const configPath = await writeConfig(dir, { enabled: false });
  const { stdout } = runCli(['status', '--config', configPath, '--json']);
  const status = JSON.parse(stdout);
  assert.equal(status.hub.enabled, false);
  assert.equal(status.hub.state, 'disabled');
  assert.equal(status.hub.snapshot, undefined);
});
