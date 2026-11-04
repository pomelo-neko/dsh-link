// dsh-link hub (0.8): persistent registry + outbox + audit.
//
// The hub deliberately reuses the node's append-only MessageStore for its outbox so that accepted
// messages survive a crash exactly like a node's own outbox. Node registration and small bits of
// mutable hub state live in separate JSON files written atomically.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.mjs';
import { MessageStore } from './store.mjs';

export class HubStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.paths = {
      nodes: path.join(dataDir, 'nodes.json'),
      state: path.join(dataDir, 'hub-state.json'),
      audit: path.join(dataDir, 'audit.jsonl')
    };
    this.mailbox = new MessageStore(dataDir);
    this._nodes = null;
    this._state = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.mailbox.init();
    return this;
  }

  async _readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      if (err instanceof SyntaxError) return fallback;
      throw err;
    }
  }

  async _writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }

  // ------------------------------------------------------------------ nodes ---
  async loadNodes() {
    if (this._nodes) return this._nodes;
    const raw = await this._readJson(this.paths.nodes, { nodes: [] });
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes.filter((n) => n && typeof n.name === 'string') : [];
    this._nodes = new Map(nodes.map((n) => [n.name, n]));
    return this._nodes;
  }

  async listNodes() {
    const nodes = await this.loadNodes();
    return [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getNode(name) {
    const nodes = await this.loadNodes();
    return nodes.get(String(name ?? '').trim()) ?? null;
  }

  async upsertNode(record) {
    const nodes = await this.loadNodes();
    const name = String(record?.name ?? '').trim();
    if (!name) throw new Error('a node name is required');
    const previous = nodes.get(name) ?? null;
    const next = { ...(previous ?? {}), ...record, name, updatedAt: nowIso() };
    nodes.set(name, next);
    await this._saveNodes(nodes);
    return next;
  }

  async removeNode(name) {
    const nodes = await this.loadNodes();
    const removed = nodes.delete(String(name ?? '').trim());
    if (removed) await this._saveNodes(nodes);
    return removed;
  }

  async _saveNodes(nodes) {
    await this._writeJson(this.paths.nodes, { version: 1, nodes: [...nodes.values()] });
  }

  // ---------------------------------------------------------------- state ---
  async loadState() {
    if (this._state) return this._state;
    const raw = await this._readJson(this.paths.state, {});
    this._state = {
      uses: raw?.uses && typeof raw.uses === 'object' ? raw.uses : {},
      commandTargets: raw?.commandTargets && typeof raw.commandTargets === 'object' ? raw.commandTargets : {},
      sessionsRunning: raw?.sessionsRunning && typeof raw.sessionsRunning === 'object' ? raw.sessionsRunning : {},
      lastEnrollAt: raw?.lastEnrollAt ?? null
    };
    return this._state;
  }

  async _saveState() {
    const state = await this.loadState();
    // Keep the command/session caches bounded; the hub only needs the most recent entries.
    const trim = (table, max) => {
      const entries = Object.entries(table).sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')));
      return Object.fromEntries(entries.slice(0, max));
    };
    state.commandTargets = trim(state.commandTargets, 500);
    state.sessionsRunning = trim(state.sessionsRunning, 200);
    await this._writeJson(this.paths.state, state);
  }

  async tokenUses(tokenId) {
    const state = await this.loadState();
    return Number(state.uses[tokenId] ?? 0);
  }

  async recordEnrollUse(tokenId) {
    const state = await this.loadState();
    state.uses[tokenId] = Number(state.uses[tokenId] ?? 0) + 1;
    state.lastEnrollAt = nowIso();
    await this._saveState();
  }

  async rememberCommand(commandId, peer) {
    if (!commandId) return;
    const state = await this.loadState();
    state.commandTargets[commandId] = { peer, at: nowIso() };
    await this._saveState();
  }

  async commandPeer(commandId) {
    const state = await this.loadState();
    return state.commandTargets[commandId]?.peer ?? null;
  }

  async rememberRunning(peer, payload) {
    const state = await this.loadState();
    state.sessionsRunning[peer] = { at: nowIso(), payload };
    await this._saveState();
  }

  async runningCache() {
    const state = await this.loadState();
    return state.sessionsRunning;
  }

  // ---------------------------------------------------------------- outbox ---
  async appendOutbox(record) {
    const existing = await this.mailbox.get('outbox', record.id);
    if (existing) return existing;
    await this.mailbox.append('outbox', record);
    await this.mailbox.setDelivery(record.id, {
      state: 'pending',
      attempts: 0,
      acceptedAt: nowIso(),
      updatedAt: nowIso()
    });
    return record;
  }

  async getOutbox(id) {
    return this.mailbox.get('outbox', id);
  }

  async pendingOutbox() {
    return this.mailbox.pendingOutbox();
  }

  async setDelivery(id, info) {
    return this.mailbox.setDelivery(id, { ...info, updatedAt: nowIso() });
  }

  async listOutbox({ limit = 50, pendingOnly = false } = {}) {
    const result = await this.mailbox.list('outbox', { limit, order: 'asc' });
    const messages = pendingOnly
      ? result.messages.filter((m) => m.delivery && m.delivery.state !== 'delivered' && m.delivery.state !== 'dropped')
      : result.messages;
    return { count: messages.length, total: result.total, messages };
  }

  async counts() {
    const [nodes, stats, pending] = await Promise.all([this.loadNodes(), this.mailbox.stats(), this.mailbox.pendingOutbox()]);
    return { nodes: nodes.size, outboxPending: pending.length, inbox: stats.inbox };
  }

  // ---------------------------------------------------------------- audit ---
  async audit(entry) {
    return this.mailbox.audit(entry);
  }

  async recentAudit(limit = 100) {
    return this.mailbox.recentAudit(limit);
  }
}
