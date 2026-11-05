// dsh-link node -> hub uplink (0.8).
//
// A node with hub.enabled runs one HubLink: it registers itself with the hub (heartbeat), uploads
// every outgoing message to the hub instead of talking to peers directly, and routes DSH view /
// capability / file requests to the hub. The hub is the only channel in this mode; there is no
// point-to-point fallback. Link state is observable from CLI, MCP (bridge) and the DSH GUI.
import { LinkError, DSHLINK_VERSION, nowIso, timeoutSignal } from './util.mjs';
import { LinkClient } from './client.mjs';
import { createInboundToken, saveConfig } from './config.mjs';

export const HUB_LINK_STATES = ['disabled', 'connecting', 'online', 'degraded', 'offline'];

export class HubLink {
  constructor({ cfg, logger, save = null, fetchImpl = null }) {
    this.cfg = cfg;
    this.log = logger ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.save = save;
    this.fetch = fetchImpl ?? fetch;
    this.state = 'disabled';
    this.attempts = 0;
    this.lastHeartbeatAt = null;
    this.lastError = null;
    this.lastLatencyMs = null;
    this.nextRetryAt = null;
    this.startedAt = null;
    this.stopped = false;
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.inFlight = null;
    this.onOnline = null;
    this.onMessage = null;
  }

  get enabled() {
    return this.cfg?.hub?.enabled === true && !!this.cfg.hub.url && !!this.cfg.hub.token;
  }

  get url() {
    return String(this.cfg?.hub?.url ?? '').replace(/\/+$/, '');
  }

  client(overrides = {}) {
    return new LinkClient({
      baseUrl: this.url,
      token: this.cfg.hub.token,
      timeoutMs: this.cfg.hub.timeoutMs ?? this.cfg.limits?.requestTimeoutMs ?? 30000,
      label: 'hub',
      ...overrides
    });
  }

  status() {
    const hub = this.cfg.hub ?? {};
    const heartbeatSeconds = Number(hub.heartbeatSeconds ?? 30);
    let state = this.state;
    if (state === 'online' && this.lastHeartbeatAt) {
      const age = Date.now() - Date.parse(this.lastHeartbeatAt);
      if (age > heartbeatSeconds * 2500) state = 'offline';
      else if (age > heartbeatSeconds * 1500) state = 'degraded';
    }
    return {
      enabled: this.enabled,
      url: this.url || null,
      state: this.enabled ? state : 'disabled',
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      lastLatencyMs: this.lastLatencyMs,
      attempts: this.attempts,
      nextRetryAt: this.nextRetryAt,
      startedAt: this.startedAt,
      heartbeatSeconds,
      reconnect: hub.reconnect ?? null,
      enrolled: hub.enrolled ?? null,
      softwareVersion: DSHLINK_VERSION
    };
  }

