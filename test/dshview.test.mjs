// Tests for the read-only DSH view (src/dshview.mjs). The fixture is a synthetic DSH home:
// workspaces.json + zstd session logs written frame by frame, including a corrupt frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import {
  DSH_VIEW_CACHE_MS,
  DSH_VIEW_DEFAULTS,
  MAX_LOG_BYTES,
  createDshView,
  decodeSessionLog,
  normalizeDshViewConfig,
  resolveDshHome
} from '../src/dshview.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, '.tmp', 'sa1-' + process.pid);

const WS_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const S1 = 'session-11111111-1111-4111-8111-111111111111';
const S2 = 'session-22222222-2222-4222-8222-222222222222';
const S3 = 'session-33333333-3333-4333-8333-333333333333';
const S4 = 'session-44444444-4444-4444-8444-444444444444';
const BARE = (sessionId) => sessionId.slice('session-'.length);
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const BASE = 1789124000000;
const PROJ_A = path.join(TMP, 'proj-a');
const PROJ_B = path.join(TMP, 'proj-b');

// ------------------------------------------------------------------ event builders

const sessionEvent = (id, cwd) => ({ type: 'session', version: 3, id, createdAt: BASE, cwd, agentPreset: 'ptc' });
const titleEvent = (title, seq) => ({
  type: 'session/title', seq, time: BASE + seq,
  data: { title, messageSeqs: [seq - 1], source: { kind: 'fallback' } }
});
const userEvent = (seq, text) => ({
  type: 'user/message', seq, time: BASE + seq,
  data: { content: [{ type: 'text', text }], role: 'user', id: 'msg-' + seq }
});
const assistantEvent = (seq, parts) => ({
  type: 'assistant/message', seq, time: BASE + seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: parts } }
});
const toolCallEvent = (seq, callId, name, args) => ({
  type: 'tool/call', seq, time: BASE + seq,
  data: { turn: 1, step: 1, callId, name, arguments: args }
});
const toolResultEvent = (seq, callId, text) => ({
  type: 'tool/result', seq, time: BASE + seq,
  data: {
    turn: 1, step: 1,
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }]
    }
  }
});

// ------------------------------------------------------------------ log builders

/** One zstd frame holding the given events as JSONL. */
function frameOf(events) {
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** A log file is several zstd frames concatenated end to end. */
function logOf(...frames) {
  return Buffer.concat(frames);
}

function corruptFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from('this-is-not-a-zstd-frame-body')]);
}

async function writeLog(file, buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  return file;
}

// ------------------------------------------------------------------ fixture home

