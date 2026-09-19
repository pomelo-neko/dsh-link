// Test helpers: boot throwaway dsh-link nodes in-process (no child processes needed).
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MessageStore } from '../src/store.mjs';
import { FileRoots } from '../src/fsroot.mjs';
import { createOps } from '../src/ops.mjs';
import { createLinkServer } from '../src/server.mjs';
import { createInboundToken, normalizeConfig, saveConfig } from '../src/config.mjs';
import { createNodeWatcher } from '../src/reload.mjs';
import { createDshView } from '../src/dshview.mjs';
import { createBridgePresence, createCommandQueue } from '../src/capabilities.mjs';

export const PROJECT_DIR = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// Unit tests use their own subtree so live artifacts (e.g. test/.tmp/wan) are never touched.
export const TMP = path.join(PROJECT_DIR, 'test', '.tmp', 'unit');

export async function resetTmp() {
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  await fs.mkdir(TMP, { recursive: true });
}

function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function makeNode(opts = {}) {
  const dir = path.join(TMP, opts.id ?? opts.name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const raw = stripUndefined({
    name: opts.name,
    dataDir: dir,
    bind: '127.0.0.1',
    port: 0,
    auth: { trustLocalhost: opts.trustLocalhost !== false, tokens: [] },
    files: {
      allowUpload: !!opts.allowUpload,
      roots: (opts.roots ?? []).map((r) => ({ ...r, read: r.read !== false, write: !!r.write })),
      deny: opts.deny
    },
    limits: opts.limits,
    dsh: opts.dsh,
    capabilities: opts.capabilities,
    peers: opts.peers ?? [],
    relay: opts.relay ?? { enabled: true }
  });
  const cfg = normalizeConfig(raw, dir);
  cfg.configPath = path.join(dir, 'dshlink.config.json');
  const token = opts.token ?? createInboundToken(cfg, 'test-peer').token;
  await saveConfig(cfg);
  const store = await new MessageStore(dir).init();
  const commandsDir = path.join(dir, 'commands');
  const dsh = createDshView({ cfg: cfg.dsh });
  const roots = new FileRoots({ ...cfg.files, maxListEntries: cfg.limits.maxListEntries }, { dshView: dsh });
  const commands = createCommandQueue({ dir: commandsDir, cfg: cfg.capabilities });
  const presence = createBridgePresence({ dir: commandsDir, cfg: cfg.capabilities });
  const ops = createOps({ cfg, store, roots, dsh, commands, presence, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const watcher = opts.watch
    ? createNodeWatcher({
      cfg,
      roots,
      dshView: dsh,
      intervalMs: opts.watchIntervalMs ?? 0,
      onReload: () => {
        // Mirror the CLI: the view/queue normalize their config, so push the reloaded section in.
        try { dsh.reconfigure?.(cfg.dsh); } catch { /* ignore */ }
        try { commands.setConfig?.(cfg.capabilities); } catch { /* ignore */ }
      }
    })
    : null;
  if (watcher) await watcher.prime();
  const link = createLinkServer({
    cfg,
    store,
    roots,
    ops,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    refresh: watcher ? (opts.watchRefresh ?? (() => watcher.check())) : undefined,
    runtime: watcher
      ? () => {
        const state = watcher.state();
        return {
          version: 'test', pid: process.pid, configPath: cfg.configPath,
          configReloads: state.reloads, configLastReloadAt: state.lastReloadAt, configLastError: state.lastError
        };
      }
      : undefined
  });
  const info = await link.listen({ port: 0, bind: '127.0.0.1' });
  return {
    name: opts.name,
    dir,
    cfg,
    store,
    roots,
    ops,
    dsh,
    commands,
    presence,
    link,
    watcher,
    url: info.url,
    port: info.port,
    token,
    connectTo(other, extra = {}) {
      cfg.peers.push({ name: other.name, url: other.url, token: other.token, stcp: null, ...extra });
      return cfg.peers[cfg.peers.length - 1];
    },
    close: () => link.close()
  };
}

/**
 * Where is the MCP SDK? dsh-link has no dependencies, and the SDK normally comes from the DSH
 * installation on this machine, so look in the documented places (and in node_modules, if you
 * installed it) and report null instead of guessing.
 */
export function findMcpSdk() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const candidates = [];
  if (process.env.DSH_MCP_SDK) candidates.push(process.env.DSH_MCP_SDK);
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm'));
  if (home) candidates.push(path.join(home, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm'));
  try {
    // Works when the SDK is installed anywhere up the tree (npm i -D @modelcontextprotocol/sdk).
    const resolved = createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/client/index.js');
    candidates.push(path.dirname(path.dirname(resolved)));
  } catch { /* not installed here */ }
  for (const candidate of candidates) {
    try { if (existsSync(path.join(candidate, 'client', 'index.js'))) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export async function mcpClientFor(url, token) {
  const sdkBase = findMcpSdk();
  if (!sdkBase) {
    throw new Error(
      'the MCP client SDK was not found — install @modelcontextprotocol/sdk, or point DSH_MCP_SDK at '
      + '<node_modules>/@modelcontextprotocol/sdk/dist/esm (in a DSH installation it is under DSH_HOME)'
    );
  }
  const { Client } = await import(pathToFileURL(path.join(sdkBase, 'client', 'index.js')).href);
  const { StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkBase, 'client', 'streamableHttp.js')).href);
  const client = new Client({ name: 'dsh-link-tests', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined
  });
  await client.connect(transport);
  return client;
}

export function textOf(result) {
  return (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}
