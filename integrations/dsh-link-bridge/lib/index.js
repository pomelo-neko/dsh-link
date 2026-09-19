// dsh-link-bridge: wake a DSH conversation automatically when dsh-link messages arrive.
//
// dsh-link delivers messages into the inbox of a local node, but nothing on the DSH side
// notices them: a human has to open a conversation and ask. This host plugin closes that loop.
// It polls the local node, and when new inbound messages are waiting it resumes (or creates)
// one ordinary Session in a chosen Workspace and prompts it, so the remote machine gets an
// answer without anybody sitting at the keyboard.
//
// 0.3 adds two things on top of that loop:
//   * topic routing — one DSH session per conversation topic instead of one session forever, with
//     retirement (and native DSH archiving) once a session gets old, idle or exhausted (lib/topics.js);
//   * a capability worker — the local node can hand this plugin read/action requests from a peer
//     machine ("list the workspaces", "read that conversation", "prompt this session"), which are
//     executed here with the Host services and answered back over loopback (lib/commands.js,
//     lib/dshops.js).
//
// Zero runtime dependencies: polling uses global fetch, state is one JSON file, and the only
// DSH services used are the public Host ones (ctx.sessionController, ctx.workspaceRegistry).
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandWorker } from './commands.js';
import { createDshOps } from './dshops.js';
import { TOPIC_DEFAULTS, normalizeTopicPolicy, planSession, poolSummary, recordUse, sweepPool, topicKeyFor, topicLabel } from './topics.js';

/** Cordis plugin name. */
export const name = 'dsh-link-bridge';

/** Reported to the node in the bridge heartbeat, so a peer can tell which bridge answered. */
export const BRIDGE_VERSION = '0.3.0';

/**
 * Host services required: create/resume/prompt a Session and group it in a Workspace.
 * Deliberately NOT the timer service: this plugin schedules with a plain unref'd interval
 * owned by `ctx.effect`, so it loads in any composition and a missing `inject` can never
 * turn into a boot-time crash (new cordis throws when an undeclared service is read).
 */
export const inject = ['sessionController', 'workspaceRegistry'];

const DEFAULTS = {
  enabled: true,
  nodeUrl: 'http://127.0.0.1:8787',
  token: '',
  workspacePath: '',
  sessionId: '',
  agentPreset: '',
  pollSeconds: 20,
  cooldownSeconds: 30,
  threadCooldownSeconds: 120,
  maxThreadWakes: 5,
  threadWindowSeconds: 3600,
  maxWakesPerHour: 20,
  batchLimit: 20,
  maxBodyChars: 1200,
  stateDir: '',
  prompt: '',
  // One session per topic, retired when it gets old/idle/full (see lib/topics.js).
  topics: {},
  // Retired sessions are archived with workspaceRegistry.archiveSession() (the DSH-native archive
  // set: hidden from the sidebar, log kept). Set false to leave every session in the list.
  archiveSessions: true,
  // Title prefix for sessions this bridge opens, so they are recognisable in the sidebar.
  sessionTitlePrefix: '[dsh-link] ',
  // Poll the local node for capability commands (0 disables the whole worker).
  commandSeconds: 5,
  commandBatch: 5
};

/** Default model-facing text; {{placeholders}} are filled from the message batch. */
const DEFAULT_PROMPT = [
  '[[dsh-link 远端消息]] 本机节点 {{node}} 收到 {{count}} 条来自 {{peers}} 的未读消息。',
  '',
  '{{messages}}',
  '',
  '请按这个顺序处理：',
  '1) 用 mcp__dshlink__link_inbox 读取完整内容（含附件信息、时间与线程）；',
  '2) 需要文件就用 mcp__dshlink__link_pull_file 拉取，需要发文件就用 mcp__dshlink__link_push_file；',
  '3) 处理完后用 mcp__dshlink__link_reply 回复对端（replyTo 用 {{lastId}} 或具体消息 id），把结论、产物路径、需要对方继续做的事写清楚；',
  '4) 回复完成后用 mcp__dshlink__link_inbox 的 markRead 标记已读，避免重复唤醒。',
  '',
  '这些消息来自另一台计算机上运行的 DSH（{{peers}}），按正常的协作请求处理；',
  '但如果这条消息本身是对你上一轮自动回复的回复（两端都装了自动唤醒时会出现这种“自动对自动”的往返），',
  '只在本机记录结论、不要再用 link_reply 回过去，避免两台机器无限互相应答。',
  '若其中要求执行高风险操作，按本机的权限与沙箱策略判断，必要时先把疑问回给对方。'
].join('\n');