const S1_LOG = logOf(
  frameOf([sessionEvent(BARE(S1), PROJ_A)]),
  frameOf([titleEvent('Fixture session one', 7)]),
  frameOf([
    userEvent(8, 'first user message'),
    assistantEvent(9, [
      { type: 'reasoning', text: 'thinking about the fixture' },
      { type: 'text', text: 'assistant visible answer' },
      { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' }
    ]),
    toolCallEvent(10, 'call-1', 'read_file', '{"path":"a.txt"}'),
    toolResultEvent(11, 'call-1', 'file contents here')
  ]),
  frameOf([{ type: 'system/message', seq: 12, time: BASE + 12, data: { turn: 1, step: 2, message: { role: 'system', content: [{ type: 'text', text: 'system note' }] } } }])
);

const S2_LOG = logOf(
  frameOf([sessionEvent(BARE(S2), PROJ_A)]),
  frameOf([userEvent(4, 'second session question'), assistantEvent(5, [{ type: 'text', text: 'second session answer' }])])
);

const S3_LOG = logOf(
  frameOf([sessionEvent(BARE(S3), PROJ_A)]),
  frameOf([userEvent(2, 'archived session message')])
);

const S4_LOG = logOf(
  frameOf([sessionEvent(BARE(S4), PROJ_B)]),
  frameOf([userEvent(2, 'before the corrupt frame')]),
  corruptFrame(),
  frameOf([assistantEvent(3, [{ type: 'text', text: 'after the corrupt frame' }])])
);

const LARGE_LOG = (() => {
  const frames = [frameOf([sessionEvent('session-99999999-9999-4999-8999-999999999999', PROJ_B)])];
  for (let i = 0; i < 60; i += 1) {
    const noise = Buffer.from(Array.from({ length: 48 }, (_, n) => String.fromCharCode(33 + ((i * 7 + n * 13) % 90))).join(''), 'utf8').toString('base64');
    frames.push(frameOf([userEvent(100 + i, 'large log line ' + i + ' ' + noise)]));
  }
  return logOf(...frames);
})();

const LARGE_SESSION = 'session-99999999-9999-4999-8999-999999999999';

let fixturePromise = null;
let largeHomePromise = null;

/** Second, isolated home holding one oversized session (its own registry). */
async function largeHome() {
  if (largeHomePromise) return largeHomePromise;
  largeHomePromise = (async () => {
    await fixture();
    const home = path.join(TMP, 'large-home');
    const logPath = path.join(home, 'sessions', 'proj-b', BARE(LARGE_SESSION), 'session.v3.jsonl.zstd');
    await writeLog(logPath, LARGE_LOG);
    await fs.mkdir(path.join(home, 'storages'), { recursive: true });
    await fs.writeFile(
      path.join(home, 'storages', 'workspace.json'),
      JSON.stringify({
        global: { workspaceIds: [WS_B], archivedSessionIds: [] },
        tables: { workspaces: { [WS_B]: { path: PROJ_B, title: 'Large Fixture', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }
      }),
      'utf8'
    );
    return { home, logPath };
  })();
  return largeHomePromise;
}

async function fixture() {
  if (fixturePromise) return fixturePromise;
  fixturePromise = (async () => {
    await fs.rm(TMP, { recursive: true, force: true, maxRetries: 3 });
    const home = path.join(TMP, 'home');
    const logs = {
      s1: path.join(home, 'sessions', 'proj-a', BARE(S1), 'session.v3.jsonl.zstd'),
      s2: path.join(home, 'sessions', 'proj-a', S2, 'session.v3.jsonl.zstd'),
      s3: path.join(home, 'sessions', 'proj-a', S3, 'session.v3.jsonl.zstd'),
      s4: path.join(home, 'sessions', 'proj-b', BARE(S4), 'session.v3.jsonl.zstd')
    };
    await writeLog(logs.s1, S1_LOG);
    await writeLog(logs.s2, S2_LOG);
    await writeLog(logs.s3, S3_LOG);
    await writeLog(logs.s4, S4_LOG);
    // Deterministic activity order: S4 newest, then S3, S2, S1.
    const stamp = (seconds) => new Date(Date.parse('2026-01-02T00:00:00.000Z') + seconds * 1000);
    await fs.utimes(logs.s1, stamp(10), stamp(10));
    await fs.utimes(logs.s2, stamp(20), stamp(20));
    await fs.utimes(logs.s3, stamp(30), stamp(30));
    await fs.utimes(logs.s4, stamp(40), stamp(40));
    await fs.mkdir(PROJ_A, { recursive: true });
    await fs.mkdir(PROJ_B, { recursive: true });
    const registry = {
      unit: 'session',
      global: { initialized: true, workspaceIds: [WS_A, WS_B], archivedSessionIds: [S3] },
      tables: {
        workspaces: {
          [WS_A]: {
            path: PROJ_A,
            title: 'Fixture Alpha',
            sessionIds: [S1, S2, S3],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T10:00:00.000Z'
          },
          [WS_B]: {
            path: PROJ_B,
            title: 'Fixture Beta',
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T11:00:00.000Z'
          }
        }
      }
    };
    await fs.mkdir(path.join(home, 'storages'), { recursive: true });
    const registryFile = path.join(home, 'storages', 'workspace.json');
    await fs.writeFile(registryFile, JSON.stringify(registry, null, 2) + '\n', 'utf8');
    // Projection cache: the only title source for S2. Its file name deliberately drops the
    // session- prefix the directory carries, so the name fallback is exercised too.
    const projcacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
    await fs.mkdir(projcacheDir, { recursive: true });
    await fs.writeFile(
      path.join(projcacheDir, BARE(S2) + '.json'),
      JSON.stringify({ version: 7, record: { identity: { cwd: PROJ_A, createdAt: BASE }, rows: { title: { ver: 1, seq: 9, val: 'Fallback title from cache' }, other: { title: 'not this one' } } } }),
      'utf8'
    );
    return { home, logs, registryFile, registry };
  })();
  return fixturePromise;
}

async function viewFor(home, cfg = {}, extra = {}) {
  const built = await fixture();
  return createDshView({
    cfg: { home: home ?? built.home, ...cfg },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...extra
  });
}

// ------------------------------------------------------------------------ tests

test('dshview: normalizeDshViewConfig coerces junk and clamps the numeric knobs', () => {
  assert.deepEqual(normalizeDshViewConfig(), DSH_VIEW_DEFAULTS);
  assert.deepEqual(normalizeDshViewConfig(null), DSH_VIEW_DEFAULTS);
  assert.deepEqual(normalizeDshViewConfig([]), DSH_VIEW_DEFAULTS);
  assert.deepEqual(normalizeDshViewConfig(42), DSH_VIEW_DEFAULTS);
  const cfg = normalizeDshViewConfig({
    enabled: 'yes',
    home: '  D:\\dsh  ',
    exposeWorkspaces: 1,
    exposeTranscripts: 'true',
    transcriptMaxChars: 5,
    transcriptMaxMessages: 99999,
    excludeWorkspaces: ' alpha , beta ,, '
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.home, 'D:\\dsh');
  assert.equal(cfg.exposeWorkspaces, true);
  assert.equal(cfg.exposeTranscripts, true);
  assert.equal(cfg.transcriptMaxChars, 200);
  assert.equal(cfg.transcriptMaxMessages, 10000);
  assert.deepEqual(cfg.excludeWorkspaces, ['alpha', 'beta']);
  assert.deepEqual(normalizeDshViewConfig({ excludeWorkspaces: [1, 'x', null] }).excludeWorkspaces, ['1', 'x', 'null']);
  assert.equal(DSH_VIEW_DEFAULTS.enabled, false);
});

test('dshview: resolveDshHome prefers cfg.home, then DSH_HOME, then ~/.dsh', async () => {
  const built = await fixture();
  assert.equal(resolveDshHome({ home: built.home }), path.resolve(built.home));
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = path.join(TMP, 'env-home');
    assert.equal(resolveDshHome({}), path.resolve(path.join(TMP, 'env-home')));
    assert.equal(resolveDshHome({ home: built.home }), path.resolve(built.home));
    delete process.env.DSH_HOME;
    assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
    assert.equal(resolveDshHome({ home: '   ' }), path.join(os.homedir(), '.dsh'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
});

test('dshview: decodeSessionLog splits concatenated zstd frames', async () => {
  const built = await fixture();
  const decoded = decodeSessionLog(S1_LOG);
  assert.equal(decoded.frames, 4);
  assert.equal(decoded.corruptFrames, 0);
  assert.equal(decoded.events.length, 7);
  assert.equal(decoded.events[0].type, 'session');
  assert.equal(decoded.events[1].data.title, 'Fixture session one');
  const fromDisk = decodeSessionLog(built.logs.s1);
  assert.equal(fromDisk.frames, 4);
  assert.deepEqual(fromDisk.events, decoded.events);
  assert.deepEqual(decodeSessionLog(Buffer.alloc(0)), { events: [], frames: 0, corruptFrames: 0 });
  assert.deepEqual(decodeSessionLog(path.join(TMP, 'does-not-exist.zstd')), { events: [], frames: 0, corruptFrames: 0 });
  assert.deepEqual(decodeSessionLog(Buffer.from('plain text, no zstd magic')), { events: [], frames: 0, corruptFrames: 0 });
  const capped = decodeSessionLog(S1_LOG, { maxBytes: 64, maxFrames: 1 });
  assert.equal(capped.frames, 1);
});

test('dshview: decodeSessionLog skips corrupt frames instead of throwing', () => {
  const decoded = decodeSessionLog(S4_LOG);
  assert.equal(decoded.corruptFrames, 1);
  assert.equal(decoded.frames, 3);
  const texts = decoded.events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
  assert.equal(texts.length, 2);
  assert.equal(texts[0].data.content[0].text, 'before the corrupt frame');
  assert.equal(texts[1].data.message.content[0].text, 'after the corrupt frame');
  assert.equal(MAX_LOG_BYTES, 32 * 1024 * 1024);
});

test('dshview: available() reports a usable home and a missing one', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const ok = view.available();
  assert.equal(ok.ok, true);
  assert.equal(ok.home, path.resolve(built.home));
  assert.equal(ok.enabled, false);
  assert.equal(ok.reason, undefined);
  const enabled = (await viewFor(built.home, { enabled: true })).available();
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);
  const missing = (await viewFor(path.join(TMP, 'no-such-home'))).available();
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'home-missing');
  assert.equal(missing.home, path.resolve(path.join(TMP, 'no-such-home')));
});

test('dshview: workspaces() lists titles, paths, session counts and activity', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const list = await view.workspaces();
  assert.equal(list.length, 2);
  const alpha = list.find((entry) => entry.id === WS_A);
  const beta = list.find((entry) => entry.id === WS_B);
  assert.equal(alpha.title, 'Fixture Alpha');
  assert.equal(alpha.path, PROJ_A);
  assert.equal(alpha.archived, false);
  assert.equal(alpha.sessions, 3);
  assert.equal(alpha.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(alpha.updatedAt, '2026-01-01T10:00:00.000Z');
  assert.equal(alpha.lastActivityAt, '2026-01-02T00:00:30.000Z');
  assert.equal(beta.sessions, 1, 'S4 belongs to beta through its cwd');
  assert.equal(beta.lastActivityAt, '2026-01-02T00:00:40.000Z');
  const registry = await view.registry();
  assert.equal(registry.tables.workspaces[WS_A].title, 'Fixture Alpha');
  assert.deepEqual(registry.global.archivedSessionIds, [S3]);
});

test('dshview: workspaces() honours excludeWorkspaces', async () => {
  const built = await fixture();
  const byId = await (await viewFor(built.home, { excludeWorkspaces: [WS_B] })).workspaces();
  assert.deepEqual(byId.map((entry) => entry.id), [WS_A]);
  const byTitle = await (await viewFor(built.home, { excludeWorkspaces: ['fixture alpha'] })).workspaces();
  assert.deepEqual(byTitle.map((entry) => entry.id), [WS_B]);
  const byPath = await (await viewFor(built.home, { excludeWorkspaces: [PROJ_A] })).workspaces();
  assert.deepEqual(byPath.map((entry) => entry.id), [WS_B]);
  const excludedSessions = await (await viewFor(built.home, { excludeWorkspaces: [WS_A] })).sessions({ includeArchived: true });
  assert.deepEqual(excludedSessions.map((entry) => entry.sessionId), [S4]);
});

test('dshview: sessions() filters by workspace, query, archived flag and limit', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const visible = await view.sessions();
  assert.equal(visible.length, 3);
  assert.ok(!visible.some((entry) => entry.archived));
  const all = await view.sessions({ includeArchived: true });
  assert.equal(all.length, 4);
  assert.equal(all[0].sessionId, S4, 'newest activity first');
  assert.equal(all[3].sessionId, S1, 'oldest activity last');
  assert.equal(all.find((entry) => entry.sessionId === S3).archived, true);
  const alpha = await view.sessions({ workspace: WS_A, includeArchived: true });
  assert.deepEqual(alpha.map((entry) => entry.sessionId).sort(), [S1, S2, S3].sort());
  const alphaByTitle = await view.sessions({ workspace: 'Fixture Alpha' });
  assert.deepEqual(alphaByTitle.map((entry) => entry.sessionId).sort(), [S1, S2].sort());
  const beta = await view.sessions({ workspace: 'fixture beta' });
  assert.deepEqual(beta.map((entry) => entry.sessionId), [S4]);
  const byTitleQuery = await view.sessions({ query: 'fallback title', includeArchived: true });
  assert.deepEqual(byTitleQuery.map((entry) => entry.sessionId), [S2]);
  const byCwdQuery = await view.sessions({ query: 'proj-b', includeArchived: true });
  assert.deepEqual(byCwdQuery.map((entry) => entry.sessionId), [S4]);
  assert.equal((await view.sessions({ includeArchived: true, limit: 2 })).length, 2);
  assert.equal((await view.sessions({ limit: 0 })).length, 0);
  assert.equal(await view.sessions({ workspace: 'no-such-workspace' }).then((rows) => rows.length), 0);
});

test('dshview: sessions() meta carries title source, cwd, size and message counts', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const one = await view.session(S1);
  assert.equal(one.title, 'Fixture session one');
  assert.equal(one.titleSource, 'session/title');
  assert.equal(one.cwd, PROJ_A);
  assert.equal(one.workspaceId, WS_A);
  assert.equal(one.archived, false);
  assert.equal(one.createdAt, new Date(BASE).toISOString());
  assert.equal(one.updatedAt, '2026-01-02T00:00:10.000Z');
  assert.equal(one.sizeBytes, S1_LOG.length);
  assert.equal(one.messages, 6);
  assert.equal(one.messagesExact, true);
  const two = await view.session(S2);
  assert.equal(two.title, 'Fallback title from cache');
  assert.equal(two.titleSource, 'projcache');
  assert.equal(two.messagesExact, true);
  const three = await view.session(S3);
  assert.equal(three.archived, true);
  assert.equal(three.titleSource, 'none');
  assert.equal(three.title, '');
});

test('dshview: session() accepts prefixed and bare ids and returns null when unknown', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const prefixed = await view.session(S1);
  const bare = await view.session(BARE(S1));
  assert.equal(prefixed.sessionId, S1);
  assert.equal(bare.sessionId, S1);
  assert.deepEqual(bare, prefixed);
  assert.equal(await view.session('session-00000000-0000-4000-8000-000000000000'), null);
  await assert.rejects(async () => view.session(''), /session id is required/);
  await assert.rejects(async () => view.session(null), /session id is required/);
});

