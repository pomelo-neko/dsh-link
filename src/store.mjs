// dsh-link: durable message store (append-only JSONL) + mutable state + audit log.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isPlainObject, newId, nowIso } from './util.mjs';

const BOXES = new Set(['inbox', 'outbox']);
// Delivery states that are final: such outbox records are never retried by flush/sync.
const TERMINAL_DELIVERY = new Set(['delivered', 'dropped']);

/**
 * Merge the in-memory state with what is currently on disk. Both a long-running node and
 * short-lived CLI calls share state.json; a plain read-modify-write would silently revert
 * marks written by the other process (drops/read-flags appearing to "come back").
 * `read` is monotonic (union); `delivery` keeps the entry with the newest updatedAt.
 */
export function mergeState(local = {}, disk = {}) {
  const out = { ...disk, ...local };
  out.read = { ...(disk.read ?? {}), ...(local.read ?? {}) };
  const delivery = { ...(disk.delivery ?? {}) };
  for (const [id, entry] of Object.entries(local.delivery ?? {})) {
    const other = delivery[id];
    if (!other) { delivery[id] = entry; continue; }
    const mine = String(entry?.updatedAt ?? '');
    const theirs = String(other?.updatedAt ?? '');
    delivery[id] = mine >= theirs ? entry : other;
  }
  out.delivery = delivery;
  return out;
}

export class MessageStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.paths = {
      inbox: path.join(dataDir, 'inbox.jsonl'),
      outbox: path.join(dataDir, 'outbox.jsonl'),
      audit: path.join(dataDir, 'audit.jsonl'),
      state: path.join(dataDir, 'state.json'),
      inboxFiles: path.join(dataDir, 'inbox')
    };
    this._cache = new Map();
    this._state = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.paths.inboxFiles, { recursive: true });
    return this;
  }

  _boxFile(box) {
    if (!BOXES.has(box)) throw new Error(`unknown box: ${box}`);
    return this.paths[box];
  }

  async _readJsonl(file) {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const cached = this._cache.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.records;
    const text = await fs.readFile(file, 'utf8');
    const records = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed)) records.push(parsed);
      } catch {
        // Skip torn/corrupt lines; the rest of the log stays usable.
      }
    }
    this._cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, records });
    return records;
  }

  async _appendJsonl(file, record) {
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf8');
    this._cache.delete(file);
    return record;
  }

  async _loadState() {
    // Always start from what is on disk: the node and the CLI are separate processes.
    let disk = {};
    try {
      const raw = JSON.parse(await fs.readFile(this.paths.state, 'utf8'));
      if (isPlainObject(raw)) disk = raw;
    } catch { /* first run, or another process is mid-rename */ }
    this._state = this._state ? mergeState(this._state, disk) : { ...disk };
    this._state.read ??= {};
    this._state.delivery ??= {};
    return this._state;
  }

  async _saveState() {
    const state = await this._loadState();
    const tmp = `${this.paths.state}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.paths.state);
    return state;
  }

  async append(box, record) {
    return this._appendJsonl(this._boxFile(box), record);
  }

  async get(box, id) {
    const records = await this._readJsonl(this._boxFile(box));
    return records.find((r) => r.id === id) ?? null;
  }

  async list(box, query = {}) {
    const {
      since, limit = 50, unreadOnly = false, readOnly = false, thread, peer, from, to, order = 'desc', markRead = false
    } = query;
    const state = await this._loadState();
    let records = await this._readJsonl(this._boxFile(box));
    if (since) {
      const isIso = /^\d{4}-\d{2}-\d{2}T/.test(String(since));
      records = records.filter((r) => (isIso ? String(r.ts) > String(since) : String(r.id) > String(since)));
    }
    if (thread) records = records.filter((r) => r.thread === thread);
    if (from) records = records.filter((r) => r.from?.name === from);
    if (to) records = records.filter((r) => r.to === to || r.to === '*');
    if (peer) {
      records = records.filter((r) => r.from?.name === peer || r.to === peer || r.via === peer);
    }
    if (unreadOnly) records = records.filter((r) => !state.read[r.id]);
    if (readOnly) records = records.filter((r) => !!state.read[r.id]);
    const total = records.length;
    const decorated = records.map((r) => ({
      ...r,
      read: !!state.read[r.id],
      delivery: state.delivery[r.id] ?? r.delivery ?? null
    }));
    decorated.sort((a, b) => (order === 'asc' ? 1 : -1) * String(a.id).localeCompare(String(b.id)));
    const limited = Number.isFinite(limit) && limit > 0 ? decorated.slice(0, limit) : decorated;
    let readState = state;
    if (markRead && limited.length) {
      await this.markRead(limited.map((m) => m.id));
      readState = await this._loadState();   // report the state as it is *after* marking
      for (const message of limited) message.read = true;
    }
    return {
      box,
      count: limited.length,
      total,
      unread: records.filter((r) => !readState.read[r.id]).length,
      latestId: decorated.length ? (order === 'asc' ? decorated[decorated.length - 1].id : decorated[0].id) : null,
      messages: limited
    };
  }

  async markRead(ids) {
    const state = await this._loadState();
    let changed = 0;
    for (const id of ids ?? []) {
      if (id && !state.read[id]) { state.read[id] = nowIso(); changed += 1; }
    }
    if (changed) await this._saveState();
    return changed;
  }

  async unreadCount() {
    const state = await this._loadState();
    const records = await this._readJsonl(this.paths.inbox);
    return records.filter((r) => !state.read[r.id]).length;
  }

  /** Merge messages pulled from a peer's outbox into the local inbox; dedupe by id. */
  async importMessages(records = [], via = 'sync') {
    const existing = new Set((await this._readJsonl(this.paths.inbox)).map((r) => r.id));
    const imported = [];
    for (const record of records) {
      if (!isPlainObject(record) || !record.id || existing.has(record.id)) continue;
      const copy = { ...record, via, importedAt: nowIso() };
      await this._appendJsonl(this.paths.inbox, copy);
      existing.add(record.id);
      imported.push(copy);
    }
    return { imported: imported.length, skipped: records.length - imported.length, messages: imported };
  }

  async setDelivery(id, info) {
    const state = await this._loadState();
    state.delivery[id] = { ...(state.delivery[id] ?? {}), ...info, updatedAt: nowIso() };
    await this._saveState();
    return state.delivery[id];
  }

  async pendingOutbox() {
    const state = await this._loadState();
    const records = await this._readJsonl(this.paths.outbox);
    return records.filter((r) => !TERMINAL_DELIVERY.has(state.delivery[r.id]?.state ?? 'pending'));
  }

  async audit(entry) {
    return this._appendJsonl(this.paths.audit, { ts: nowIso(), ...entry });
  }

  async recentAudit(limit = 50) {
    const records = await this._readJsonl(this.paths.audit);
    records.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return records.slice(0, limit);
  }

  async stats() {
    const [inbox, outbox] = await Promise.all([this._readJsonl(this.paths.inbox), this._readJsonl(this.paths.outbox)]);
    const state = await this._loadState();
    return {
      inbox: inbox.length,
      inboxUnread: inbox.filter((r) => !state.read[r.id]).length,
      outbox: outbox.length,
      outboxPending: outbox.filter((r) => !TERMINAL_DELIVERY.has(state.delivery[r.id]?.state ?? 'pending')).length,
      threads: new Set(inbox.map((r) => r.thread).filter(Boolean)).size
    };
  }

  static newMessageId() {
    return newId('msg');
  }
}