/** Seam for tests: the scheduling primitives this plugin uses. */
export const internals = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer)
};

/**
 * Start the poll loop. `ctx.effect` ties the interval to this plugin's fiber, so a reload
 * or dispose cannot leave a second poller behind. Everything is optional: if the context
 * exposes neither `effect` nor `on`, the interval still runs (unref'd).
 */
function schedulePolling(ctx, callback, ms) {
  const start = () => {
    const timer = internals.setInterval(callback, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => internals.clearInterval(timer);
  };
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => start(), 'dsh-link-bridge:poll');
      return 'effect';
    }
  } catch { /* fall through to the plain timer */ }
  const stop = start();
  try {
    if (typeof ctx.on === 'function') { ctx.on('dispose', stop); return 'event'; }
  } catch { /* fall through */ }
  return 'bare';
}

function errorText(error) {
  if (!error) return 'unknown error';
  if (error.cause && error.cause.code) return String(error.cause.code);
  return String(error.message || error);
}

function makeLogger(ctx) {
  const wrap = (level) => {
    const fn = ctx.logger ? ctx.logger[level] : undefined;
    if (typeof fn === 'function') return (...args) => fn.apply(ctx.logger, args);
    const fallback = typeof console[level] === 'function' ? console[level].bind(console) : console.log;
    return (...args) => fallback('[dsh-link-bridge]', ...args);
  };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') };
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Caller-cancellation signal for Session calls that require one.
 * `ctx.sessionController.prompt(request, signal)` calls `signal.throwIfAborted()` unconditionally,
 * so calling it without a signal throws "Cannot read properties of undefined (reading
 * throwIfAborted)" — the prompt call is the only place in this plugin that needs one.
 */
function promptSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('prompt admission timed out')), ms);
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function resolveStateDir(config) {
  if (config.stateDir) return path.resolve(String(config.stateDir));
  const env = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : '';
  const home = env || path.join(os.homedir(), '.dsh');
  return path.join(home, 'plugin-data', 'dsh-link-bridge');
}

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return file;
}

function clip(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? text.slice(0, max) + ' …(截断)' : text;
}

/**
 * Ordering guard for the watermark. Message ids are ULIDs in practice, but a synthetic or
 * foreign id (a self-check message, a hand-crafted API call) can sort ABOVE every real id —
 * an id-only watermark then looks "newer" than everything and silently blocks the queue
 * forever. Compare the (ts, id) tuple instead: timestamps are authoritative, ids break ties.
 */
function isNewerThan(message, watermark) {
  if (!watermark || !watermark.ts) return true;
  const ts = String(message.ts ?? '');
  if (ts > watermark.ts) return true;
  if (ts < watermark.ts) return false;
  return String(message.id ?? '') > String(watermark.id ?? '');
}

/**
 * Loop guard for two machines that both run this bridge: without it, an automated reply from
 * the other side wakes a session here, whose reply wakes a session there, and so on. The
 * guard allows a thread to be woken a bounded number of times inside a rolling window and
 * caps the global rate; the state keeps the counters so a restart cannot reset them.
 */