test('dshview: transcript() orders messages, resolves tools and clips text', async () => {
  const built = await fixture();
  const view = await viewFor(built.home, { transcriptMaxChars: 400 });
  const result = await view.transcript(S1);
  assert.equal(result.total, 6);
  assert.equal(result.truncated, false);
  assert.equal(result.corruptFrames, 0);
  assert.equal(result.session.sessionId, S1);
  assert.deepEqual(result.messages.map((message) => message.kind), ['user', 'reasoning', 'assistant', 'tool-call', 'tool-result', 'system']);
  assert.deepEqual(result.messages.map((message) => message.seq), [8, 9, 9, 10, 11, 12]);
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant', 'assistant', 'assistant', 'tool', 'system']);
  assert.equal(result.messages[0].text, 'first user message');
  assert.equal(result.messages[1].text, 'thinking about the fixture');
  assert.equal(result.messages[2].text, 'assistant visible answer');
  assert.equal(result.messages[3].tool, 'read_file');
  assert.equal(result.messages[3].text, '{"path":"a.txt"}');
  assert.equal(result.messages[4].tool, 'read_file', 'the result reuses the tool name of its call');
  assert.equal(result.messages[4].text, 'file contents here');
  assert.equal(result.messages[5].text, 'system note');
  assert.ok(result.messages.every((message) => message.truncated === false));
  const clipped = await view.transcript(S1, { maxChars: 8 });
  assert.equal(clipped.total, 6);
  assert.equal(clipped.messages[0].text, 'first us');
  assert.equal(clipped.messages[0].truncated, true);
  const tiny = await viewFor(built.home, { transcriptMaxChars: 200, transcriptMaxMessages: 2 });
  const capped = await tiny.transcript(S1, { limit: 50 });
  assert.equal(capped.total, 6);
  assert.equal(capped.messages.length, 2, 'transcriptMaxMessages caps one response');
  assert.equal(capped.truncated, true);
});

