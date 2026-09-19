// dsh-link: self-diagnostics (dshlink doctor).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DSHLINK_VERSION, LinkError, timeoutSignal } from './util.mjs';
import { findFrpc, visitorsFor } from './tunnel.mjs';
import { CAPABILITY_METHODS } from './capabilities.mjs';

const PASS = 'pass';
const WARN = 'warn';
const FAIL = 'fail';

async function portFree(bind, port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ free: false, code: err.code }));
    server.listen(port, bind === '0.0.0.0' ? '127.0.0.1' : bind, () => {
      server.close(() => resolve({ free: true }));
    });
  });
}

async function ownHealth(url) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: timeoutSignal(2500) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err.message };
  }
}

async function ownStatus(url) {
  try {
    const res = await fetch(`${url}/api/v1/status`, { signal: timeoutSignal(2500) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err.message };
  }
}

function safeUrl(value) {
  try { return new URL(String(value)); } catch { return null; }
}

async function mcpProbe(url, token) {
  try {
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dshlink-doctor', version: '1' } } }),
      signal: timeoutSignal(5000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const payload = await res.json();
    if (payload?.error) return { ok: false, error: payload.error.message };
    return { ok: true, protocolVersion: payload?.result?.protocolVersion, instructions: !!payload?.result?.instructions };
  } catch (err) {
    return { ok: false, error: err?.cause?.code ?? err.message };
  }
}

export async function runDoctor({ cfg, store, roots, ops, token } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  add('config', cfg?.name ? PASS : FAIL, cfg?.configPath ? `${path.basename(cfg.configPath)} (node "${cfg.name}")` : 'config not loaded');

  // data dir writable
  try {
    const probe = path.join(cfg.dataDir, `.doctor-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    add('data-dir', PASS, cfg.dataDir);
  } catch (err) {
    add('data-dir', FAIL, `not writable: ${err.message}`);
  }

  // roots
  const described = roots?.describe() ?? [];
  if (!described.length) add('file-roots', WARN, 'no shared roots configured — peers cannot read or write files');
  for (const root of described) {
    if (root.kind === 'workspaces') {
      // A virtual root has no path of its own: it resolves through the local workspace registry.
      try {
        const listed = await ops.dshWorkspaces({});
        add(`root:${root.name}`, PASS, `all ${listed.count} DSH workspace(s) (virtual root)`);
      } catch (err) {
        add(`root:${root.name}`, FAIL, `virtual workspaces root unavailable: ${err.message}`);
      }
      continue;
    }
    try {
      const stat = await fs.stat(root.path);
      if (!stat.isDirectory()) add(`root:${root.name}`, FAIL, `not a directory: ${root.path}`);
      else add(`root:${root.name}`, PASS, `${root.path} (${root.read ? 'read' : 'no-read'}${root.write ? ', write' : ''})`);
    } catch (err) {
      add(`root:${root.name}`, FAIL, `missing: ${root.path}`);
    }
  }

  const tokens = cfg.auth?.tokens ?? [];
  add('tokens', tokens.length ? PASS : (cfg.auth?.trustLocalhost ? WARN : FAIL), `${tokens.length} inbound token(s)${cfg.auth?.trustLocalhost ? ', localhost trusted' : ''}`);
  add('upload', cfg.files?.allowUpload ? WARN : PASS, cfg.files?.allowUpload ? 'peers may write into writable roots' : 'disabled (peers cannot push files)');

  // DSH view + capability channel (0.3): both are off by default, so say what is exposed.
  if (cfg.dsh?.enabled !== true) {
    add('dsh-view', PASS, 'disabled (enable with: dshlink dsh enable --write)');
  } else {
    // The home is cfg.home -> DSH_HOME -> ~/.dsh. A node started by a task/service has no
    // DSH_HOME, so an unpinned home can silently point at a different (older) DSH installation.
    const pinned = typeof cfg.dsh.home === 'string' && cfg.dsh.home.trim() !== '';
    try {
      const listed = await ops.dshWorkspaces({});
      const detail = `${listed.count} workspace(s) via ${listed.home ?? 'unknown home'}; transcripts ${cfg.dsh.exposeTranscripts === true ? 'readable' : 'hidden'}; home ${pinned ? 'pinned in the config' : 'auto-detected — pin dsh.home when this node is started by a task or service (its DSH_HOME may differ)'}`;
      add('dsh-view', pinned ? PASS : WARN, detail);
    } catch (err) {
      add('dsh-view', FAIL, err.message);
    }
  }
  if (cfg.capabilities?.enabled !== true) {
    add('capabilities', PASS, 'disabled (peers cannot drive this DSH)');
  } else {
    let bridge = null;
    try { bridge = await ops.bridgeStatus(); } catch { bridge = null; }
    const actions = cfg.capabilities.methods.filter((method) => CAPABILITY_METHODS[method]?.kind === 'action');
    const heartbeat = bridge?.bridge
      ? `bridge ${bridge.bridge.version ?? '?'} at ${bridge.bridge.at ?? '?'}${bridge.fresh ? '' : ' (STALE — restart the DSH host with the 0.3 bridge)'}`
      : 'no bridge heartbeat yet';
    add('capabilities', actions.length ? WARN : PASS, `${cfg.capabilities.methods.length} method(s)${actions.length ? `, actions: ${actions.join(', ')}` : ''}; ${heartbeat}`);
  }

  const localUrl = ops?.localUrl?.() ?? `http://127.0.0.1:${cfg.port}`;
  const health = await ownHealth(localUrl);
  if (health.ok) {
    add('http', PASS, `running at ${localUrl}`);
    const probe = await mcpProbe(localUrl, token);
    add('mcp', probe.ok ? PASS : FAIL, probe.ok ? `initialize ok (protocol ${probe.protocolVersion}, instructions ${probe.instructions ? 'yes' : 'no'})` : probe.error);

    // The running process may hold an older config than the file on disk (a long-standing
    // source of "the config looks right but sending says unknown peer" confusion).
    const live = await ownStatus(localUrl);
    if (!live.ok) {
      add('node:config', WARN, `running node did not answer ${localUrl}/api/v1/status (${live.error})`);
    } else {
      const diskPeers = (cfg.peers ?? []).map((p) => p.name).sort();
      const livePeers = (live.body.peers ?? []).map((p) => p.name).sort();
      const inSync = diskPeers.length === livePeers.length && diskPeers.every((name, index) => name === livePeers[index]);
      add('node:config', inSync ? PASS : FAIL, inSync
        ? `running process matches ${path.basename(cfg.configPath)} (${diskPeers.length} peer(s))`
        : `running process knows ${livePeers.length} peer(s) [${livePeers.join(', ') || 'none'}] but the config file has ${diskPeers.length} [${diskPeers.join(', ') || 'none'}] — restart the node so it reloads the file`);
      const liveVersion = live.body.node?.version ?? live.body.runtime?.version;
      if (liveVersion && liveVersion !== DSHLINK_VERSION) add('node:version', WARN, `process runs v${liveVersion}, code on disk is v${DSHLINK_VERSION} — restart the node to pick up the new build`);
      else if (liveVersion) add('node:version', PASS, `v${liveVersion}`);
      const reloads = live.body.runtime?.configReloads;
      if (typeof reloads === 'number') {
        add('node:hot-reload', PASS, `config file is watched (${reloads} reload(s) since start${live.body.runtime?.configLastError ? `; last error: ${live.body.runtime.configLastError}` : ''})`);
      } else if (live.body.runtime) {
        add('node:hot-reload', WARN, 'running node does not watch its config file — restart it after changing peers/tokens/roots');
      }
    }
  } else {
    const bind = await portFree(cfg.bind, cfg.port);
    add('http', bind.free ? WARN : FAIL, bind.free
      ? `not running (${health.error}); port ${cfg.bind}:${cfg.port} is free — start it with: dshlink serve`
      : `not answering and port ${cfg.port} is taken by another process`);
    add('mcp', WARN, 'skipped (no local server)');
  }

  const storeStats = store ? await store.stats() : null;
  add('mailbox', storeStats ? PASS : WARN, storeStats ? `inbox ${storeStats.inbox} (${storeStats.inboxUnread} unread), outbox ${storeStats.outbox} (${storeStats.outboxPending} pending)` : 'store unavailable');
  if (storeStats?.outboxPending) add('queue', WARN, `${storeStats.outboxPending} message(s) not delivered yet — dshlink flush`);

  const peers = cfg.peers ?? [];
  const tunnel = cfg.tunnel ?? {};
  if (!peers.length) add('peers', WARN, 'no peers configured — dshlink invite / peers accept');
  for (const peer of peers) {
    let reachable = false;
    try {
      const res = await fetch(`${peer.url}/healthz`, { signal: timeoutSignal(3000) });
      reachable = res.ok;
      add(`peer:${peer.name}`, res.ok ? PASS : WARN, res.ok ? peer.url : `HTTP ${res.status} at ${peer.url}`);
    } catch (err) {
      add(`peer:${peer.name}`, WARN, `unreachable at ${peer.url} (${err?.cause?.code ?? err.message})`);
    }
    // A loopback peer URL that is not this node's own port means something outside dsh-link
    // is forwarding the traffic (hand-written frpc, ssh -L, a WSL relay, ...).
    const target = safeUrl(peer.url);
    if (target && ['127.0.0.1', 'localhost', '::1'].includes(target.hostname) && Number(target.port) !== Number(cfg.port)) {
      add(`peer-route:${peer.name}`, reachable ? PASS : WARN, `forwarded through ${peer.url}${tunnel.enabled ? '' : ' by something outside dsh-link'} — make sure that forwarder survives a reboot (service / scheduled task), or switch to: dshlink tunnel setup → enable → sync`);
    }
  }
  if (tunnel.enabled) {
    const frpc = await findFrpc(cfg);
    add('frpc-binary', frpc ? PASS : FAIL, frpc ?? 'not found — pass --frpc <path> to tunnel setup');
    const visitors = visitorsFor(cfg);
    add('tunnel', tunnel.serverAddr ? PASS : FAIL, tunnel.serverAddr ? `${tunnel.serverAddr}:${tunnel.serverPort}, ${visitors.length} visitor(s)` : 'enabled but serverAddr is unset');
    try {
      const pid = await fs.readFile(path.join(tunnel.logDir ?? path.join(cfg.dataDir, 'frp'), 'frpc.pid'), 'utf8').then((text) => Number.parseInt(text.trim(), 10));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      add('frpc-process', alive ? PASS : WARN, alive ? `running (pid ${pid})` : `not running (pid file says ${pid || 'none'}) — dshlink tunnel sync`);
    } catch {
      add('frpc-process', WARN, 'not started — dshlink tunnel sync');
    }
  } else {
    add('tunnel', PASS, 'not configured (direct/LAN or relay only)');
  }

  const counts = checks.reduce((acc, check) => ({ ...acc, [check.status]: (acc[check.status] ?? 0) + 1 }), {});
  return { ok: (counts[FAIL] ?? 0) === 0, summary: { pass: counts.pass ?? 0, warn: counts.warn ?? 0, fail: counts.fail ?? 0 }, checks };
}
