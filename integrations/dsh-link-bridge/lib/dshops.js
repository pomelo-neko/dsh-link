// dsh-link-bridge Host operations: run the remote caller's requests against this DSH's
// public Host services (Workspaces, Sessions, the title service) and return normalized JSON.
//
// Design rules that the rest of the bridge depends on:
//   - The method map is built without touching ctx: with new cordis, reading an undeclared
//     service throws, so every service is resolved lazily inside the method that needs it.
//   - A missing or undeclared service produces a readable Error ("workspaceRegistry is
//     unavailable") which the command worker turns into `ok: false` for the remote caller.
//     Nothing is thrown out of createDshOps itself.
//   - Sessions list/read only need sessionController; workspace membership and the archive
//     set are best-effort extras there, so a composition without a workspace registry can
//     still list and read sessions.
//   - Every result stays inside limits.maxResultChars; oversized payloads are cut down and
//     marked `truncated`.
//
// Zero runtime dependencies: node:crypto for a request id, node built-ins only.
import { randomUUID } from 'node:crypto';

/** Result-shaping defaults; every field is overridable through the factory options. */
const DEFAULT_LIMITS = {
  /** Per-message text budget in sessions.read. */
  maxChars: 8000,
  /** Whole-result JSON budget; oversized payloads are trimmed and flagged. */
  maxResultChars: 200000,
  /** Hard cap on requested rows and on the prompt path's list reads. */
  maxMessages: 1000,
  /** Timeout for Host reads that take a caller AbortSignal (list/inspect). */
  listTimeoutMs: 15000,
  /** Timeout for prompt admission; the Host also aborts an unanswered prompt. */
  promptTimeoutMs: 60000
};

/**
 * Bound a value with a positive default.
 * @param value - caller-supplied limit.
 * @param fallback - default used when the value is absent or not a positive number.
 * @returns the bound value.
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Convert an epoch-millisecond stamp into an ISO string.
 * @param value - Host timestamp (milliseconds since the epoch).
 * @returns the ISO spelling, or '' when the value is not a usable timestamp.
 */
function timeOf(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

/**
 * Cut one text to a character budget.
 * @param value - source text (anything else is stringified).
 * @param max - maximum number of characters.
 * @returns the possibly shortened text plus whether it was shortened.
 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

/** Display name of an attachment block, tolerating either durable reference spelling. */
function attachmentName(block) {
  const attachment = block.attachment && typeof block.attachment === 'object' ? block.attachment : {};
  return String(attachment.name ?? attachment.fileName ?? attachment.attachmentId ?? 'file');
}

/**
 * Render one content block as compact text. Reasoning is deliberately dropped (it is not part
 * of the visible transcript) and non-text blocks become bracketed markers, so a remote reader
 * can tell "the assistant answered with nothing visible" from "the assistant called a tool".
 * @param block - ContentBlock from a Session event.
 * @returns rendered text for the block ('' when it contributes nothing).
 */
function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text': return typeof block.text === 'string' ? block.text : '';
    case 'reasoning': return '';
    case 'image': return '[image]';
    case 'file': return '[file: ' + attachmentName(block) + ']';
    case 'tool-call': return '[tool-call: ' + String(block.name ?? 'unknown') + ']';
    case 'tool-result': return Array.isArray(block.content) ? contentText(block.content) : '';
    default: return typeof block.text === 'string' ? block.text : '';
  }
}

/**
 * Render one content array as text.
 * @param content - ContentBlock[].
 * @returns the blocks joined by newlines.
 */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(blockText).filter((part) => part.length > 0).join('\n');
}

/**
 * Project one Session event onto a transcript row.
 * @param event - durable Session event.
 * @returns { role, kind, content } for message-bearing events, else null.
 */
function messageOf(event) {
  if (!event || typeof event !== 'object') return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  switch (event.type) {
    case 'user/message':
      return { role: 'user', kind: event.type, content: data.content };
    case 'assistant/message':
      return { role: 'assistant', kind: event.type, content: data.message ? data.message.content : undefined };
    case 'system/message':
      return { role: 'system', kind: event.type, content: data.message ? data.message.content : undefined };
    case 'tool/result':
      return { role: 'tool', kind: event.type, content: data.message ? data.message.content : undefined };
    default:
      return null;
  }
}

