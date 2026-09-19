// dsh-link-bridge capability worker: claim the remote commands waiting in the local
// dsh-link node, run them through the Host handlers, and post exactly one result each.
//
// The node keeps the queue durably: a command that is claimed and never answered stays
// outstanding on the calling side, so every path here — a good handler, a throwing handler,
// an unknown method, even a command with no id — must end in a result POST or a recorded
// failure. The poll loop lives inside DSH, where nobody watches a console, so a broken node
// may never take the tick down with it: tick() resolves, and the reason lands in stats.
//
// Zero runtime dependencies: global fetch, one JSON body per request, no timer left armed
// (every timeout is unref'd and cleared).
/**
 * Retry and telemetry defaults. Every field is overridable through the factory options.
 */
const DEFAULTS = {
  timeoutMs: 15000,
  maxPerTick: 5,
  heartbeatMs: 30000
};

/** The node clamps its own ?limit to 25, so a larger request would only be truncated there. */
const MAX_CLAIM = 25;

/**
 * Caller-owned timeout signal. The timer is unref'd so an in-flight bridge request can never
 * hold the DSH process open, and cleared by the caller as soon as the request settles.
 * @param ms - milliseconds before the request is aborted.
 * @returns the abort signal plus its cleanup.
 */
function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Normalize any thrown value into the node's `{ message, code? }` error body. Never throws:
 * an error whose own accessors explode still has to produce a reportable message.
 * @param error - value thrown by a handler or by fetch.
 * @returns the wire error body.
 */
function errorFields(error) {
  try {
    if (error === undefined || error === null) return { message: 'unknown error' };
    const code = typeof error === 'object' ? error.code ?? (error.cause ? error.cause.code : undefined) : undefined;
    const message = typeof error === 'object' && typeof error.message === 'string' && error.message
      ? error.message
      : String(error);
    return code === undefined || code === null || code === '' ? { message } : { message, code: String(code) };
  } catch {
    return { message: 'unknown error' };
  }
}

/**
 * Poll the node for remote commands and run them against the Host handlers.
 *
 * Wire protocol (the node owns the server side):
 *   GET  {nodeUrl}/api/v1/bridge/commands?limit=N  -> { commands: [{ id, method, params, origin, attempts }] }
 *   POST {nodeUrl}/api/v1/bridge/commands/{id}/result  body { ok: true, result }
 *                                                   or   { ok: false, error: { message, code? } }
 *   POST {nodeUrl}/api/v1/bridge/heartbeat         body { version, capabilities, sessions, at }
 *
 * @param options - worker wiring.
 * @param options.nodeUrl - base URL of the local dsh-link node (trailing slashes ignored).
 * @param options.token - bearer token for the node; an empty token sends no Authorization header.
 * @param options.log - optional { info, warn, error, debug } logger; nothing is logged without one.
 * @param options.handlers - method name -> async (params, context) => JSON result.
 * @param options.fetchImpl - fetch seam for tests.
 * @param options.timeoutMs - per-request timeout.
 * @param options.maxPerTick - commands claimed per tick (also the ?limit value).
 * @param options.version - bridge version reported in the heartbeat.
 * @param options.heartbeatMs - minimum gap between two heartbeats.
 * @param options.describe - () => string[] capability list; defaults to the handler names.
 * @param options.now - clock seam (milliseconds) so heartbeat throttling is testable.
 * @param options.sessions - session count (number) or provider for the heartbeat `sessions` field.
 * @param options.status - alternative provider whose `.sessions` field is reported.
 * @returns { tick(), stats } - tick() resolves even when everything fails; stats is live.
 */
