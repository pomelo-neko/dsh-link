// dsh-link: outbound HTTP client used by the CLI, the MCP tools, and peer-to-peer delivery.
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { API_PREFIX, LinkError, timeoutSignal, upstream } from './util.mjs';

export class LinkClient {
  constructor({ baseUrl, token, timeoutMs = 60_000, label = 'peer' } = {}) {
    if (!baseUrl) throw new LinkError(400, 'bad_request', 'a peer URL is required');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token ?? null;
    this.timeoutMs = timeoutMs;
    this.label = label;
  }

  _url(pathname, query) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async _fetch(method, pathname, { query, body, headers = {}, raw = false, timeoutMs } = {}) {
    const url = this._url(pathname, query);
    const init = {
      method,
      headers: { accept: 'application/json', ...headers },
      signal: timeoutSignal(timeoutMs ?? this.timeoutMs)
    };
    if (this.token) init.headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) {
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        init.body = body;
        init.headers['content-type'] = 'application/octet-stream';
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const cause = err?.cause?.code ?? err?.code ?? err?.name ?? 'fetch failed';
      throw upstream(`cannot reach ${this.label} at ${this.baseUrl}: ${cause}`, { peer: this.label, url: this.baseUrl });
    }
    if (raw) {
      if (!res.ok) throw await toError(res, this.label);
      return res;
    }
    if (!res.ok) throw await toError(res, this.label);
    if (res.status === 204) return null;
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw upstream(`${this.label} returned a non-JSON body`, { peer: this.label, body: text.slice(0, 500) });
    }
  }

  health() { return this._fetch('GET', '/healthz'); }
  info() { return this._fetch('GET', `${API_PREFIX}/info`); }
  listPeers(probe = false) { return this._fetch('GET', `${API_PREFIX}/peers`, { query: probe ? { probe: '1' } : {} }); }
  deliverMessage(message) { return this._fetch('POST', `${API_PREFIX}/messages`, { body: message }); }
  inbox(query) { return this._fetch('GET', `${API_PREFIX}/messages`, { query }); }
  outbox(query) { return this._fetch('GET', `${API_PREFIX}/outbox`, { query }); }
  getMessage(id) { return this._fetch('GET', `${API_PREFIX}/messages/${encodeURIComponent(id)}`); }
  markRead(ids) { return this._fetch('POST', `${API_PREFIX}/messages/read`, { body: { ids } }); }
  listFiles(query) { return this._fetch('GET', `${API_PREFIX}/files`, { query }); }
  statFile(query) { return this._fetch('GET', `${API_PREFIX}/files/stat`, { query }); }
  hashFile(query) { return this._fetch('GET', `${API_PREFIX}/files/hash`, { query }); }
  audit(limit = 50) { return this._fetch('GET', `${API_PREFIX}/audit`, { query: { limit } }); }

  // --- DSH view (workspaces, conversations, transcripts) and the capability channel ---
  dshWorkspaces() { return this._fetch('GET', `${API_PREFIX}/dsh/workspaces`); }
  dshSessions(query) { return this._fetch('GET', `${API_PREFIX}/dsh/sessions`, { query }); }
  dshSession(id) { return this._fetch('GET', `${API_PREFIX}/dsh/sessions/${encodeURIComponent(id)}`); }
  dshTranscript(id, query) { return this._fetch('GET', `${API_PREFIX}/dsh/sessions/${encodeURIComponent(id)}/transcript`, { query }); }
  dshCapabilities() { return this._fetch('GET', `${API_PREFIX}/dsh/capabilities`); }
  dshCall(body, { timeoutMs } = {}) {
    return this._fetch('POST', `${API_PREFIX}/dsh/call`, { body, timeoutMs });
  }
  dshCallResult(id) { return this._fetch('GET', `${API_PREFIX}/dsh/call/${encodeURIComponent(id)}`); }

  async download(query, destPath) {
    const res = await this._fetch('GET', `${API_PREFIX}/files/download`, { query, raw: true });
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    const counter = new TransformCounter((chunk) => { bytes += chunk.length; hash.update(chunk); });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(destPath));
    const remoteSha256 = res.headers.get('x-dshlink-sha256') || null;
    const sha256 = hash.digest('hex');
    return {
      path: destPath,
      size: bytes,
      sha256,
      remoteSha256,
      verified: remoteSha256 ? remoteSha256 === sha256 : null
    };
  }

  async upload(query, buffer) {
    const res = await this._fetch('POST', `${API_PREFIX}/files/upload`, {
      query,
      body: buffer,
      headers: { 'content-length': String(buffer.length) }
    });
    return res;
  }
}

class TransformCounter extends Transform {
  constructor(onChunk) {
    super();
    this.onChunk = onChunk;
  }
  _transform(chunk, _enc, callback) {
    this.onChunk(chunk);
    callback(null, chunk);
  }
}

async function toError(res, label) {
  let payload = null;
  try { payload = JSON.parse(await res.text()); } catch { /* ignore */ }
  const message = payload?.error?.message ?? `${label} responded with HTTP ${res.status}`;
  return new LinkError(res.status, payload?.error?.code ?? 'http_error', message, payload?.error?.details);
}

export function clientForPeer(peer, { timeoutMs } = {}) {
  return new LinkClient({ baseUrl: peer.url, token: peer.token, timeoutMs, label: peer.name });
}
