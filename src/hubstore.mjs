// dsh-link hub (0.8): persistent registry + outbox + audit.
//
// The hub deliberately reuses the node's append-only MessageStore for its outbox so that accepted
// messages survive a crash exactly like a node's own outbox. Node registration and small bits of
// mutable hub state live in separate JSON files written atomically.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { newId, nowIso, sha256Hex } from './util.mjs';
import { MessageStore } from './store.mjs';

export function fingerprintKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

export class HubStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.paths = {
      nodes: path.join(dataDir, 'nodes.json'),
      state: path.join(dataDir, 'hub-state.json'),
      audit: path.join(dataDir, 'audit.jsonl'),
      phones: path.join(dataDir, 'phones.json'),
      phoneBootstraps: path.join(dataDir, 'phone-bootstrap.json')
    };
    this.mailbox = new MessageStore(dataDir);
    this._nodes = null;
    this._state = null;
    this._phones = null;
    this._phonesSig = null;
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

  // A running hub must see changes another process (the CLI or the console) wrote to the same
  // data directory. Tokens already reload per request (see src/hub.mjs); the phone registry is
  // cached, so track the file signature and drop the cache when phones.json changed underneath.
  async _fileSignature(file) {
    try {
      const stat = await fs.stat(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (err) {
      if (err.code === 'ENOENT') return 'missing';
      throw err;
    }
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

  // ---------------------------------------------------------------- phones ---
  // B2/B4: phones are named by the SHA-256 fingerprint of the client certificate the phone CA
  // issued. The private key never leaves the phone; the hub only keeps the fingerprint.
  async loadPhones() {
    const sig = await this._fileSignature(this.paths.phones);
    if (this._phones && sig === this._phonesSig) return this._phones;
    const raw = await this._readJson(this.paths.phones, { phones: [] });
    const phones = Array.isArray(raw?.phones) ? raw.phones.filter((p) => p && typeof p.id === 'string') : [];
    this._phones = new Map(phones.map((p) => [p.id, p]));
    this._phonesSig = sig;
    return this._phones;
  }

  async listPhones() {
    const phones = await this.loadPhones();
    return [...phones.values()].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }

  async getPhone(idOrFingerprint) {
    const phones = await this.loadPhones();
    const key = String(idOrFingerprint ?? '').trim();
    if (!key) return null;
    if (phones.has(key)) return phones.get(key);
    for (const phone of phones.values()) if (phone.deviceId === key) return phone;
    const fp = fingerprintKey(key);
    if (!fp) return null;
    for (const phone of phones.values()) {
      if (fingerprintKey(phone.fingerprint) === fp) return phone;
    }
    return null;
  }

  async getPhoneByFingerprint(fingerprint) {
    return this.getPhone(fingerprint);
  }

  async countPhones({ activeOnly = false } = {}) {
    const phones = await this.listPhones();
    return activeOnly ? phones.filter((p) => p.status !== 'revoked').length : phones.length;
  }

  async upsertPhone(record) {
    const phones = await this.loadPhones();
    const id = String(record?.id ?? '').trim();
    if (!id) throw new Error('a phone id is required');
    const previous = phones.get(id) ?? null;
    const next = { ...(previous ?? {}), ...record, id, updatedAt: nowIso() };
    phones.set(id, next);
    await this._savePhones(phones);
    return next;
  }

  async revokePhone(idOrFingerprint, reason = 'revoked from the hub') {
    const phones = await this.loadPhones();
    const phone = await this.getPhone(idOrFingerprint);
    if (!phone) return null;
    const next = { ...phone, status: 'revoked', revokedAt: nowIso(), revokeReason: String(reason ?? '').slice(0, 300) };
    phones.set(phone.id, next);
    await this._savePhones(phones);
    return next;
  }

  async recordPhoneSeen(idOrFingerprint) {
    const phones = await this.loadPhones();
    const phone = await this.getPhone(idOrFingerprint);
    if (!phone) return null;
    const next = { ...phone, lastSeenAt: nowIso() };
    phones.set(phone.id, next);
    await this._savePhones(phones);
    return next;
  }

  async _savePhones(phones) {
    await this._writeJson(this.paths.phones, { version: 1, phones: [...phones.values()] });
    this._phonesSig = await this._fileSignature(this.paths.phones);
  }

  // One-time bootstrap secrets. Only the SHA-256 hash is stored; the plaintext travels in the
  // dshlink2: code and is discarded once the phone has exchanged it for a certificate.
  async loadPhoneBootstraps() {
    const raw = await this._readJson(this.paths.phoneBootstraps, { bootstraps: [] });
    return Array.isArray(raw?.bootstraps) ? raw.bootstraps.filter((b) => b && typeof b.id === 'string') : [];
  }

  async listPhoneBootstraps(limit = 50) {
    const bootstraps = await this.loadPhoneBootstraps();
    return bootstraps
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  async createPhoneBootstrap({ label = '', secret, expiresAt = null, maxUses = 1, note = null } = {}) {
    const plaintext = String(secret ?? '').trim();
    if (!plaintext) throw new Error('a bootstrap secret is required');
    const bootstraps = await this.loadPhoneBootstraps();
    const entry = {
      id: newId('pb'),
      label: String(label ?? '').slice(0, 120),
      hash: sha256Hex(plaintext),
      note: note ? String(note).slice(0, 300) : null,
      createdAt: nowIso(),
      expiresAt,
      maxUses: Math.max(1, Math.min(1000, Number(maxUses) || 1)),
      uses: 0,
      usedAt: null,
      status: 'active'
    };
    bootstraps.push(entry);
    await this._savePhoneBootstraps(bootstraps);
    return entry;
  }

  async consumePhoneBootstrap(id, secret, now = Date.now()) {
    const bootstraps = await this.loadPhoneBootstraps();
    const entry = bootstraps.find((b) => b.id === String(id ?? '').trim());
    if (!entry) return { ok: false, reason: 'unknown bootstrap token' };
    if (entry.status !== 'active') return { ok: false, reason: 'bootstrap token already used' };
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) {
      entry.status = 'expired';
      await this._savePhoneBootstraps(bootstraps);
      return { ok: false, reason: 'bootstrap token expired' };
    }
    if (entry.hash !== sha256Hex(String(secret ?? ''))) return { ok: false, reason: 'bad bootstrap secret' };
    entry.uses = Number(entry.uses ?? 0) + 1;
    entry.usedAt = nowIso();
    if (entry.uses >= Number(entry.maxUses ?? 1)) entry.status = 'used';
    await this._savePhoneBootstraps(bootstraps);
    return { ok: true, entry };
  }

  async revokePhoneBootstrap(id) {
    const bootstraps = await this.loadPhoneBootstraps();
    const entry = bootstraps.find((b) => b.id === String(id ?? '').trim());
    if (!entry) return null;
    entry.status = 'revoked';
    entry.revokedAt = nowIso();
    await this._savePhoneBootstraps(bootstraps);
    return entry;
  }

  async _savePhoneBootstraps(bootstraps) {
    await this._writeJson(this.paths.phoneBootstraps, { version: 1, bootstraps });
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
