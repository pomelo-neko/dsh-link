import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { PROJECT_DIR, TMP, resetTmp } from './helpers.mjs';

// Regression for 0.6.2: the CLI's serve command must hand a changed capability allowlist to the
// command queue on hot reload. Before the fix the reload callback referenced an out-of-scope
// `commands`, so /api/v1/info showed the new methods while the queue kept refusing them
// ("capability ... refused: method_not_allowed").

const CLI = path.join(PROJECT_DIR, 'bin', 'dshlink.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('reload: the CLI applies a capability allowlist change to the command queue', async (t) => {
  await resetTmp();
  const dir = path.join(TMP, 'cli-reload');
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, 'dshlink.config.json');
  const port = await freePort();
  await fs.writeFile(configPath, JSON.stringify({
    name: 'cli-reload',
    bind: '127.0.0.1',
    port,
    dataDir: dir,
    auth: { trustLocalhost: true, tokens: [] },
    files: { roots: [{ name: 'ws', path: dir, read: true, write: false }] },
    capabilities: { enabled: true, methods: [] },
    dsh: { enabled: false },
    tunnel: { enabled: false },
    peers: []
  }, null, 2) + '\n', 'utf8');

  const child = spawn(process.execPath, [CLI, 'serve', '--config', configPath], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });

  let baseUrl = null;
  const startDeadline = Date.now() + 15000;
  while (Date.now() < startDeadline) {
    const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) { baseUrl = match[1]; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(baseUrl, 'the CLI node did not start:\n' + output);

  const call = async (method) => {
    const response = await fetch(baseUrl + '/api/v1/dsh/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params: {}, waitSeconds: 0 })
    });
    return { status: response.status, body: await response.json() };
  };

  const before = await call('sessions.list');
  assert.equal(before.status, 403, JSON.stringify(before.body));
  assert.match(String(before.body.error?.code ?? before.body.code), /^(capability_denied|method_not_allowed)$/);

  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  raw.capabilities.methods = ['sessions.list'];
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');

  let reloads = 0;
  const reloadDeadline = Date.now() + 10000;
  while (Date.now() < reloadDeadline) {
    const status = await fetch(baseUrl + '/api/v1/status').then((r) => r.json()).catch(() => null);
    reloads = status?.runtime?.configReloads ?? 0;
    if (reloads >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(reloads >= 1, 'the config did not reload:\n' + output);

  const after = await call('sessions.list');
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.status, 'pending', JSON.stringify(after.body));
  assert.ok(after.body.commandId, JSON.stringify(after.body));
});
