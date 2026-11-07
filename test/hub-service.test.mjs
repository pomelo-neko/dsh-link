import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PROJECT_DIR } from './helpers.mjs';

const isWindows = process.platform === 'win32';
const scriptsDir = path.join(PROJECT_DIR, 'scripts');
const SERVICE = path.join(scriptsDir, 'hub-service.ps1');
const DAEMON = path.join(scriptsDir, 'hub-daemon.ps1');
const LIB = path.join(scriptsDir, 'hub-service-lib.ps1');
const VBS = path.join(scriptsDir, 'hub-daemon.vbs');
const NODE_SCRIPT = path.join(scriptsDir, 'start-dshlink.ps1');

test('hub service: scripts are present and machine-neutral', async () => {
  for (const file of [SERVICE, DAEMON, LIB, VBS]) {
    await fs.access(file);
  }
  // The service scripts ship in the public repository: no host names, user paths, fixed IPs,
  // tokens or site-specific data directories may creep into them.
  const forbidden = [
    /DESKTOP-[A-Z0-9]+/i,
    /LAPTOP-[A-Z0-9]+/i,
    /C:\\\\Users\\\\/i,
    /\b192\.168\.\d+\.\d+\b/,
    /\b10\.\d+\.\d+\.\d+\b/,
    /\btok_[A-Za-z0-9_]+/,
    /dshlink-frp/i
  ];
  for (const file of [SERVICE, DAEMON, LIB]) {
    const text = await fs.readFile(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(text, pattern, path.relative(PROJECT_DIR, file) + ' must not contain machine-specific data');
    }
  }
  // wscript also runs the .vbs from systems with a legacy ANSI code page: keep it ASCII only.
  const vbs = await fs.readFile(VBS, 'utf8');
  for (const char of vbs) {
    assert.ok(char.charCodeAt(0) < 128, 'hub-daemon.vbs must stay ASCII-only');
  }
  assert.match(vbs, /hub-daemon\.ps1/);
  assert.match(vbs, /WScript\.Shell/);
});

test('hub service: auto-start is a logon task running the hidden VBS daemon launcher', async () => {
  const service = await fs.readFile(SERVICE, 'utf8');
  assert.match(service, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(service, /hub-daemon\.vbs/);
  assert.match(service, /Register-ScheduledTask/);
  // stop must disable the task, otherwise the periodic top-up brings the hub back within 15 min.
  assert.match(service, /function Stop-HubService[\s\S]{0,900}Disable-HubTask/);
  assert.match(service, /Remove-Item|Unregister-HubTask/);
});

test('node autostart: only an frpc with the same config counts as "already running"', async () => {
  const text = await fs.readFile(NODE_SCRIPT, 'utf8');
  assert.doesNotMatch(text, /Get-Process\s+frpc\b/, 'bare Get-Process frpc would mistake a hub frpc for the node tunnel');
  assert.match(text, /Get-CimInstance Win32_Process/);
  assert.match(text, /CommandLine/);
});

const runPowershell = (args, options = {}) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    ...options
  });
  return result;
};

test('hub service: PowerShell 5.1 parses all service scripts', { skip: !isWindows }, () => {
  const files = [SERVICE, DAEMON, LIB, NODE_SCRIPT];
  const command = files.map((file) => {
    const quoted = file.replace(/'/g, "''");
    return "$tokens = $null; $parseErrors = $null; " +
      "[System.Management.Automation.Language.Parser]::ParseFile('" + quoted + "',[ref]$tokens,[ref]$parseErrors) | Out-Null; " +
      "if ($parseErrors.Count -gt 0) { $parseErrors | ForEach-Object { Write-Output $_.Message }; exit 1 }";
  }).join('; ');
  const result = runPowershell(['-Command', command]);
  assert.equal(result.status, 0, String(result.stdout || '') + String(result.stderr || ''));
});

test('hub service: status -Json works with a temp config and no installed task', { skip: !isWindows }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dshlink-hub-test-'));
  try {
    const config = { name: 'status-test-hub', bind: '127.0.0.1', port: 39999 };
    await fs.writeFile(path.join(dataDir, 'dshlink-hub.config.json'), JSON.stringify(config), 'utf8');
    const result = runPowershell([
      '-File', SERVICE, 'status',
      '-InstallDir', PROJECT_DIR,
      '-DataDir', dataDir,
      '-TaskName', 'dshlink-hub-service-test-none',
      '-Json'
    ]);
    assert.equal(result.status, 0, String(result.stdout || '') + String(result.stderr || ''));
    const start = result.stdout.indexOf('{');
    assert.ok(start >= 0, 'status -Json must print a JSON object: ' + result.stdout);
    const status = JSON.parse(result.stdout.slice(start));
    assert.equal(status.hubPort, 39999);
    assert.equal(status.hubHealthy, false);
    assert.equal(status.daemonRunning, false);
    assert.equal(status.taskInstalled, false);
    assert.equal(status.installDir, PROJECT_DIR);
    assert.equal(status.dataDir, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
