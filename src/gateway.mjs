// dsh-link: loopback token gateway.
//
// A separate 127.0.0.1 listener that requires a valid dsh-link token on every request and
// reverse-proxies to the real node API. It exists for the remote/mobile path: a phone reaches the
// node through an frp/STCP tunnel, so the node sees 127.0.0.1 as the client address. The node's
// authorize() (src/server.mjs) falls back to "localhost means admin" when auth.trustLocalhost is
// true, which would let that tunneled request through without a token. The gateway never does
// that: no valid token, no request, and it forwards the caller's token so the node still derives
// the right role. It also refuses the admin-only MCP and bridge routes outright, and limits a
// "device" token to the DSH surface a controller actually needs.
import http from 'node:http';
import https from 'node:https';
import { API_PREFIX, LinkError } from './util.mjs';
import { isLoopbackAddress, normalizeGatewayConfig, verifyToken } from './config.mjs';

// Headers that only describe one connection and must not be forwarded by a proxy.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

// Routes that are never available through the gateway, for any role. MCP can run tools on the
// host, and bridge routes let a local plugin answer commands; neither belongs on a remote surface.
const DENIED_PREFIXES = ['/mcp', API_PREFIX + '/bridge'];

const FORWARDED_HEADERS = ['authorization', 'x-dshlink-token', 'content-type', 'accept', 'range'];

export const GATEWAY_POLICY_SUMMARY = 'token required; /mcp and ' + API_PREFIX + '/bridge/* denied; device limited to dsh/info/healthz/network';

function sendGatewayError(res, status, code, message, details) {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  const payload = { error: { code, message } };
  if (details !== undefined) payload.error.details = details;
  const body = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  };
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="dsh-link"';
  res.writeHead(status, headers);
  res.end(body);
}

function presentedToken(req) {
  const header = String(req.headers.authorization ?? '');
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const alt = req.headers['x-dshlink-token'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return null;
}

function policyPathOf(url) {
  const pathname = url.pathname.toLowerCase();
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function isDeniedPath(pathname) {
  return DENIED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}

// Device tokens are the phone/desktop controller role: read the DSH view and call the capability
// channel, nothing else. admin/peer/bridge keep their normal node role (the node re-checks the
// forwarded token), except for the denied prefixes above.
function deviceAllowed(method, pathname) {
  if (method === 'GET' && (pathname === '/healthz' || pathname === API_PREFIX + '/info')) return true;
  if ((method === 'GET' || method === 'POST') && pathname.startsWith(API_PREFIX + '/dsh/')) return true;
  if (method === 'GET' && pathname.startsWith(API_PREFIX + '/network/')) return true;
  return false;
}

function roleAllowed(role, method, pathname) {
  if (role === 'device') return deviceAllowed(method, pathname);
  return role === 'admin' || role === 'peer' || role === 'bridge';
}

/**
 * Read a request body with a hard byte limit. The body is buffered because the gateway forwards
 * Content-Length and must not stream an unbounded upload. On overflow the request is drained (not
 * buffered) and the caller answers 413, so the client sees the JSON error instead of a reset.
 */
function readBody(req, maxBytes) {
  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    return Promise.reject(new LinkError(413, 'payload_too_large', `body is ${declared} bytes; limit is ${maxBytes}`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = null;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (!overflow && total > maxBytes) {
        overflow = new LinkError(413, 'payload_too_large', `body exceeds ${maxBytes} bytes`);
        chunks.length = 0;
        return;
      }
      if (!overflow) chunks.push(chunk);
    });
    req.on('end', () => (overflow ? reject(overflow) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(new LinkError(400, 'bad_request', 'request body was interrupted'));
    });
  });
}

/**
 * Create the loopback token gateway. It never falls back to auth.trustLocalhost: every request
 * needs a token that verifyToken() accepts against the live config, so a token added or revoked by
 * a config reload takes effect on the next request without restarting the gateway.
 *
 * opts.cfg      - the node config (used when getConfig is absent)
 * opts.getConfig- () => latest config object; cmdServe passes () => cfg and the reload watcher
 *                 mutates cfg in place, which makes token reload work without a port change.
 * opts.logger   - optional { info, warn, error, debug }
 */