test('dshview: transcript() supports limit, offset and tail', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const head = await view.transcript(S1, { limit: 2 });
  assert.deepEqual(head.messages.map((message) => message.kind), ['user', 'reasoning']);
  assert.equal(head.truncated, true);
  const middle = await view.transcript(S1, { offset: 1, limit: 2 });
  assert.deepEqual(middle.messages.map((message) => message.seq), [9, 9]);
  assert.equal(middle.total, 6);
  const tail = await view.transcript(S1, { tail: true, limit: 2 });
  assert.deepEqual(tail.messages.map((message) => message.kind), ['tool-result', 'system']);
  assert.equal(tail.truncated, true);
  const tailOffset = await view.transcript(S1, { tail: true, limit: 2, offset: 1 });
  assert.deepEqual(tailOffset.messages.map((message) => message.kind), ['tool-call', 'tool-result']);
  const whole = await view.transcript(S1, { offset: 0, limit: 100 });
  assert.equal(whole.messages.length, 6);
  assert.equal(whole.truncated, false);
  const beyond = await view.transcript(S1, { offset: 99, limit: 5 });
  assert.equal(beyond.messages.length, 0);
  assert.equal(beyond.total, 6);
  const unknown = await view.transcript('session-00000000-0000-4000-8000-000000000000');
  assert.deepEqual(unknown, { session: null, total: 0, messages: [], truncated: false, corruptFrames: 0 });
});