function wakeGate(runtime, threadId, now, limits) {
  const windowMs = limits.threadWindowSeconds * 1000;
  const entry = runtime.threads[threadId];
  if (entry && now - entry.windowStart > windowMs) delete runtime.threads[threadId];
  const current = runtime.threads[threadId];
  if (current) {
    const left = Math.ceil((limits.threadCooldownSeconds * 1000 - (now - current.lastAt)) / 1000);
    if (left > 0) return { ok: false, soft: true, reason: 'thread cooldown, ' + left + 's left' };
    if (current.wakes >= limits.maxThreadWakes) {
      return { ok: false, soft: false, reason: 'thread budget: ' + current.wakes + ' wakes within ' + Math.round((now - current.windowStart) / 60000) + 'min (loop guard)' };
    }
  }
  runtime.wakeTimes = runtime.wakeTimes.filter((at) => now - at < 3600_000);
  if (runtime.wakeTimes.length >= limits.maxWakesPerHour) {
    return { ok: false, soft: false, reason: 'global rate cap: ' + runtime.wakeTimes.length + ' wakes/hour (loop guard)' };
  }
  return { ok: true };
}

function recordWake(runtime, threadId, now) {
  const entry = runtime.threads[threadId] ?? { wakes: 0, windowStart: now, lastAt: 0 };
  entry.wakes += 1;
  entry.lastAt = now;
  runtime.threads[threadId] = entry;
  runtime.wakeTimes = [...runtime.wakeTimes.filter((at) => now - at < 3600_000), now];
}

function renderMessages(messages, maxBodyChars) {
  return messages.map((message) => {
    const from = message.from && message.from.name ? message.from.name : '未知节点';
    const head = '- [' + message.id + '] 来自 ' + from + '，主题：' + (message.subject || '(无)') + '，时间 ' + message.ts;
    const body = clip(message.body, maxBodyChars).split('\n').map((line) => '    ' + line).join('\n');
    const files = Array.isArray(message.attachments) && message.attachments.length
      ? '\n    附件：' + message.attachments.map((item) => item.name || item.id || 'file').join(', ')
      : '';
    return head + '\n' + body + files;
  }).join('\n\n');
}

function renderPrompt(template, values) {
  return String(template).replace(/{{(\w+)}}/g, (match, key) => (key in values ? String(values[key]) : match));
}