export function createGateway({ cfg, getConfig, logger } = {}) {
  const log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const sockets = new Set();
  let server = null;

  function sourceConfig() {
    if (typeof getConfig === 'function') {
      try {
        const latest = getConfig();
        if (latest && typeof latest === 'object') return latest;
      } catch (err) {
        log.warn('gateway config read failed:', err?.message ?? String(err));
      }
    }
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  function currentGatewayConfig() {
    return normalizeGatewayConfig(sourceConfig().gateway);
  }

  async function handle(req, res) {
    const current = currentGatewayConfig();

    // The listener is bound to loopback, so this normally cannot fail; keep the check anyway so a
    // misconfiguration or a forwarding proxy in front of it cannot turn the gateway into an open
    // relay.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendGatewayError(res, 403, 'forbidden', 'gateway only accepts loopback connections');
      return;
    }

    const source = sourceConfig();
    const token = presentedToken(req);
    const match = token ? verifyToken(source, token) : null;
    if (!match) {
      log.warn(`gateway: rejected ${req.method} ${req.url ?? '/'} from ${req.socket.remoteAddress} (missing or invalid token)`);
      sendGatewayError(res, 401, 'unauthorized', 'missing or invalid token');
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid');
    } catch {
      sendGatewayError(res, 400, 'bad_request', 'malformed request URL');
      return;
    }
    const pathname = policyPathOf(url);
    if (isDeniedPath(pathname)) {
      sendGatewayError(res, 403, 'forbidden', `route ${pathname} is not exposed through the gateway`);
      return;
    }
    const role = match.role;
    if (!roleAllowed(role, req.method, pathname)) {
      sendGatewayError(res, 403, 'role_forbidden', `this route is not available to role "${role}"`);
      return;
    }

    let body;
    try {
      body = await readBody(req, current.maxBodyBytes);
    } catch (err) {
      if (err instanceof LinkError) sendGatewayError(res, err.status, err.code, err.message, err.details);
      else {
        log.error('gateway body read failed:', err?.stack ?? String(err));
        sendGatewayError(res, 400, 'bad_request', 'could not read request body');
      }
      return;
    }

    forward(req, res, { current, match, pathWithQuery: url.pathname + url.search, body });
  }

  function forward(req, res, { current, pathWithQuery, body }) {
    let target;
    try {
      target = new URL(current.upstream);
    } catch {
      sendGatewayError(res, 502, 'bad_gateway', `gateway upstream is not a valid URL: ${current.upstream}`);
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    // The body has already been buffered, so the forwarded length is the buffered length.
    if (body.length > 0 || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      headers['content-length'] = String(body.length);
    }

    let proxyReq;
    try {
      proxyReq = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: pathWithQuery,
        headers
      });
    } catch (err) {
      log.error('gateway upstream request failed:', err?.stack ?? String(err));
      sendGatewayError(res, 502, 'bad_gateway', `gateway upstream is unreachable: ${err?.message ?? String(err)}`);
      return;
    }

    let responded = false;
    let clientGone = false;
    let timedOut = false;
    let timer = null;

    const settle = (status, code, message) => {
      if (responded) return;
      responded = true;
      if (timer) clearTimeout(timer);
      sendGatewayError(res, status, code, message);
    };

    timer = setTimeout(() => {
      timedOut = true;
      proxyReq.destroy();
      if (!responded) settle(504, 'gateway_timeout', `gateway upstream did not respond within ${current.timeoutMs}ms`);
      else res.destroy();
    }, current.timeoutMs);
    timer.unref?.();

    res.on('close', () => {
      clientGone = true;
      if (!res.writableEnded) proxyReq.destroy();
      if (timer) clearTimeout(timer);
    });

    proxyReq.on('error', (err) => {
      if (timedOut) {
        settle(504, 'gateway_timeout', `gateway upstream did not respond within ${current.timeoutMs}ms`);
        return;
      }
      log.warn(`gateway: upstream ${target.origin} failed for ${req.method} ${pathWithQuery}: ${err?.code ?? err?.message ?? String(err)}`);
      settle(502, 'bad_gateway', `gateway upstream is unreachable: ${err?.code ?? err?.message ?? String(err)}`);
    });

    proxyReq.on('response', (upstreamRes) => {
      responded = true;
      if (timer) clearTimeout(timer);
      if (clientGone) {
        upstreamRes.destroy();
        return;
      }
      const headersOut = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(name)) continue;
        headersOut[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headersOut);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      res.on('finish', () => {
        if (timer) clearTimeout(timer);
      });
    });

    proxyReq.end(body.length > 0 ? body : undefined);
  }

  return {
    /** Start the listener. Defaults come from the live gateway config section. */
    async listen({ port, bind } = {}) {
      if (server) throw new LinkError(2, 'already_listening', 'gateway is already listening');
      const current = currentGatewayConfig();
      const wantedPort = port ?? current.port;
      const wantedBind = bind ?? current.bind;
      const instance = http.createServer((req, res) => {
        handle(req, res).catch((err) => {
          log.error('gateway unhandled request error:', err?.stack ?? String(err));
          if (!res.headersSent) sendGatewayError(res, 500, 'internal_error', 'gateway internal error');
          else res.destroy();
        });
      });
      instance.headersTimeout = 60_000;
      instance.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((resolve, reject) => {
        instance.once('error', reject);
        instance.listen(wantedPort, wantedBind, () => {
          instance.off('error', reject);
          resolve();
        });
      });
      server = instance;
      const address = instance.address();
      const actualPort = typeof address === 'object' && address ? address.port : wantedPort;
      const displayBind = wantedBind === '0.0.0.0' || wantedBind === '::' ? '127.0.0.1' : wantedBind;
      const url = `http://${displayBind}:${actualPort}`;
      log.info(`gateway listening on ${url} -> ${current.upstream} (${GATEWAY_POLICY_SUMMARY})`);
      return { port: actualPort, bind: wantedBind, url, upstream: current.upstream };
    },

    /** Stop accepting connections and drop the open ones; safe to call more than once. */
    async close() {
      const instance = server;
      if (!instance) return;
      server = null;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        instance.close(finish);
        instance.closeIdleConnections?.();
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          finish();
        }, 1000);
        timer.unref?.();
      });
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },

    get listening() {
      return server !== null;
    }
  };
}