test('dshview: transcript() survives corrupt frames and keeps later messages', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const result = await view.transcript(S4);
  assert.equal(result.corruptFrames, 1);
  assert.equal(result.total, 2);
  assert.deepEqual(result.messages.map((message) => message.text), ['before the corrupt frame', 'after the corrupt frame']);
  assert.equal(result.truncated, false);
});

test('dshview: oversized logs are read from the head only', async () => {
  const large = await largeHome();
  const size = (await fs.stat(large.logPath)).size;
  assert.ok(size > 4096, 'fixture log must be bigger than the read cap');
  const full = createDshView({
    cfg: { home: large.home, transcriptMaxMessages: 10000 },
    logger: { debug() {} },
    maxLogBytes: MAX_LOG_BYTES
  });
  const whole = await full.transcript(LARGE_SESSION, { limit: 10000 });
  assert.equal(whole.total, 60);
  assert.equal(whole.truncated, false);
  assert.equal(whole.session.messagesExact, true);
  const capped = createDshView({
    cfg: { home: large.home, transcriptMaxMessages: 10000 },
    logger: { debug() {} },
    maxLogBytes: 2048
  });
  const partial = await capped.transcript(LARGE_SESSION, { limit: 10000 });
  assert.ok(partial.total > 0 && partial.total < 60, 'the head window only holds part of the log');
  assert.equal(partial.truncated, true);
  assert.equal(partial.session.messagesExact, false);
  assert.equal(partial.session.sizeBytes, size);
  const viaDecoder = decodeSessionLog(await fs.readFile(large.logPath), { maxBytes: 2048 });
  assert.ok(viaDecoder.frames > 0 && viaDecoder.frames < 61);
});