async function fetchJson(url, { token, ms }) {
  const guard = timeoutSignal(ms);
  try {
    const res = await fetch(url, {
      headers: token ? { authorization: 'Bearer ' + token } : undefined,
      signal: guard.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url);
    return await res.json();
  } finally {
    guard.done();
  }
}

/**
 * Install the bridge: poll the dsh-link node and prompt a Session when messages arrive.
 * @param ctx - Cordis context owning the resulting interval and Session calls.
 * @param rawConfig - user configuration merged over DEFAULTS.
 */
export function apply(ctx, rawConfig) {
  // A collaboration add-on must never be able to prevent DSH from booting: any setup
  // failure is reported and the bridge stays idle instead of propagating.
  try {
    install(ctx, rawConfig);
  } catch (error) {
    const message = errorText(error);
    try { console.error('[dsh-link-bridge] disabled after a setup error: ' + message); } catch { /* ignore */ }
  }
}

function install(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig || {}) };
  const log = makeLogger(ctx);

  if (!config.enabled) {
    log.info('disabled by config (enabled: false)');
    return;
  }
  if (!config.workspacePath) {
    log.warn('workspacePath is not configured — the bridge stays idle.');
    log.warn('Set it in your profile cordis.patch.yml:');
    log.warn('  - insert:');
    log.warn('      - id: dsh-link-bridge');
    log.warn('        name: dsh-link-bridge');
    log.warn('        config:');
    log.warn('          workspacePath: "D:\\\\work\\\\remote-inbox"');
    return;
  }

  const baseUrl = String(config.nodeUrl || DEFAULTS.nodeUrl).replace(/\/+$/, '');
  const token = String(config.token || '');
  const workspacePath = path.resolve(String(config.workspacePath));
  const pollMs = Math.max(2, Number(config.pollSeconds) || DEFAULTS.pollSeconds) * 1000;
  const cooldownMs = Math.max(0, Number(config.cooldownSeconds) || 0) * 1000;
  const limits = {
    threadCooldownSeconds: Math.max(0, Number(config.threadCooldownSeconds) || 0),
    maxThreadWakes: Math.max(1, Number(config.maxThreadWakes) || DEFAULTS.maxThreadWakes),
    threadWindowSeconds: Math.max(60, Number(config.threadWindowSeconds) || DEFAULTS.threadWindowSeconds),
    maxWakesPerHour: Math.max(1, Number(config.maxWakesPerHour) || DEFAULTS.maxWakesPerHour)
  };
  const batchLimit = Math.max(1, Math.min(200, Number(config.batchLimit) || DEFAULTS.batchLimit));
  const maxBodyChars = Math.max(200, Number(config.maxBodyChars) || DEFAULTS.maxBodyChars);
  const promptTemplate = String(config.prompt || '') || DEFAULT_PROMPT;
  const topicPolicy = normalizeTopicPolicy(config.topics ?? {});
  const commandMs = Math.max(0, Number(config.commandSeconds ?? DEFAULTS.commandSeconds) || 0) * 1000;
  const commandBatch = Math.max(1, Math.min(25, Number(config.commandBatch ?? DEFAULTS.commandBatch) || DEFAULTS.commandBatch));
  const stateFile = path.join(resolveStateDir(config), 'state.json');

  const runtime = {
    node: null,
    sessionId: config.sessionId ? String(config.sessionId) : '',
    watermark: { ts: '', id: '' },
    lastNotifyAt: 0,
    loaded: false,
    busy: false,
    ticks: 0,
    notified: 0,
    errors: 0,
    lastTickAt: 0,
    lastError: null,
    lastErrorStack: null,
    phase: null,
    threads: {},
    wakeTimes: [],
    suppressed: 0,
    lastSuppressed: null,
    pool: {},
    topic: null,
    archived: [],
    sessionsCreated: 0,
    sessionsArchived: 0,
    lastArchive: null,
    deadSessions: new Set(),
    commands: null
  };

  async function loadStateOnce() {
    if (runtime.loaded) return;
    runtime.loaded = true;
    const saved = await readState(stateFile);
    if (!runtime.sessionId && typeof saved.sessionId === 'string') runtime.sessionId = saved.sessionId;
    if (typeof saved.watermarkTs === 'string' && saved.watermarkTs) runtime.watermark = { ts: saved.watermarkTs, id: typeof saved.watermarkId === 'string' ? saved.watermarkId : '' };
    if (typeof saved.lastNotifyAt === 'number') runtime.lastNotifyAt = saved.lastNotifyAt;
    if (saved.threads && typeof saved.threads === 'object') runtime.threads = saved.threads;
    if (Array.isArray(saved.wakeTimes)) runtime.wakeTimes = saved.wakeTimes.filter((at) => typeof at === 'number');
    if (typeof saved.suppressed === 'number') runtime.suppressed = saved.suppressed;
    if (saved.pool && typeof saved.pool === 'object') runtime.pool = saved.pool;
    if (Array.isArray(saved.archived)) runtime.archived = saved.archived.slice(-50);
    if (typeof saved.sessionsCreated === 'number') runtime.sessionsCreated = saved.sessionsCreated;
    if (typeof saved.sessionsArchived === 'number') runtime.sessionsArchived = saved.sessionsArchived;
    log.info('state file: ' + stateFile + (runtime.watermark.ts ? ' (watermark ' + runtime.watermark.ts + ' / ' + runtime.watermark.id + ')' : ' (fresh)'));
  }

  async function openSession(label) {
    await fs.mkdir(workspacePath, { recursive: true });
    let workspaceId;
    try {
      const workspace = await ctx.workspaceRegistry.create(workspacePath);
      workspaceId = workspace && workspace.id ? workspace.id : undefined;
    } catch (error) {
      log.warn('workspaceRegistry.create failed, falling back to a bare cwd: ' + errorText(error));
    }
    const request = workspaceId ? { workspaceId } : { cwd: workspacePath };
    if (config.agentPreset) request.agentPreset = String(config.agentPreset);
    const created = await ctx.sessionController.create(request);
    if (!created || !created.sessionId) throw new Error('sessionController.create returned no sessionId');
    const sessionId = created.sessionId;
    runtime.sessionsCreated += 1;
    const title = titleFor(label);
    try {
      if (typeof ctx.sessionController.rename === 'function') {
        await ctx.sessionController.rename({ sessionId, title });
      }
    } catch (error) {
      log.debug('could not title ' + sessionId + ': ' + errorText(error));
    }
    log.info('created session ' + sessionId + ' for topic "' + (label || '(no topic)') + '" in ' + workspacePath);
    return sessionId;
  }

  function titleFor(label) {
    const prefix = String(config.sessionTitlePrefix ?? '');
    const text = String(label || 'remote messages').replace(/\s+/g, ' ').trim().slice(0, 80);
    return (prefix + text).slice(0, 120);
  }

  /** Archive one retired session with the DSH-native archive set; never throws. */
  async function archiveSession(sessionId, reason) {
    const id = String(sessionId || '');
    if (!id) return false;
    const record = { sessionId: id, reason, at: new Date().toISOString() };
    if (config.archiveSessions === false) {
      record.ok = false;
      record.error = 'archiving disabled (archiveSessions: false)';
      log.debug('leaving session ' + id + ' open (' + reason + ')');
    } else {
      try {
        if (!ctx.workspaceRegistry || typeof ctx.workspaceRegistry.archiveSession !== 'function') {
          throw new Error('workspaceRegistry.archiveSession is unavailable');
        }
        await ctx.workspaceRegistry.archiveSession(id);
        record.ok = true;
        runtime.sessionsArchived += 1;
        log.info('archived session ' + id + ' (' + reason + ')');
      } catch (error) {
        record.ok = false;
        record.error = errorText(error);
        log.warn('could not archive session ' + id + ': ' + record.error);
      }
    }
    runtime.archived = [...(runtime.archived ?? []).slice(-49), record];
    runtime.lastArchive = record;
    return record.ok === true;
  }

  /**
   * Pick the session for one topic: reuse it while it is fresh, otherwise open a new one and
   * archive the retired session so the sidebar does not fill up with stale bridge conversations.
   */
  async function ensureSessionFor(key, label) {
    if (config.sessionId) return String(config.sessionId); // pinned mode: one session, as in 0.2.x
    const now = Date.now();
    const plan = planSession({
      pool: runtime.pool,
      key,
      label,
      now,
      policy: topicPolicy,
      // Session existence has to be a synchronous answer; the async truth arrives when a prompt
      // fails, which marks the id dead here so the next tick opens a fresh session.
      exists: (id) => !runtime.deadSessions.has(String(id))
    });
    if (plan.action === 'reuse') {
      runtime.topic = { key, reason: plan.reason, sessionId: plan.sessionId };
      return plan.sessionId;
    }
    for (const item of plan.archive) await archiveSession(item.sessionId, item.reason);
    const sessionId = await openSession(label);
    runtime.topic = { key, reason: plan.reason, sessionId };
    return sessionId;
  }

  /** Retire quiet topics and keep the pool bounded; at most 3 archiving calls per tick. */
  async function sweepSessions(now) {
    if (!Object.keys(runtime.pool).length) return;
    const swept = sweepPool({ pool: runtime.pool, now, policy: topicPolicy });
    if (!swept.archive.length && !swept.drop.length) return;
    let archived = 0;
    for (const item of swept.archive) {
      if (archived >= 3) break;
      if (await archiveSession(item.sessionId, item.reason)) archived += 1;
    }
    log.debug('topic pool: ' + Object.keys(runtime.pool).length + ' topic(s), archived ' + archived + ', forgot ' + swept.drop.length);
  }

  async function tick() {
    if (runtime.busy) return;
    runtime.busy = true;
    try {
      await loadStateOnce();
      runtime.ticks += 1;
      runtime.lastTickAt = Date.now();
      runtime.phase = 'info';
      const info = await fetchJson(baseUrl + '/api/v1/info', { token, ms: 10000 });
      runtime.node = (info && info.name) || runtime.node || 'unknown';
      runtime.phase = 'list';
      const listed = await fetchJson(baseUrl + '/api/v1/messages?box=inbox&unread=1&limit=' + batchLimit + '&order=asc', { token, ms: 10000 });
      const messages = (listed && Array.isArray(listed.messages) ? listed.messages : [])
        .filter((message) => message && typeof message.id === 'string' && message.read !== true && isNewerThan(message, runtime.watermark));
      const now = Date.now();
      // Retire quiet topics even when nothing arrives: that is what keeps old bridge conversations
      // out of the sidebar instead of letting them accumulate forever.
      await sweepSessions(now);
      if (!messages.length) return;
      if (cooldownMs && runtime.lastNotifyAt && now - runtime.lastNotifyAt < cooldownMs) {
        log.debug('holding ' + messages.length + ' message(s) for the cooldown window');
        return;
      }
      const newest = messages[messages.length - 1];
      const topicKey = topicKeyFor(newest, topicPolicy);
      const label = topicLabel(newest);
      const threadId = topicKey;
      const gate = wakeGate(runtime, threadId, now, limits);
      if (!gate.ok) {
        runtime.suppressed += 1;
        runtime.lastSuppressed = {
          at: new Date(now).toISOString(), thread: threadId, id: newest.id,
          reason: gate.reason, dropped: !gate.soft
        };
        if (gate.soft) {
          log.debug('holding back a wake for ' + threadId + ': ' + gate.reason);
          return;
        }
        log.warn('loop guard: dropped a wake for ' + threadId + ' — ' + gate.reason);
        runtime.watermark = { ts: String(newest.ts ?? ''), id: newest.id };
        return;
      }
      runtime.phase = 'session';
      const sessionId = await ensureSessionFor(topicKey, label);
      runtime.sessionId = sessionId;
      // Count the wake before prompting: a failed prompt then retries against the same session
      // instead of opening a fresh one on every tick.
      recordUse(runtime.pool, topicKey, { sessionId, label, now, messages: messages.length });
      const peers = [...new Set(messages.map((message) => (message.from && message.from.name) || '未知节点'))];
      const text = renderPrompt(promptTemplate, {
        node: runtime.node,
        count: messages.length,
        peers: peers.join(', '),
        lastId: newest.id,
        messages: renderMessages(messages, maxBodyChars)
      });
      runtime.phase = 'prompt';
      const requestId = 'link-bridge:' + sessionId + ':' + newest.id;
      const guard = promptSignal(60_000);
      try {
        await ctx.sessionController.prompt({ sessionId, content: [{ type: 'text', text }], requestId }, guard.signal);
      } catch (error) {
        // A session that disappeared between selection and prompt must not be reused forever.
        if (/not found|unknown session|no such session/i.test(errorText(error))) runtime.deadSessions.add(sessionId);
        throw error;
      } finally {
        guard.done();
      }
      recordWake(runtime, threadId, now);
      runtime.watermark = { ts: String(newest.ts ?? ''), id: newest.id };
      runtime.lastNotifyAt = now;
      runtime.notified += messages.length;
      log.info('woke session ' + sessionId + ' with ' + messages.length + ' message(s) from ' + peers.join(', ') + ' (through ' + newest.id + ')');
      // No extra state write here: the heartbeat in the finally block below is a superset
      // (same watermark/sessionId plus ticks/notified/errors). Writing twice per tick used to
      // expose a partial state.json for a moment — an operator (or a test) reading the file
      // right then would see the watermark but no errors/notified fields.
    } catch (error) {
      runtime.errors += 1;
      runtime.lastError = errorText(error);
      // Keep the first stack frames in the heartbeat file: the bridge runs inside DSH, where
      // nobody is watching the console, and a bare message is usually not enough to diagnose.
      runtime.lastErrorStack = typeof error?.stack === 'string'
        ? error.stack.split('\n').slice(0, 8).join('\n')
        : null;
      if (runtime.errors <= 3) log.warn('poll failed during ' + runtime.phase + ' (' + runtime.errors + '): ' + runtime.lastError);
      else log.debug('poll failed during ' + runtime.phase + ' (' + runtime.errors + '): ' + runtime.lastError);
    } finally {
      runtime.busy = false;
      // Heartbeat: one small write per tick, so `state.json` mtime answers
      // "is the bridge alive?" without reading any console.
      await writeState(stateFile, {
        sessionId: runtime.sessionId || '',
        watermark: runtime.watermark.id,
        watermarkTs: runtime.watermark.ts,
        watermarkId: runtime.watermark.id,
        lastNotifyAt: runtime.lastNotifyAt,
        lastTickAt: runtime.lastTickAt,
        ticks: runtime.ticks,
        notified: runtime.notified,
        errors: runtime.errors,
        lastError: runtime.lastError || null,
        lastErrorStack: runtime.lastErrorStack || null,
        phase: runtime.phase || null,
        threads: runtime.threads,
        wakeTimes: runtime.wakeTimes,
        suppressed: runtime.suppressed,
        lastSuppressed: runtime.lastSuppressed,
        node: runtime.node,
        workspacePath,
        pool: poolSummary(runtime.pool),
        topic: runtime.topic,
        archived: runtime.archived.slice(-10),
        sessionsCreated: runtime.sessionsCreated,
        sessionsArchived: runtime.sessionsArchived,
        lastArchive: runtime.lastArchive,
        commands: runtime.commands,
        updatedAt: new Date().toISOString()
      }).catch(() => {});
    }
  }

  log.info('watching ' + baseUrl + ' every ' + (pollMs / 1000) + 's; workspace ' + workspacePath + (config.sessionId ? '; session ' + config.sessionId + ' (pinned)' : '; one session per topic'));
  log.info('loop guard: thread cooldown ' + limits.threadCooldownSeconds + 's, ' + limits.maxThreadWakes + ' wakes/thread per ' + Math.round(limits.threadWindowSeconds / 60) + 'min, ' + limits.maxWakesPerHour + ' wakes/hour overall');
  log.info('topic policy: strategy ' + topicPolicy.strategy + ', ' + topicPolicy.maxSessionWakes + ' wakes/session, session age ' + Math.round(topicPolicy.maxSessionAgeSeconds / 3600) + 'h, idle reset ' + Math.round(topicPolicy.topicIdleResetSeconds / 3600) + 'h, archive after ' + Math.round(topicPolicy.archiveIdleSeconds / 3600) + 'h idle, pool ' + topicPolicy.maxPoolSize + (config.archiveSessions === false ? ' (archiving off)' : ''));
  log.info('state file: ' + stateFile);
  const mode = schedulePolling(ctx, () => { void tick(); }, pollMs);
  log.debug('poll scheduled via ' + mode);

  // --- capability channel: run what a peer asked this machine's DSH to do -------------
  if (commandMs > 0) {
    try {
      const dshOps = createDshOps({
        ctx,
        log,
        status: () => ({
          node: runtime.node,
          version: BRIDGE_VERSION,
          workspacePath,
          ticks: runtime.ticks,
          notified: runtime.notified,
          errors: runtime.errors,
          sessions: Object.keys(runtime.pool).length,
          archived: runtime.sessionsArchived,
          lastArchive: runtime.lastArchive
        })
      });
      const worker = createCommandWorker({
        nodeUrl: baseUrl,
        token,
        log,
        handlers: dshOps.methods,
        describe: () => dshOps.describe(),
        version: BRIDGE_VERSION,
        maxPerTick: commandBatch,
        sessions: () => Object.keys(runtime.pool).length
      });
      runtime.commands = worker.stats;
      schedulePolling(ctx, () => { void worker.tick(); }, commandMs);
      log.info('capability channel: ' + dshOps.describe().join(', ') + ' served from ' + baseUrl + ' every ' + (commandMs / 1000) + 's');
    } catch (error) {
      log.warn('capability channel disabled after a setup error: ' + errorText(error));
    }
  } else {
    log.info('capability channel: disabled (commandSeconds: 0)');
  }
  void tick();
}
