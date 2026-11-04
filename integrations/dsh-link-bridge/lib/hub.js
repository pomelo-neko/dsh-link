// dsh-link-bridge hub helpers (0.8): local-node hub status + the DSH web routes behind the panel.
//
// The bridge runs inside DSH and already talks to the local dsh-link node over loopback
// (nodeUrl + token, see lib/index.js). 0.8 adds two small jobs on top of the wake loop:
//
//   * hubStatusSnapshot() / hubUnavailableSnapshot() normalize the node's
//     GET /api/v1/hub/status payload into the compact `hub` object persisted in bridge
//     state.json (and reported through the capability channel's bridge.status). The snapshot is
//     written on every tick, so a remote peer, the CLI, or the DSH GUI can answer "is this
//     machine's hub uplink healthy, and what is still queued?" from one file.
//
//   * registerHubRoutes() proxies GET /api/v1/hub/status and POST /api/v1/hub/reconnect onto the
//     DSH web server. The browser half (lib/client.js, Settings -> dsh-link) then reads and acts
//     on the hub through the same origin as the DSH GUI, and the node token never reaches the
//     browser. The routes are best-effort: a host without the optional `webServer` service (or a
//     strict cordis context that forbids undeclared service reads) simply keeps the 0.7 behavior.
//
// Zero runtime dependencies: global fetch and the node:http req/res objects the web server passes
// in. Nothing here throws into the plugin's setup path.

/** Timeout for one node request triggered by a browser click (kept well below the GUI's 5s poll). */
const DEFAULT_ROUTE_TIMEOUT_MS = 5000;

/** Upper bound for a node body relayed to the browser (a status payload is tiny; this is a guard). */
const MAX_NODE_BODY_CHARS = 200000;

/** States the node's hublink can report (src/hublink.mjs HUB_LINK_STATES). */
export const HUB_STATES = ['disabled', 'connecting', 'online', 'degraded', 'offline'];

function errorText(error) {
  if (!error) return 'unknown error';
  const message = error && error.message !== undefined ? error.message : String(error);
  return message || 'unknown error';
}

/**
 * Read an optional cordis service without declaring it in `inject`.
 * The DSH host always has `webServer` in a web composition, but the same plugin also loads in
 * CLI/TUI-ish compositions and in tests; a missing service must not fail the plugin.
 */
function optionalService(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    }
  } catch { /* strict context: undeclared read throws, treat as unavailable */ }
  try {
    const direct = ctx[name];
    if (direct !== undefined && direct !== null) return direct;
  } catch { /* strict context: undeclared read throws, treat as unavailable */ }
  return undefined;
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function timestampOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function pendingTargetsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((target) => typeof target === 'string' && target !== '');
}

function enrolledOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    hubName: nullableString(value.hubName),
    nodeName: nullableString(value.nodeName),
    enrolledAt: nullableString(value.enrolledAt),
    visitorPort: Number.isFinite(value.visitorPort) ? value.visitorPort : null,
    downlinkUrl: nullableString(value.downlinkUrl)
  };
}

/**
 * Normalize the local node's GET /api/v1/hub/status payload into the object persisted as
 * `state.hub` (and served in bridge.status). Unknown fields are dropped on purpose: this object
 * is rewritten once per poll tick, and the panel only needs the stable fields below.
 *
 * A node that is not enrolled (0.7 deployment or hub.enabled=false) answers
 * `{enabled:false,state:'disabled',url:null}`; that answer is preserved as-is, which is what the
 * panel uses to show "hub 未启用（当前为 0.7 点对点模式）".
 *
 * @param payload - parsed JSON body of the node's hub status route.
 * @param options.now - ISO timestamp recorded as `updatedAt`.
 * @returns the normalized hub state.
 */
export function hubStatusSnapshot(payload, { now = new Date().toISOString() } = {}) {
  const status = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const enabled = status.enabled === true;
  const state = typeof status.state === 'string' && status.state
    ? status.state
    : (enabled ? 'unknown' : 'disabled');
  const pendingOutbox = Number.isFinite(status.pendingOutbox)
    ? Math.max(0, Math.trunc(status.pendingOutbox))
    : pendingTargetsOf(status.pendingTargets).length;
  return {
    enabled,
    state,
    url: nullableString(status.url),
    lastHeartbeatAt: timestampOrNull(status.lastHeartbeatAt),
    lastError: nullableString(status.lastError),
    pendingOutbox,
    pendingTargets: pendingTargetsOf(status.pendingTargets),
    enrolled: enrolledOf(status.enrolled),
    updatedAt: now
  };
}