test('dshview: empty and vanishing logs are reported without throwing', async () => {
  const built = await fixture();
  const emptyDir = path.join(built.home, 'sessions', 'proj-b', 'session-55555555-5555-4555-8555-555555555555');
  const emptyLog = path.join(emptyDir, 'session.v3.jsonl.zstd');
  await fs.mkdir(emptyDir, { recursive: true });
  await fs.writeFile(emptyLog, Buffer.alloc(0));
  const view = await viewFor(built.home);
  const rows = await view.sessions({ includeArchived: true });
  const empty = rows.find((entry) => entry.sessionId === 'session-55555555-5555-4555-8555-555555555555');
  assert.equal(empty.messages, 0);
  assert.equal(empty.sizeBytes, 0);
  assert.equal(empty.titleSource, 'none');
  const decoded = await view.transcript(empty.sessionId);
  assert.equal(decoded.total, 0);
  assert.deepEqual(decoded.messages, []);
  assert.equal(decoded.session.sessionId, empty.sessionId);
  // The log disappears while the index still holds it: still no throw.
  const gone = await viewFor(built.home);
  assert.equal((await gone.session(S2)).sessionId, S2);
  await fs.rename(built.logs.s2, built.logs.s2 + '.moved');
  const orphan = await gone.transcript(S2);
  assert.equal(orphan.total, 0);
  assert.equal(orphan.session.sessionId, S2);
  assert.deepEqual(orphan.messages, []);
  await fs.rename(built.logs.s2 + '.moved', built.logs.s2);
  await fs.rm(emptyDir, { recursive: true, force: true });
});

test('dshview: concurrent scans share one index build', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const [a, b, c] = await Promise.all([view.sessions({ includeArchived: true }), view.workspaces(), view.sessions()]);
  assert.equal(a.length, 4);
  assert.equal(b.length, 2);
  assert.equal(c.length, 3);
  assert.equal(view.stats().indexed, 4);
});