  start() {
    if (!this.enabled) {
      this.state = 'disabled';
      return this;
    }
    this.stopped = false;
    this.startedAt = nowIso();
    this.state = 'connecting';
    void this.heartbeat();
    const seconds = Math.max(5, Number(this.cfg.hub.heartbeatSeconds ?? 30));
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, seconds * 1000);
    this.heartbeatTimer.unref?.();
    return this;
  }

  stop() {
    this.stopped = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.state !== 'disabled') this.state = 'offline';
  }

  backoffSeconds() {
    const min = Math.max(1, Number(this.cfg.hub.reconnect?.minSeconds ?? 5));
    const max = Math.max(min, Number(this.cfg.hub.reconnect?.maxSeconds ?? 60));
    return Math.min(max, min * 2 ** Math.min(this.attempts, 6));
  }

  scheduleRetry() {
    if (this.stopped || !this.enabled) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = this.backoffSeconds();
    this.nextRetryAt = new Date(Date.now() + delay * 1000).toISOString();
    this.state = 'offline';
    this.retryTimer = setTimeout(() => { void this.heartbeat(); }, delay * 1000);
    this.retryTimer.unref?.();
  }

  async heartbeat() {
    if (!this.enabled || this.stopped) return this.status();
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const started = Date.now();
      try {
        const payload = await this._json('POST', '/api/v1/hub/heartbeat', {
          name: this.cfg.name,
          nodeId: this.cfg.nodeId,
          softwareVersion: DSHLINK_VERSION,
          downlinkUrl: this.cfg.publicUrl ?? null,
          pendingLocal: this.pendingCount(),
          provider: this.cfg.stcp?.proxyName ? { serverName: this.cfg.stcp.proxyName } : null
        });
        this.attempts = 0;
        this.lastLatencyMs = Date.now() - started;
        this.lastHeartbeatAt = nowIso();
        this.lastError = null;
        this.state = 'online';
        this.nextRetryAt = null;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        if (payload?.node?.status === 'pending') {
          this.lastError = 'waiting for hub approval';
          this.state = 'degraded';
        }
        if (typeof this.onOnline === 'function') {
          try { await this.onOnline(payload); } catch (err) { this.log.debug?.('hub onOnline callback failed:', err?.message ?? String(err)); }
        }
        return this.status();
      } catch (err) {
        this.attempts += 1;
        this.lastError = String(err?.message ?? err).slice(0, 300);
        this.scheduleRetry();
        return this.status();
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  pendingCount() {
    return this._pendingCount ?? 0;
  }

  setPendingCount(value) {
    this._pendingCount = Math.max(0, Number(value) || 0);
  }

  async reconnect() {
    if (!this.enabled) throw new LinkError(409, 'hub_disabled', 'this node is not enrolled in a hub');
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.attempts = 0;
    this.nextRetryAt = null;
    this.state = 'connecting';
    await this.heartbeat();
    return this.status();
  }

  // --- message delivery: the hub is the only channel in this mode ---
  async deliverMessage(record) {
    if (!this.enabled) throw new LinkError(409, 'hub_disabled', 'this node is not enrolled in a hub');
    return this._json('POST', '/api/v1/messages', record);
  }

  // --- DSH view / capability proxies ---
  async dshWorkspaces(params = {}) { return this._call('dshWorkspaces', params); }
  async dshSessions(params = {}) { return this._call('dshSessions', params); }
  async dshSession(id, params = {}) { return this._call('dshSession', id, params); }
  async dshTranscript(id, params = {}) { return this._call('dshTranscript', id, params); }
  async dshCapabilities(params = {}) { return this._call('dshCapabilities', params); }
  async networkNodes(query = {}) { return this.client().networkNodes(query); }

  async dshCall(body = {}) {
    const client = this.client();
    return client.dshCall(body);
  }

  async dshCallResult(id, peer) {
    const client = this.client();
    return client.dshCallResult(id, peer ? { peer } : undefined);
  }

  // --- files ---
  async listFiles(params = {}) {
    const client = this.client();
    return client.listFiles(params);
  }

  async statFile(params = {}) {
    const client = this.client();
    return client.statFile(params);
  }

  async hashFile(params = {}) {
    const client = this.client();
    return client.hashFile(params);
  }

  async download(query = {}, destPath) {
    const client = this.client();
    return client.download(query, destPath);
  }

  async upload(query = {}, buffer) {
    const client = this.client();
    return client.upload(query, buffer);
  }

  async _call(method, ...args) {
    const client = this.client();
    if (typeof client[method] !== 'function') throw new LinkError(500, 'internal_error', 'hub client has no method ' + method);
    return client[method](...args);
  }

  async _json(method, pathname, body) {
    const client = this.client();
    return client._fetch(method, pathname, { body });
  }

  // --- enrollment ---
  async enroll({ url, token, downlinkUrl = null }) {
    const base = String(url ?? this.cfg.hub?.url ?? '').replace(/\/+$/, '');
    if (!base) throw new LinkError(400, 'bad_request', 'the hub URL is required (--url)');
    if (!token) throw new LinkError(400, 'bad_request', 'an enrollment token is required (--token)');
    const info = await this._jsonAt(base, token, 'GET', '/api/v1/info');
    const hubName = info?.name;
    if (!hubName) throw new LinkError(502, 'upstream_error', 'the hub did not report a name');
    if (!this.cfg.stcp?.secretKey) throw new LinkError(409, 'provider_missing', 'run "dshlink tunnel setup" first: enrollment publishes the node STCP provider');
    const downlink = createInboundToken(this.cfg, 'hub:' + hubName, { role: 'hub', peer: hubName });
    // The hub persists the node and then has to restart frpc to open the node's visitor, which can
    // tear down the STCP tunnel that carries this very response. Retry is safe: the hub accepts a
    // re-enrollment of the same nodeId and returns fresh tokens, so a lost response is recoverable.
    const request = {
      name: this.cfg.name,
      nodeId: this.cfg.nodeId,
      softwareVersion: DSHLINK_VERSION,
      provider: { serverName: this.cfg.stcp.proxyName, secretKey: this.cfg.stcp.secretKey },
      downlinkToken: downlink.token,
      downlinkUrl
    };
    let result = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await this._jsonAt(base, token, 'POST', '/api/v1/hub/enroll', request);
        break;
      } catch (err) {
        const transient = !(err instanceof LinkError) || err.status >= 500;
        if (!transient || attempt >= 3) throw err;
        this.log.warn?.('hub enrollment attempt ' + attempt + ' failed (' + (err?.message ?? err) + '); retrying');
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    this.cfg.hub.enabled = true;
    this.cfg.hub.url = base;
    if (result?.uplinkToken) this.cfg.hub.token = result.uplinkToken;
    if (result?.frp?.secretKey) {
      this.cfg.hub.frp = {
        serverAddr: result.frp.serverAddr ?? null,
        serverPort: result.frp.serverPort ?? null,
        serverName: result.frp.serverName ?? null,
        secretKey: result.frp.secretKey
      };
      const localPort = Number(this.cfg.hub.visitorPort ?? 18790);
      this.cfg.hub.url = 'http://127.0.0.1:' + localPort;
    }
    this.cfg.hub.enrolled = {
      hubName,
      nodeName: this.cfg.name,
      enrolledAt: nowIso(),
      visitorPort: result?.node?.visitorPort ?? info?.enrollment?.visitorPort ?? null,
      downlinkUrl: result?.node?.downlinkUrl ?? null,
      status: result?.node?.status ?? (result?.pending ? 'pending' : 'active')
    };
    if (this.save) await this.save(this.cfg);
    else if (this.cfg.configPath) await saveConfig(this.cfg);
    return { hub: info, result, cfg: this.cfg };
  }

  async _jsonAt(base, token, method, pathname, body) {
    const headers = { accept: 'application/json', authorization: 'Bearer ' + token };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutSignal(this.cfg.hub?.timeoutMs ?? 30000)
    });
    const text = await response.text().catch(() => '');
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (err) { payload = null; }
    if (!response.ok) {
      const err = payload?.error ?? {};
      throw new LinkError(response.status, err.code ?? 'upstream_error', err.message ?? ('the hub returned HTTP ' + response.status));
    }
    return payload;
  }
}

export function createHubLink(options) {
  return new HubLink(options);
}