/**
 * Snapshot written when the node did not answer (down, wrong port, old build without the route).
 * The last known hub identity is kept so the panel can still show which hub the node was on, but
 * the live state becomes `unknown`: bridge-side poll failures must not look like a hub-side
 * offline state, and they never affect the message wake loop.
 *
 * @param previous - previous snapshot (may be null).
 * @param message - why the poll failed.
 * @param options.now - ISO timestamp recorded as `updatedAt`.
 * @returns the normalized unavailable hub state.
 */
export function hubUnavailableSnapshot(previous, message, { now = new Date().toISOString() } = {}) {
  const last = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
  return {
    enabled: last.enabled === true,
    state: 'unknown',
    url: nullableString(last.url),
    lastHeartbeatAt: timestampOrNull(last.lastHeartbeatAt),
    lastError: typeof message === 'string' && message ? message : 'the local dsh-link node did not answer',
    pendingOutbox: Number.isFinite(last.pendingOutbox) ? Math.max(0, Math.trunc(last.pendingOutbox)) : 0,
    pendingTargets: pendingTargetsOf(last.pendingTargets),
    enrolled: enrolledOf(last.enrolled),
    updatedAt: now
  };
}

function truncateText(text, limit = 400) {
  const value = typeof text === 'string' ? text : '';
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function parseJsonText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sendJson(res, status, payload, headers = {}) {
  let body;
  try {
    body = JSON.stringify(payload === undefined ? null : payload);
  } catch {
    body = '{"error":{"code":"encode_failed","message":"response could not be encoded"}}';
    status = 500;
  }
  const buffer = Buffer.from(body + '\n', 'utf8');
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buffer.length,
      'cache-control': 'no-store',
      ...headers
    });
    res.end(buffer);
  } catch {
    try { res.destroy(); } catch { /* ignore */ }
  }
}

/**
 * One node request. Never rejects for an HTTP error status: the caller decides whether to
 * forward the node's status or map it to a bridge-level failure. Rejects only for transport
 * errors and timeouts.
 */
async function requestNode(url, { token, method = 'GET', timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  if (timer && typeof timer.unref === 'function') timer.unref();
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal });
    const text = (await response.text()).slice(0, MAX_NODE_BODY_CHARS);
    return { status: response.status, ok: response.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two routes the host half contributes to the DSH web server. Each handler is a plain
 * node:http handler: the GUI fetches them on the same origin, and the bridge proxies to the
 * node's loopback control plane with the configured bridge token.
 *
 * @param options.baseUrl - node base URL (no trailing slash).
 * @param options.token - bridge token for the node's Authorization header.
 * @param options.timeoutMs - per-request timeout.
 * @param options.log - optional logger (debug lines only).
 * @returns [{kind,path,handler}] ready for webServer.register().
 */
export function buildHubRoutes({ baseUrl, token = '', timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS, log } = {}) {
  const nodeBase = String(baseUrl || '').replace(/\/+$/, '');
  const debug = (message) => {
    try {
      if (log && typeof log.debug === 'function') log.debug(message);
    } catch { /* logging must never fail a request */ }
  };

  const statusRoute = {
    kind: 'exact',
    path: '/api/v1/hub/status',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'use GET' } }, { allow: 'GET' });
        return;
      }
      try {
        const result = await requestNode(nodeBase + '/api/v1/hub/status', { token, method: 'GET', timeoutMs });
        const payload = parseJsonText(result.text);
        if (payload !== null) {
          sendJson(res, result.status, payload);
          return;
        }
        sendJson(res, result.status >= 400 ? result.status : 502, {
          error: { code: 'bad_node_response', message: 'the local dsh-link node returned a non-JSON response: ' + truncateText(result.text) }
        });
      } catch (error) {
        debug('hub status proxy failed: ' + errorText(error));
        sendJson(res, 502, {
          error: { code: 'node_unreachable', message: 'the local dsh-link node is unreachable: ' + errorText(error) }
        });
      }
    }
  };

  const reconnectRoute = {
    kind: 'exact',
    path: '/api/v1/hub/reconnect',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'use POST' } }, { allow: 'POST' });
        return;
      }
      try {
        const result = await requestNode(nodeBase + '/api/v1/hub/reconnect', { token, method: 'POST', timeoutMs });
        const payload = parseJsonText(result.text);
        if (payload !== null) {
          // Pass the node's answer through unchanged: 200 with the fresh status, or 409
          // hub_disabled / 401 / 403 with the node's own error body. The panel renders whatever
          // the node said instead of inventing a second contract.
          sendJson(res, result.status, payload);
          return;
        }
        sendJson(res, result.status >= 400 ? result.status : 502, {
          error: { code: 'bad_node_response', message: 'the local dsh-link node returned a non-JSON response: ' + truncateText(result.text) }
        });
      } catch (error) {
        debug('hub reconnect proxy failed: ' + errorText(error));
        sendJson(res, 502, {
          error: { code: 'node_unreachable', message: 'the local dsh-link node is unreachable: ' + errorText(error) }
        });
      }
    }
  };

  return [statusRoute, reconnectRoute];
}