export function createCommandWorker({
  nodeUrl,
  token = '',
  log,
  handlers,
  fetchImpl = fetch,
  timeoutMs = DEFAULTS.timeoutMs,
  maxPerTick = DEFAULTS.maxPerTick,
  version = '',
  heartbeatMs = DEFAULTS.heartbeatMs,
  describe,
  now = Date.now,
  sessions,
  status
} = {}) {
  const baseUrl = String(nodeUrl || '').replace(/\/+$/, '');
  const authToken = String(token || '');
  const requestMs = Math.max(1, Number(timeoutMs) || DEFAULTS.timeoutMs);
  const perTick = Math.max(1, Math.min(MAX_CLAIM, Number(maxPerTick) || DEFAULTS.maxPerTick));
  const beatMs = Math.max(0, Number(heartbeatMs) || 0);
  const methodMap = handlers && typeof handlers === 'object' ? handlers : {};
  const logger = log && typeof log === 'object' ? log : {};

  const stats = {
    ticks: 0,
    executed: 0,
    failed: 0,
    lastError: null,
    lastErrorAt: null,
    lastCommandAt: null,
    lastHeartbeatAt: null
  };
  /** Raw clock value of the last successful heartbeat; stats keeps the ISO spelling. */
  let beatAt = 0;
  /** In-flight tick, shared by concurrent callers so the node is never polled twice at once. */
  let inFlight = null;

  /** One log line, contained: a broken logger must never break a tick. */
  function emit(level, message) {
    const fn = logger[level];
    if (typeof fn !== 'function') return;
    try { fn.call(logger, message); } catch { /* ignore */ }
  }

  /** ISO timestamp from the injectable clock; never throws. */
  function stamp(value) {
    try {
      const ms = Number(value === undefined ? now() : value);
      return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  /** Record a failure for the node console and the heartbeat file. */
  function recordError(error) {
    const fields = errorFields(error);
    stats.lastError = fields.code ? fields.message + ' (' + fields.code + ')' : fields.message;
    stats.lastErrorAt = stamp();
    return stats.lastError;
  }

  /**
   * One JSON request against the node. A non-2xx answer is an error; an empty body (204, or a
   * node that answers nothing useful) reads as `null` rather than a parse failure.
   */
  async function request(method, url, body) {
    const guard = timeoutSignal(requestMs);
    const headers = {};
    if (authToken) headers.authorization = 'Bearer ' + authToken;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: guard.signal
      });
      const ok = response && typeof response.ok === 'boolean'
        ? response.ok
        : !!response && response.status >= 200 && response.status < 300;
      if (!ok) {
        throw new Error('HTTP ' + (response ? response.status : 'unknown') + ' from ' + method + ' ' + url);
      }
      const text = response && typeof response.text === 'function' ? await response.text() : '';
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    } finally {
      guard.done();
    }
  }

  /** Claim up to `maxPerTick` commands; a malformed body claims nothing instead of throwing. */
  async function claim() {
    const payload = await request('GET', baseUrl + '/api/v1/bridge/commands?limit=' + perTick);
    const commands = payload && Array.isArray(payload.commands) ? payload.commands : [];
    return commands.slice(0, perTick);
  }

  /** Post one command result; the id is percent-encoded because the node routes on the path. */
  function report(id, payload) {
    return request('POST', baseUrl + '/api/v1/bridge/commands/' + encodeURIComponent(id) + '/result', payload);
  }

  /**
   * Run one claimed command in total isolation: any failure becomes an ok:false report, and a
   * report that cannot be delivered is recorded rather than thrown.
   */
  async function run(command) {
    const id = command && typeof command.id === 'string' ? command.id : '';
    const method = command && typeof command.method === 'string' ? command.method : '';
    if (!id) {
      recordError(new Error('the node returned a command without an id'));
      emit('warn', 'bridge command without an id was skipped: ' + JSON.stringify(command));
      return;
    }
    stats.lastCommandAt = stamp();
    try {
      const handler = methodMap[method];
      if (typeof handler !== 'function') throw new Error('unsupported method: ' + method);
      const params = command.params && typeof command.params === 'object' ? command.params : {};
      const result = await handler(params, {
        id,
        method,
        origin: command.origin,
        attempts: command.attempts
      });
      await report(id, { ok: true, result: result === undefined ? null : result });
      stats.executed += 1;
      emit('debug', 'bridge command ' + method + ' (' + id + ') completed');
    } catch (error) {
      const fields = errorFields(error);
      stats.failed += 1;
      const text = recordError(error);
      emit('warn', 'bridge command ' + (method || '(no method)') + ' (' + id + ') failed: ' + text);
      try {
        await report(id, { ok: false, error: fields });
      } catch (reportError) {
        recordError(reportError);
        emit('warn', 'could not report the result of ' + id + ': ' + stats.lastError);
      }
    }
  }

  /** The advertised capability list: the caller's describe(), else the handler names. */
  async function capabilities() {
    if (typeof describe === 'function') {
      try {
        const value = await describe();
        if (Array.isArray(value)) return value.map((entry) => String(entry));
      } catch (error) {
        emit('warn', 'the capability descriptor failed: ' + errorFields(error).message);
      }
    }
    return Object.keys(methodMap);
  }

  /** Session count for the heartbeat; unknown or broken providers report 0 rather than failing. */
  async function sessionCount() {
    const source = sessions === undefined || sessions === null ? status : sessions;
    if (source === undefined || source === null) return 0;
    try {
      const value = typeof source === 'function' ? await source() : source;
      const count = typeof value === 'number' ? value : value && typeof value.sessions === 'number' ? value.sessions : 0;
      return Number.isFinite(count) ? count : 0;
    } catch (error) {
      emit('debug', 'the session count is unavailable: ' + errorFields(error).message);
      return 0;
    }
  }

  /** One heartbeat, at most every `heartbeatMs`; a failed beat retries on the next tick. */
  async function beat() {
    const at = Number(now());
    if (beatAt && at - beatAt < beatMs) return;
    const payload = {
      version: String(version || ''),
      capabilities: await capabilities(),
      sessions: await sessionCount(),
      at: stamp(at)
    };
    await request('POST', baseUrl + '/api/v1/bridge/heartbeat', payload);
    beatAt = at;
    stats.lastHeartbeatAt = payload.at;
  }

  /** One poll: claim, run, then heartbeat. Errors are recorded, never propagated. */
  async function runTick() {
    stats.ticks += 1;
    let claimed = false;
    try {
      const commands = await claim();
      claimed = true;
      for (const command of commands) await run(command);
    } catch (error) {
      recordError(error);
      emit('warn', 'bridge command poll failed: ' + stats.lastError);
    }
    // A heartbeat only asserts that the channel works. When the claim just failed there is
    // nothing left to assert: the second failure would only mask the poll error in stats, and
    // an unreachable node would get two refused connections per tick instead of one.
    if (!claimed) return;
    try {
      await beat();
    } catch (error) {
      recordError(error);
      emit('warn', 'bridge heartbeat failed: ' + stats.lastError);
    }
  }

  /**
   * Poll once. Concurrent callers share the running tick, and the returned promise never
   * rejects — the caller is a timer inside the DSH host, where an escaping error would become
   * an unhandled rejection nobody can see.
   * @returns a promise that settles once this tick is finished.
   */
  function tick() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await runTick();
      } catch (error) {
        recordError(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { tick, stats };
}
