// dsh-link: Model Context Protocol (streamable HTTP) surface.
// DSH wires this endpoint through @deepseek-ai/dsh-mcp-client, so every link tool
// becomes a native harness tool named mcp__<serverName>__<tool>.
import { DSHLINK_VERSION, clampText } from './util.mjs';

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
export const MCP_DEFAULT_PROTOCOL = '2025-06-18';
export const MCP_SERVER_NAME = 'dsh-link';
export const MCP_SERVER_VERSION = DSHLINK_VERSION;

export const MCP_INSTRUCTIONS = [
  'dsh-link connects this machine to other DeepSeek Harness (DSH) instances.',
  'Call link_status first to see this node, its shared file roots, and its peers.',
  'link_send_message delivers a message to a peer (queued locally and retried if the peer is offline).',
  'link_inbox reads messages other machines pushed here; link_sync pulls anything a peer queued for us.',
  'link_list_files / link_pull_file fetch files from a peer into the local inbox directory;',
  'link_push_file sends a local file into a peer (only if that peer allows uploads).',
  'Peer names come from link_peers; "self" means this machine.',
  'link_dsh_workspaces / link_dsh_sessions / link_dsh_transcript read the workspaces and conversations of this machine or a peer (0.3+ nodes with the DSH view enabled).',
  'link_call runs a DSH capability (sessions.list, sessions.read, sessions.create, sessions.prompt, sessions.rename, sessions.archive, ...) through the bridge plugin of the target machine; actions need explicit authorization there.'
].join(' ')