/** Register one route through the given context, preferring its effect-based disposal. */
function registerRouteOn(hostCtx, webServer, route, warn) {
  try {
    const bind = () => webServer.register(route);
    if (hostCtx && typeof hostCtx.effect === 'function') {
      hostCtx.effect(bind, 'dsh-link-bridge: hub ' + route.path);
    } else if (hostCtx && typeof hostCtx.on === 'function') {
      const dispose = bind();
      if (typeof dispose === 'function') {
        try { hostCtx.on('dispose', dispose); } catch { /* ignore */ }
      }
    } else {
      bind();
    }
    return true;
  } catch (error) {
    warn('hub web route ' + route.path + ' unavailable: ' + errorText(error));
    return false;
  }
}

/**
 * Register the hub routes on the DSH web server, if this host has one.
 *
 * The primary path is `ctx.inject(['webServer'], callback)`: a strict cordis host throws when a
 * plugin reads a service it did not declare in `inject` (see cordis "cannot get property X
 * without inject"), and the web server may be provided after this plugin loads. The callback runs
 * when/if the service appears, and the routes are contributed through `webCtx.effect` so a plugin
 * reload/dispose removes them together with the poller.
 *
 * A bare `ctx.get()`/`ctx.webServer` probe remains as a fallback for plain test contexts. Every
 * failure is contained: an old host without `webServer`, a duplicate path, or a strict context
 * leaves the bridge (0.7 wake loop and capability channel) fully working — only the Settings panel
 * loses its data source.
 *
 * @param ctx - cordis context the plugin was applied with.
 * @param options - see buildHubRoutes(); `log` is also used for warnings here.
 * @returns {{registered: string[], deferred: boolean, unavailable: string|null}} what was contributed.
 *   `registered` is filled only on the synchronous fallback path; `deferred` means the optional
 *   `ctx.inject` callback owns registration and will log its own outcome.
 */
export function registerHubRoutes(ctx, options = {}) {
  const routes = buildHubRoutes(options);
  const log = options.log;
  const warn = (message) => {
    try {
      if (log && typeof log.warn === 'function') log.warn(message);
    } catch { /* ignore */ }
  };
  const debug = (message) => {
    try {
      if (log && typeof log.debug === 'function') log.debug(message);
    } catch { /* ignore */ }
  };
  const registerAll = (hostCtx, webServer) => {
    const registered = [];
    for (const route of routes) {
      if (registerRouteOn(hostCtx, webServer, route, warn)) registered.push(route.path);
    }
    return registered;
  };

  // Primary path: optional dynamic injection (works on the real DSH host).
  let injectFn = null;
  try {
    if (ctx && typeof ctx.inject === 'function') injectFn = ctx.inject.bind(ctx);
  } catch { /* a strict test context may throw on undeclared reads; fall back below */ }
  if (injectFn) {
    try {
      injectFn(['webServer'], (webCtx) => {
        try {
          const server = optionalService(webCtx, 'webServer');
          if (!server || typeof server.register !== 'function') {
            debug('hub panel: the DSH host web server service is unavailable');
            return;
          }
          registerAll(webCtx, server);
        } catch (error) {
          warn('hub web routes failed: ' + errorText(error));
        }
      });
      return { registered: [], deferred: true, unavailable: null };
    } catch (error) {
      warn('hub web routes unavailable via inject: ' + errorText(error));
    }
  }

  // Fallback: a plain context that already exposes the service (tests, older hosts).
  const webServer = optionalService(ctx, 'webServer');
  if (!webServer || typeof webServer.register !== 'function') {
    return { registered: [], deferred: false, unavailable: 'the DSH host exposes no webServer service' };
  }
  return { registered: registerAll(ctx, webServer), deferred: false, unavailable: null };
}