/**
 * Fold the latest durable title out of a Session log (the title service records session/title
 * events, so its projection needs no port here).
 * @param events - Session events in log order.
 * @returns the latest title, or '' when the session was never titled.
 */
function foldTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      return event.data.title;
    }
  }
  return '';
}

/**
 * Build the Host command handlers for the bridge plugin.
 * @param options - Host wiring.
 * @param options.ctx - DSH Host context; every service is read lazily and defensively.
 * @param options.log - optional { info, warn, error, debug } logger.
 * @param options.limits - result-shaping overrides (see DEFAULT_LIMITS).
 * @param options.status - () => JSON for bridge.status; without one a base status is returned.
 * @returns { methods, describe } - the handler map and its capability list.
 */
export function createDshOps({ ctx, log, limits = {}, status } = {}) {
  const configured = limits && typeof limits === 'object' ? limits : {};
  const maxChars = positive(configured.maxChars, DEFAULT_LIMITS.maxChars);
  const maxResultChars = positive(configured.maxResultChars, DEFAULT_LIMITS.maxResultChars);
  const maxMessages = positive(configured.maxMessages, DEFAULT_LIMITS.maxMessages);
  const listMs = positive(configured.listTimeoutMs, DEFAULT_LIMITS.listTimeoutMs);
  const promptMs = positive(configured.promptTimeoutMs, DEFAULT_LIMITS.promptTimeoutMs);
  const logger = log && typeof log === 'object' ? log : {};

  /** One log line, contained: a broken logger must never break a command. */
  function emit(level, message) {
    const fn = logger[level];
    if (typeof fn !== 'function') return;
    try { fn.call(logger, message); } catch { /* ignore */ }
  }

  /**
   * Read one Host service without ever letting the read escape. New cordis throws when a
   * plugin touches a service it did not declare, and this bridge is deliberately tolerant of
   * a partial composition, so a throwing getter reads as "unavailable".
   * @param name - service name on ctx.
   * @returns the service, or undefined when it is absent or unreadable.
   */
  function service(name) {
    try {
      const value = ctx === undefined || ctx === null ? undefined : ctx[name];
      return value === undefined || value === null ? undefined : value;
    } catch {
      return undefined;
    }
  }

  /**
   * Read one Host service or fail with the caller-facing message.
   * @param name - service name on ctx.
   * @returns the service.
   * @throws Error "<name> is unavailable" - the worker reports this to the remote caller.
   */
  function requireService(name) {
    const value = service(name);
    if (value === undefined) throw new Error(name + ' is unavailable');
    return value;
  }

  /**
   * Read one required string argument.
   * @param value - caller-supplied value.
   * @param name - argument name used in the error.
   * @returns the trimmed value.
   * @throws Error "<name> is required".
   */
  function requireArg(value, name) {
    const text = value === undefined || value === null
      ? ''
      : typeof value === 'string' ? value.trim() : String(value).trim();
    if (!text) throw new Error(name + ' is required');
    return text;
  }

  /** Optional string argument: '' when absent, so `if (value)` is the whole presence test. */
  function optionalString(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  /** Clamp a requested row count into [1, maxMessages]. */
  function rowLimit(value, fallback = 100) {
    return Math.max(1, Math.min(maxMessages, Number(value) || fallback));
  }

  /**
   * Run a Host call that requires a caller AbortSignal (the Host calls
   * `signal.throwIfAborted()`, so omitting one throws a TypeError). The timer is unref'd and
   * cleared as soon as the call settles.
   * @param ms - timeout budget.
   * @param run - (signal) => Promise.
   * @returns the Host call result.
   */
  function withSignal(ms, run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('dsh-link-bridge: the Host call timed out')), ms);
    if (typeof timer.unref === 'function') timer.unref();
    return Promise.resolve()
      .then(() => run(controller.signal))
      .finally(() => clearTimeout(timer));
  }

  /** The registry's archive set, read defensively; an unavailable registry means "none". */
  function archivedSet(registry) {
    try {
      const ids = registry && registry.archivedSessionIds;
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch {
      return new Set();
    }
  }

  /** The archived set of whatever registry is mounted, or an empty set. */
  function currentArchived() {
    return archivedSet(service('workspaceRegistry'));
  }

  /** Workspace entities, or [] when no registry is mounted. */
  function currentWorkspaces() {
    const registry = service('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return [];
    try {
      const entities = registry.list();
      return Array.isArray(entities) ? entities : [];
    } catch (error) {
      emit('debug', 'workspace list is unavailable: ' + String(error && error.message ? error.message : error));
      return [];
    }
  }

  /** sessionId -> workspace entity, from the registry's ownership accounts. */
  function ownerIndex(entities) {
    const owners = new Map();
    for (const entity of entities) {
      if (!Array.isArray(entity.sessionIds)) continue;
      for (const sessionId of entity.sessionIds) {
        const key = String(sessionId);
        if (!owners.has(key)) owners.set(key, entity);
      }
    }
    return owners;
  }

  /** The owning workspace id for one session, or '' when it is unattached. */
  function ownerOfSession(sessionId) {
    const owner = ownerIndex(currentWorkspaces()).get(sessionId);
    return owner ? String(owner.id ?? '') : '';
  }

  /**
   * Match a workspace selector against id, title, or path (case-insensitive for title/path:
   * Windows paths and display titles are not case-sensitive identities).
   * @param entity - workspace entity.
   * @param wanted - caller selector.
   * @returns whether the workspace matches.
   */
  function matchesWorkspace(entity, wanted) {
    const needle = wanted.toLowerCase();
    return String(entity.id ?? '') === wanted
      || String(entity.title ?? '').toLowerCase() === needle
      || String(entity.path ?? '').toLowerCase() === needle;
  }

  /** The title projected for one Session list row (the title service owns the projection). */
  function titleOf(item) {
    const values = item && item.projections && item.projections.values ? item.projections.values : null;
    const title = values ? values.title : undefined;
    return typeof title === 'string' ? title : '';
  }

  /**
   * Keep one result inside limits.maxResultChars. The primary list is halved until the
   * envelope fits; when even an empty envelope does not fit, a minimal report is returned.
   * @param value - result about to be posted.
   * @param listKey - property holding the primary array, or null when there is none.
   * @returns the value, or a truncated stand-in that always carries `truncated: true`.
   */
  function cap(value, listKey) {
    let size = 0;
    try {
      size = JSON.stringify(value).length;
    } catch {
      return { truncated: true, note: 'result is not JSON-serializable' };
    }
    if (size <= maxResultChars) return value;
    const note = 'result exceeded limits.maxResultChars (' + maxResultChars + ')';
    const list = listKey && Array.isArray(value[listKey]) ? value[listKey] : [];
    let kept = list.length;
    while (kept > 0) {
      kept = Math.floor(kept / 2);
      const candidate = { ...value, [listKey]: list.slice(0, kept), truncated: true, note, dropped: list.length - kept };
      try {
        if (JSON.stringify(candidate).length <= maxResultChars) return candidate;
      } catch {
        return { truncated: true, note };
      }
    }
    return { truncated: true, note, dropped: list.length };
  }

  const methods = {
    /**
     * Every registered workspace with its session account and archived subset.
     * `archived` means "this workspace holds at least one archived session" — the archive set
     * is registry-global, so a workspace itself is never archived.
     */
    'workspaces.list': async () => {
      const registry = requireService('workspaceRegistry');
      if (typeof registry.list !== 'function') throw new Error('workspaceRegistry.list is unavailable');
      const archived = archivedSet(registry);
      const workspaces = currentWorkspaces().map((entity) => {
        const sessionIds = Array.isArray(entity.sessionIds) ? entity.sessionIds.map(String) : [];
        const archivedSessionIds = sessionIds.filter((sessionId) => archived.has(sessionId));
        return {
          id: String(entity.id ?? ''),
          title: String(entity.title ?? ''),
          path: String(entity.path ?? ''),
          sessionIds,
          archived: archivedSessionIds.length > 0,
          ...(archivedSessionIds.length ? { archivedSessionIds } : {})
        };
      });
      return cap({ workspaces, count: workspaces.length }, 'workspaces');
    },

    /**
     * Session rows for one workspace (or every workspace), newest first. Archived sessions are
     * hidden unless the caller asks for them.
     */
    'sessions.list': async ({ workspace, includeArchived = false, limit = 100 } = {}) => {
      const controller = requireService('sessionController');
      if (typeof controller.list !== 'function') throw new Error('sessionController.list is unavailable');
      const entities = currentWorkspaces();
      const owners = ownerIndex(entities);
      const archived = currentArchived();
      const wanted = optionalString(workspace);
      let selected = null;
      if (wanted) {
        const matched = entities.filter((entity) => matchesWorkspace(entity, wanted));
        if (!matched.length) throw new Error('no workspace matches "' + wanted + '"');
        selected = new Set(matched.map((entity) => String(entity.id ?? '')));
      }
      const listing = await withSignal(listMs, (signal) => controller.list({}, signal));
      const items = listing && Array.isArray(listing.items) ? listing.items : [];
      const rows = [];
      for (const item of items) {
        const sessionId = item && item.sessionId !== undefined && item.sessionId !== null ? String(item.sessionId) : '';
        if (!sessionId) continue;
        const owner = owners.get(sessionId);
        if (selected && (!owner || !selected.has(String(owner.id ?? '')))) continue;
        const isArchived = archived.has(sessionId);
        if (isArchived && includeArchived !== true) continue;
        rows.push({
          sessionId,
          title: titleOf(item),
          workspaceId: owner ? String(owner.id ?? '') : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : owner ? String(owner.path ?? '') : '',
          updatedAt: timeOf(item.updatedAt),
          archived: isArchived
        });
      }
      rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const sessions = rows.slice(0, rowLimit(limit));
      return cap({ sessions, count: sessions.length, total: rows.length }, 'sessions');
    },

    /**
     * One session's header plus its transcript rows. `tail` reads the newest messages instead
     * of the oldest, which is what a remote "what happened last?" question wants.
     */
    'sessions.read': async ({ sessionId, limit = 100, tail = false } = {}) => {
      const id = requireArg(sessionId, 'sessionId');
      const controller = requireService('sessionController');
      if (typeof controller.inspect !== 'function') throw new Error('sessionController.inspect is unavailable');
      const inspected = await withSignal(listMs, (signal) => controller.inspect(id, signal));
      const meta = inspected && inspected.meta ? inspected.meta : null;
      if (!meta) throw new Error('session "' + id + '" was not found');
      const events = Array.isArray(inspected.events) ? inspected.events : [];
      const messages = [];
      for (const event of events) {
        const found = messageOf(event);
        if (!found) continue;
        const clipped = clip(contentText(found.content), maxChars);
        messages.push({
          role: found.role,
          kind: found.kind,
          text: clipped.text,
          time: timeOf(event.time),
          truncated: clipped.truncated
        });
      }
      const size = rowLimit(limit);
      const selected = tail === true
        ? messages.slice(Math.max(0, messages.length - size))
        : messages.slice(0, size);
      const session = {
        sessionId: String(meta.id ?? id),
        title: foldTitle(events),
        cwd: typeof meta.cwd === 'string' ? meta.cwd : '',
        createdAt: timeOf(meta.createdAt),
        agentPreset: typeof meta.agentPreset === 'string' ? meta.agentPreset : '',
        parentSession: meta.parentSession === undefined || meta.parentSession === null ? '' : String(meta.parentSession),
        origin: meta.origin === 'subagent' ? 'subagent' : 'session',
        workspaceId: ownerOfSession(id),
        archived: currentArchived().has(id),
        messages: messages.length,
        hasMore: messages.length > selected.length
      };
      return cap({ session, messages: selected }, 'messages');
    },

    /**
     * Create (or idempotently adopt) one Session. The Host rejects workspaceId and cwd passed
     * together, so workspaceId wins when both are given. With neither, the Host's default cwd
     * applies. A title is applied through the Host rename path after creation.
     */
    'sessions.create': async ({ workspaceId, cwd, agentPreset, title } = {}) => {
      const controller = requireService('sessionController');
      if (typeof controller.create !== 'function') throw new Error('sessionController.create is unavailable');
      const request = {};
      const wantedWorkspace = optionalString(workspaceId);
      const wantedCwd = optionalString(cwd);
      if (wantedWorkspace) request.workspaceId = wantedWorkspace;
      else if (wantedCwd) request.cwd = wantedCwd;
      const preset = optionalString(agentPreset);
      if (preset) request.agentPreset = preset;
      const created = await controller.create(request);
      const sessionId = created && created.sessionId !== undefined && created.sessionId !== null
        ? String(created.sessionId)
        : '';
      if (!sessionId) throw new Error('sessionController.create returned no sessionId');
      const wantedTitle = optionalString(title);
      if (!wantedTitle || typeof controller.rename !== 'function') return { sessionId, title: '' };
      try {
        const renamed = await controller.rename({ sessionId, title: wantedTitle });
        return { sessionId, title: renamed && typeof renamed.title === 'string' ? renamed.title : wantedTitle };
      } catch (error) {
        // The Session exists either way: reporting a failure would make the remote caller retry
        // and create a second one, so the rename miss is reported as data instead.
        const message = String(error && error.message ? error.message : error);
        emit('warn', 'session ' + sessionId + ' was created but not titled: ' + message);
        return { sessionId, title: '', renameError: message };
      }
    },

    /**
     * Admit one text prompt into a Session. The Host requires a caller AbortSignal, and the
     * request id is derived from the command id when the caller supplied none, so a redelivered
     * command is deduplicated by the Host instead of prompting twice.
     */
    'sessions.prompt': async ({ sessionId, text, requestId } = {}, context) => {
      const id = requireArg(sessionId, 'sessionId');
      const body = typeof text === 'string' ? text : '';
      if (!body.trim()) throw new Error('text is required');
      const controller = requireService('sessionController');
      if (typeof controller.prompt !== 'function') throw new Error('sessionController.prompt is unavailable');
      const commandId = context && context.id !== undefined && context.id !== null ? String(context.id) : '';
      const request = {
        sessionId: id,
        requestId: optionalString(requestId) || (commandId ? 'bridge-command:' + commandId : 'bridge-command:' + randomUUID()),
        mode: 'queue',
        content: [{ type: 'text', text: body }]
      };
      await withSignal(promptMs, (signal) => controller.prompt(request, signal));
      return { accepted: true, sessionId: id };
    },

    /** Rename one Session; the Host returns the normalized title it committed. */
    'sessions.rename': async ({ sessionId, title } = {}) => {
      const id = requireArg(sessionId, 'sessionId');
      const wanted = requireArg(title, 'title');
      const controller = requireService('sessionController');
      if (typeof controller.rename !== 'function') throw new Error('sessionController.rename is unavailable');
      const renamed = await controller.rename({ sessionId: id, title: wanted });
      return { sessionId: id, title: renamed && typeof renamed.title === 'string' ? renamed.title : wanted };
    },

    /** Archive one Session: hide it from every grouping surface without deleting its log. */
    'sessions.archive': async ({ sessionId } = {}) => {
      const id = requireArg(sessionId, 'sessionId');
      const registry = requireService('workspaceRegistry');
      if (typeof registry.archiveSession !== 'function') throw new Error('workspaceRegistry.archiveSession is unavailable');
      await registry.archiveSession(id);
      return { archived: true };
    },

    /** Report bridge health: the caller's status() when one was supplied, else base fields. */
    'bridge.status': async () => {
      if (typeof status === 'function') {
        const value = await status();
        if (value !== undefined && value !== null) return cap(value, null);
      }
      return cap({
        ok: true,
        methods: describe(),
        limits: { maxChars, maxResultChars, maxMessages, listTimeoutMs: listMs, promptTimeoutMs: promptMs }
      }, null);
    }
  };

  /**
   * The capability list advertised to the node.
   * @returns a fresh array of method names.
   */
  function describe() {
    return Object.keys(methods);
  }

  return { methods, describe };
}