const TOOL_DEFS = [
  {
    name: 'link_status',
    description: 'Show this dsh-link node: identity, URL, shared file roots, mailbox counters, and configured peers.',
    inputSchema: { type: 'object', properties: { probe: { type: 'boolean', description: 'Also probe each peer for reachability (slower).' } }, additionalProperties: false }
  },
  {
    name: 'link_peers',
    description: 'List configured peer machines with their URLs and (optionally) live reachability info.',
    inputSchema: { type: 'object', properties: { probe: { type: 'boolean', description: 'Ping each peer for name/roots/latency.' } }, additionalProperties: false }
  },
  {
    name: 'link_send_message',
    description: 'Send a message to another DSH machine. Optionally attach small files by path (resolved through a local file root) or inline base64. The message is stored locally and retried until delivered or synced.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Recipient peer name (see link_peers).' },
        subject: { type: 'string', description: 'Short subject line.' },
        body: { type: 'string', description: 'Message body (markdown/text).' },
        thread: { type: 'string', description: 'Thread id; defaults to a new thread rooted at this message.' },
        replyTo: { type: 'string', description: 'Message id being answered.' },
        attachments: {
          type: 'array',
          description: 'Inline attachments (<= 512 KiB each).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string', description: 'Path relative to a local root.' },
              localRoot: { type: 'string', description: 'Local file root name for path.' },
              contentBase64: { type: 'string' }
            },
            required: ['name']
          }
        }
      },
      required: ['peer', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'link_inbox',
    description: 'Read messages received from other DSH machines, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number', description: 'Max messages (default 20).' },
        since: { type: 'string', description: 'Message id or ISO timestamp cursor.' },
        thread: { type: 'string' },
        peer: { type: 'string', description: 'Filter by sender or thread participant.' },
        markRead: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'link_read_message',
    description: 'Read one message in full (including attachment metadata) and mark it read.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
  },
  {
    name: 'link_reply',
    description: 'Reply to a received message, keeping it in the same thread.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Inbox message id to answer.' }, body: { type: 'string' } },
      required: ['id', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'link_sync',
    description: 'Pull messages a peer recorded for us while we were unreachable. Without a peer name, syncs every peer that has a token.',
    inputSchema: { type: 'object', properties: { peer: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false }
  },
  {
    name: 'link_flush',
    description: 'Retry delivery of locally queued (not yet delivered) outgoing messages.',
    inputSchema: { type: 'object', properties: { peer: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'link_list_files',
    description: 'List a directory on this node or on a peer, inside that node\'s configured file roots. Use peer "self" for this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Peer name, or "self" (default).' },
        root: { type: 'string', description: 'Root name; defaults to the first configured root.' },
        path: { type: 'string', description: 'Directory path relative to the root.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'link_stat_file',
    description: 'Stat one file or directory on this node or a peer (size, mtime, type).',
    inputSchema: { type: 'object', properties: { peer: { type: 'string' }, root: { type: 'string' }, path: { type: 'string' } }, required: ['path'], additionalProperties: false }
  },
  {
    name: 'link_pull_file',
    description: 'Download a file from a peer (or copy locally with peer "self"). Lands in this node\'s inbox directory unless localName/localRoot say otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Peer name, or "self".' },
        root: { type: 'string', description: 'Remote root name.' },
        path: { type: 'string', description: 'Remote file path relative to the root.' },
        localName: { type: 'string', description: 'Local file name to use in the inbox directory.' },
        localRoot: { type: 'string', description: 'Write into this local root instead of the inbox directory.' }
      },
      required: ['peer', 'path'],
      additionalProperties: false
    }
  },
  {
    name: 'link_push_file',
    description: 'Upload a local file (inside a configured local root) to a peer that allows uploads.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string' },
        root: { type: 'string', description: 'Target root on the peer.' },
        path: { type: 'string', description: 'Target path relative to that root.' },
        localRoot: { type: 'string', description: 'Local root holding the file.' },
        localPath: { type: 'string', description: 'Local path relative to localRoot.' }
      },
      required: ['peer', 'localRoot', 'localPath'],
      additionalProperties: false
    }
  },
  {
    name: 'link_dsh_workspaces',
    description: 'List every DSH workspace (project folder + title + session count) on this machine or on a peer. Requires the peer node to run dsh-link 0.3+ with "dsh" enabled.',
    inputSchema: { type: 'object', properties: { peer: { type: 'string', description: 'Peer name; omit or "self" for this machine.' } }, additionalProperties: false }
  },
  {
    name: 'link_dsh_sessions',
    description: 'List DSH conversations across all workspaces (title, cwd, last activity, archived flag) on this machine or a peer.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Peer name; omit or "self" for this machine.' },
        workspace: { type: 'string', description: 'Workspace id, title or path fragment.' },
        includeArchived: { type: 'boolean', description: 'Include archived conversations.' },
        query: { type: 'string', description: 'Substring filter on title/cwd.' },
        limit: { type: 'number', description: 'Max conversations (default 100).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'link_dsh_transcript',
    description: 'Read the messages of one DSH conversation (a peer\'s or your own) without opening it: user/assistant text, reasoning, tool calls and results.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Peer name; omit or "self" for this machine.' },
        sessionId: { type: 'string', description: 'Conversation id, e.g. session-<uuid>.' },
        limit: { type: 'number', description: 'Max messages (default 100).' },
        offset: { type: 'number', description: 'Skip this many messages.' },
        tail: { type: 'boolean', description: 'Return the newest messages instead of the oldest.' }
      },
      required: ['sessionId'],
      additionalProperties: false
    }
  },
  {
    name: 'link_call',
    description: 'Run a DSH capability on this machine or a peer through the local bridge plugin (list/read/create/prompt/rename/archive conversations). Actions need explicit authorization in that node\'s capabilities config.',
    inputSchema: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: 'Peer name; omit for this machine.' },
        method: { type: 'string', description: 'workspaces.list | sessions.list | sessions.read | sessions.create | sessions.prompt | sessions.rename | sessions.archive | bridge.status' },
        params: { type: 'object', description: 'Method parameters.' },
        waitSeconds: { type: 'number', description: 'How long to wait for the bridge (default 30, 0 = queue only).' }
      },
      required: ['method'],
      additionalProperties: false
    }
  },
  {
    name: 'link_help',
    description: 'Explain the dsh-link tool set and the recommended collaboration workflow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

export function mcpToolDefs() {
  return TOOL_DEFS;
}

const HELP_TEXT = [
  '# dsh-link',
  '',
  'dsh-link links DeepSeek Harness instances on different computers: messages, files, and queued delivery.',
  '',
  'Typical workflow:',
  '1. link_status -> learn this node name, roots, peers.',
  '2. link_peers {probe:true} -> confirm which peers are reachable.',
  '3. link_inbox -> read what other machines sent; link_read_message {id} for the full text.',
  '4. link_send_message {peer, subject, body} -> message another machine (queued if offline).',
  '5. link_pull_file {peer, root, path} -> fetch a file; link_push_file -> send one back.',
  '6. link_sync -> pull messages a peer queued while this machine was offline; link_flush -> retry our own queue.',
  '',
  'Conversations: link_dsh_workspaces -> link_dsh_sessions -> link_dsh_transcript (works on this machine and on peers).',
  'Drive a conversation remotely with link_call {peer, method:"sessions.prompt", params:{sessionId, text}} (the target must allow it).',
  '',
  'File access is confined to each node\'s configured roots; hidden/secret paths are denied by default.',
  'Peer names are configuration, not discovery: "self" always means this machine.'
].join('\n');

function textResult(summary, data) {
  const payload = data === undefined ? '' : `\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: 'text', text: clampText(`${summary}${payload}`, 60_000) }] };
}

function errorResult(err) {
  const code = err?.code ?? 'error';
  const message = err?.message ?? String(err);
  const text = `ERROR [${code}] ${message}${err?.details ? `\n${JSON.stringify(err.details, null, 2)}` : ''}`;
  return { content: [{ type: 'text', text }], isError: true };
}

async function callTool(name, args, ops) {
  switch (name) {
    case 'link_status': {
      const status = await ops.status({ probe: args?.probe === true });
      return textResult(`node ${status.node.name} at ${status.node.url}; inbox ${status.stats.inbox} (${status.stats.inboxUnread} unread), outbox pending ${status.stats.outboxPending}; ${status.peers.length} peer(s)`, status);
    }
    case 'link_peers': {
      const peers = await ops.peers({ probe: args?.probe === true });
      return textResult(`${peers.count} configured peer(s)`, peers);
    }
    case 'link_send_message': {
      const result = await ops.sendMessage({
        to: args?.peer ?? args?.to,
        subject: args?.subject,
        body: args?.body,
        thread: args?.thread,
        replyTo: args?.replyTo,
        attachments: args?.attachments ?? []
      });
      const state = result.delivery.state === 'delivered' ? `delivered via ${result.delivery.via}` : `queued (${result.delivery.error ?? 'peer offline'})`;
      return textResult(`message ${result.message.id} to ${result.message.to}: ${state}`, { message: result.message, delivery: result.delivery });
    }
    case 'link_inbox': {
      const result = await ops.inbox({
        unreadOnly: args?.unreadOnly === true,
        limit: args?.limit,
        since: args?.since,
        thread: args?.thread,
        peer: args?.peer,
        markRead: args?.markRead === true
      });
      const lines = result.messages.map((m) => `- ${m.id} from ${m.from?.name ?? '?'} ${m.read ? '(read)' : '(unread)'} ${m.subject ? `: ${m.subject}` : ''}`);
      return textResult(`${result.count}/${result.total} message(s), ${result.unread} unread\n${lines.join('\n')}`, result);
    }
    case 'link_read_message': {
      const message = await ops.readMessage({ id: args?.id });
      return textResult(`message ${message.id} from ${message.from?.name ?? '?'}`, message);
    }
    case 'link_reply': {
      const parent = await ops.readMessage({ id: args?.id });
      const result = await ops.sendMessage({
        to: parent.from?.name ?? parent.from,
        body: args?.body,
        subject: parent.subject ? `Re: ${parent.subject}` : undefined,
        thread: parent.thread ?? parent.id,
        replyTo: parent.id,
        kind: 'reply'
      });
      return textResult(`reply ${result.message.id} to ${result.message.to}`, { message: result.message, delivery: result.delivery });
    }
    case 'link_sync': {
      const result = await ops.sync({ peer: args?.peer, limit: args?.limit });
      return textResult(`imported ${result.imported} message(s)`, result);
    }
    case 'link_flush': {
      const result = await ops.flush({ to: args?.peer });
      return textResult(`attempted ${result.attempted}; delivered ${result.delivered}, pending ${result.pending}`, result);
    }
    case 'link_list_files': {
      const result = await ops.listFiles({ peer: args?.peer ?? 'self', root: args?.root, path: args?.path ?? '' });
      const lines = result.entries.map((e) => `- ${e.type === 'dir' ? '[dir]' : '     '} ${e.path} ${e.type === 'file' ? `(${e.size} B)` : ''}`);
      return textResult(`${result.count} entr(y|ies) in ${result.peer}:${result.root}:${result.path || ''}\n${lines.join('\n')}`, result);
    }
    case 'link_stat_file': {
      const result = await ops.statFile({ peer: args?.peer ?? 'self', root: args?.root, path: args?.path });
      return textResult(`${result.peer} ${result.type} ${result.path} ${result.size} B`, result);
    }
    case 'link_pull_file': {
      const result = await ops.pullFile({
        peer: args?.peer ?? 'self',
        root: args?.root,
        path: args?.path,
        out: args?.localName ? undefined : undefined,
        localRoot: args?.localRoot
      });
      return textResult(`pulled ${result.size} B to ${result.path}${result.verified === false ? ' — SHA-256 MISMATCH' : ''}`, result);
    }
    case 'link_push_file': {
      const result = await ops.pushFile({
        peer: args?.peer,
        root: args?.root,
        path: args?.path,
        localRoot: args?.localRoot,
        file: args?.localPath
      });
      return textResult(`pushed ${result.size} B to ${result.peer}:${result.target.path}`, result);
    }
    case 'link_dsh_workspaces': {
      const result = await ops.dshWorkspaces({ peer: args?.peer });
      const lines = (result.workspaces ?? []).map((w) => `- ${w.id} ${w.title ?? ''} ${w.path ?? ''} (${w.sessions ?? 0} session(s))`);
      return textResult(`${result.workspaces?.length ?? 0} workspace(s) on ${result.peer}\n${lines.join('\n')}`, result);
    }
    case 'link_dsh_sessions': {
      const result = await ops.dshSessions({
        peer: args?.peer,
        workspace: args?.workspace,
        includeArchived: args?.includeArchived === true,
        query: args?.query,
        limit: args?.limit
      });
      const lines = (result.sessions ?? []).map((s) => `- ${s.sessionId} ${s.archived ? '[archived] ' : ''}${s.title ?? '(untitled)'} ${s.updatedAt ?? ''}`);
      return textResult(`${result.sessions?.length ?? 0} conversation(s) on ${result.peer}\n${lines.join('\n')}`, result);
    }
    case 'link_dsh_transcript': {
      const result = await ops.dshTranscript({
        peer: args?.peer,
        sessionId: args?.sessionId,
        limit: args?.limit,
        offset: args?.offset,
        tail: args?.tail === true
      });
      const lines = (result.messages ?? []).map((m) => `[${m.seq ?? '?'}] ${m.role ?? m.kind ?? ''}: ${String(m.text ?? '').slice(0, 400)}`);
      return textResult(`${result.session?.title ?? args?.sessionId} on ${result.peer} — ${result.messages?.length ?? 0}/${result.total ?? '?'} message(s)\n${lines.join('\n')}`, result);
    }
    case 'link_call': {
      const result = await ops.dshCall({
        peer: args?.peer,
        method: args?.method,
        params: args?.params,
        waitSeconds: args?.waitSeconds
      });
      const summary = result.pending
        ? `${args?.method} queued as ${result.commandId} (no bridge answered within ${result.waitedSeconds ?? 0}s)`
        : `${args?.method} -> ${result.status}${result.error ? ': ' + (result.error.message ?? JSON.stringify(result.error)) : ''}`;
      return textResult(summary, result);
    }
    case 'link_help':
      return textResult(HELP_TEXT);
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), { code: 'unknown_tool' });
  }
}

/** Handle one JSON-RPC message; returns a response object, or null for notifications. */
export async function handleMcpMessage(message, { ops, sessionId } = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, msg, data) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: msg, ...(data ? { data } : {}) } });

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_DEFAULT_PROTOCOL;
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'dsh-link', version: MCP_SERVER_VERSION },
          instructions: MCP_INSTRUCTIONS
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOL_DEFS });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (typeof name !== 'string') return fail(-32602, 'tools/call requires a tool name');
        const result = await callTool(name, args, ops);
        return ok(result);
      }
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof Error && err.code === 'unknown_tool') return fail(-32602, err.message);
    return ok(errorResult(err));
  }
}
