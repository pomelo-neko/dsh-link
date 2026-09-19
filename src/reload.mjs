// dsh-link: keep a long-running node in sync with its config file.
//
// A node loads its config once at startup. Everything written afterwards by the CLI
// (peers accept, token new, roots, tunnel setup) used to stay invisible to the running
// process: outbound sends failed with "unknown peer: X" while `dshlink peers ping X`
// worked from the CLI, and inbound messages still arrived because they only need a token.
// That looks like a broken configuration but is really a stale process.
//
// This module watches the config file and re-applies it in place, so the node, the ops
// layer and the HTTP/MCP surface all see the new peers/tokens/roots without a restart.
import { promises as fs } from 'node:fs';
import { loadConfig } from './config.mjs';

/** Copy every top-level key of `next` onto `target` (in place, so existing references stay valid). */
export function applyConfigInto(target, next) {
  for (const key of Object.keys(next)) {
    if (key === 'configPath') continue;
    target[key] = next[key];
  }
  for (const key of Object.keys(target)) {
    if (key !== 'configPath' && !(key in next)) delete target[key];
  }
  return target;
}

/**
 * Watch a config file and call onChange(nextCfg) when it changes on disk.
 * check() is throttled (intervalMs), single-flight, and never throws.
 */
export function createConfigWatcher({ cfg, configPath = cfg?.configPath, intervalMs = 1000, onChange } = {}) {
  if (!configPath) throw new Error('createConfigWatcher needs a configPath');
  const state = { reloads: 0, lastReloadAt: null, lastError: null, lastCheckAt: null, lastSignature: null };
  let signature = null;
  let lastCheck = 0;
  let pending = null;

  async function signatureOf() {
    const stat = await fs.stat(configPath);
    return `${stat.mtimeMs}:${stat.size}`;
  }

  async function prime() {
    try { signature = await signatureOf(); } catch { signature = null; }
    state.lastSignature = signature;
    return { ...state };
  }

  async function check({ force = false } = {}) {
    if (pending) return pending;
    const now = Date.now();
    if (!force && now - lastCheck < intervalMs) return { changed: false, throttled: true, ...state };
    lastCheck = now;
    state.lastCheckAt = new Date(now).toISOString();
    pending = (async () => {
      let current;
      try {
        current = await signatureOf();
      } catch (err) {
        state.lastError = `config not readable: ${err.message}`;
        return { changed: false, error: state.lastError, ...state };
      }
      if (current === signature) return { changed: false, ...state };
      const previous = signature;
      signature = current;
      state.lastSignature = current;
      try {
        const next = await loadConfig({ configPath });
        const result = onChange ? await onChange(next, cfg, { previous, current }) : applyConfigInto(cfg, next);
        state.reloads += 1;
        state.lastReloadAt = new Date().toISOString();
        state.lastError = null;
        return { changed: true, reloaded: true, result, ...state };
      } catch (err) {
        state.lastError = err.message;
        return { changed: true, reloaded: false, error: err.message, ...state };
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  return { configPath, intervalMs, prime, check, state: () => ({ ...state }) };
}

/**
 * Watcher wired for a live node: reapplies the file config in place and rebuilds the
 * file roots when the shared folders changed.
 */
export function createNodeWatcher({ cfg, roots, dshView, configPath = cfg?.configPath, intervalMs = 1000, onReload } = {}) {
  return createConfigWatcher({
    cfg,
    configPath,
    intervalMs,
    onChange: async (next) => {
      const filesChanged = JSON.stringify(next.files ?? null) !== JSON.stringify(cfg.files ?? null);
      applyConfigInto(cfg, next);
      let rootsRebuilt = false;
      if (filesChanged && typeof roots?.reconfigure === 'function') {
        roots.reconfigure(cfg.files, dshView !== undefined ? { dshView } : {});
        rootsRebuilt = true;
      }
      onReload?.({ filesChanged, rootsRebuilt });
      return { filesChanged, rootsRebuilt };
    }
  });
}