test('dshview: refresh() drops the cached registry and session index', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const before = await view.workspaces();
  assert.equal(before.find((entry) => entry.id === WS_B).title, 'Fixture Beta');
  assert.equal(view.stats().indexed, 4);
  const renamed = JSON.parse(JSON.stringify(built.registry));
  renamed.tables.workspaces[WS_B].title = 'Fixture Beta Renamed';
  await fs.writeFile(built.registryFile, JSON.stringify(renamed, null, 2) + '\n', 'utf8');
  const cached = await view.workspaces();
  assert.equal(cached.find((entry) => entry.id === WS_B).title, 'Fixture Beta', 'still inside the cache window');
  assert.equal(view.stats().indexed, 4);
  view.refresh();
  const fresh = await view.workspaces();
  assert.equal(fresh.find((entry) => entry.id === WS_B).title, 'Fixture Beta Renamed');
  assert.deepEqual(view.stats().cacheMs, DSH_VIEW_CACHE_MS);
  await fs.writeFile(built.registryFile, JSON.stringify(built.registry, null, 2) + '\n', 'utf8');
  view.refresh();
  await fs.rm(built.logs.s4, { force: true });
  const gone = await view.sessions({ includeArchived: true });
  assert.equal(gone.length, 3, 'the index follows the disk on the next scan');
  assert.equal(view.stats().indexed, 3);
  await writeLog(built.logs.s4, S4_LOG);
  view.refresh();
  assert.equal((await view.sessions({ includeArchived: true })).length, 4);
});

test('dshview: a missing, empty or broken DSH home never throws', async () => {
  const built = await fixture();
  const emptyHome = path.join(TMP, 'empty-home');
  await fs.mkdir(emptyHome, { recursive: true });
  const empty = await viewFor(emptyHome);
  assert.equal(empty.available().ok, true);
  assert.equal(empty.stats().indexed, 0);
  assert.equal(empty.stats().lastScanAt, null);
  assert.deepEqual(await empty.workspaces(), []);
  assert.deepEqual(await empty.sessions(), []);
  assert.equal(await empty.session(S1), null);
  assert.deepEqual(await empty.transcript(S1), { session: null, total: 0, messages: [], truncated: false, corruptFrames: 0 });
  assert.equal(await empty.registry(), null);
  assert.equal(empty.stats().indexed, 0);
  assert.equal(Number.isFinite(Date.parse(empty.stats().lastScanAt)), true, 'the scan ran and recorded its time');
  const brokenHome = path.join(TMP, 'broken-home');
  await fs.mkdir(path.join(brokenHome, 'storages'), { recursive: true });
  await fs.writeFile(path.join(brokenHome, 'storages', 'workspace.json'), '{ not json at all', 'utf8');
  await fs.mkdir(path.join(brokenHome, 'sessions', 'slug', 'session-77777777-7777-4777-8777-777777777777'), { recursive: true });
  const broken = await viewFor(brokenHome);
  assert.equal(broken.available().ok, true);
  assert.equal(await broken.registry(), null);
  assert.deepEqual(await broken.workspaces(), []);
  assert.deepEqual(await broken.sessions({ includeArchived: true }), [], 'a session directory without a log is ignored');
  const missing = await viewFor(path.join(TMP, 'nowhere-at-all'));
  assert.deepEqual(await missing.workspaces(), []);
  assert.deepEqual(await missing.sessions(), []);
  assert.equal(await missing.registry(), null);
  const noHome = createDshView({ cfg: {}, logger: {} });
  assert.equal(typeof noHome.available().home, 'string');
  assert.equal(typeof (await noHome.sessions()).length, 'number');
  assert.equal(built.home, path.join(TMP, 'home'));
});

test('dshview: stats() reports the home, index size and cache window', async () => {
  const built = await fixture();
  const view = await viewFor(built.home);
  const before = view.stats();
  assert.equal(before.indexed, 0);
  assert.equal(before.lastScanAt, null);
  await view.sessions({ includeArchived: true });
  const after = view.stats();
  assert.equal(after.home, path.resolve(built.home));
  assert.equal(after.indexed, 4);
  assert.equal(after.cacheMs, 5000);
  assert.equal(Number.isFinite(Date.parse(after.lastScanAt)), true);
});
