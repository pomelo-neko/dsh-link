// dsh-link: one-string pairing (invite/accept) and the DSH profile installer.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DSHLINK_VERSION, LinkError, badRequest, newId, nowIso } from './util.mjs';
import { createInboundToken, slugName } from './config.mjs';
import { allocateVisitorPort } from './tunnel.mjs';

export const INVITE_PREFIX = 'dshlink1:';
export const INVITE_VERSION = 1;

function localUrlOf(cfg) {
  const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}`;
}

function stcpShareOf(cfg) {
  if (!cfg.tunnel?.enabled || !cfg.tunnel?.serverAddr || !cfg.stcp?.secretKey) return null;
  return {
    proxyName: cfg.stcp.proxyName,
    secretKey: cfg.stcp.secretKey,
    serverAddr: cfg.tunnel.serverAddr,
    serverPort: cfg.tunnel.serverPort,
    user: cfg.tunnel.user ?? 'dsh-link'
  };
}

export function encodeInvite(invite) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url');
}

export function decodeInvite(code) {
  const text = String(code ?? '').trim();
  if (!text) throw badRequest('an invite code is required');
  const body = text.startsWith(INVITE_PREFIX) ? text.slice(INVITE_PREFIX.length) : text;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invite code is not valid dsh-link invite data');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.kind !== 'dshlink-invite') throw badRequest('not a dsh-link invite');
  if (parsed.v !== INVITE_VERSION) throw badRequest(`unsupported invite version: ${parsed.v}`);
  if (!parsed.name) throw badRequest('invite has no node name');
  if (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now()) {
    throw new LinkError(410, 'invite_expired', `invite expired at ${parsed.expiresAt}`);
  }
  return parsed;
}

/**
 * Build an invite string for another machine.
 * Mutates cfg when a token is minted — persist the config afterwards.
 */
export function buildInvite(cfg, { withToken = true, ttlMinutes = 0, url, label, note } = {}) {
  const urls = [];
  const push = (value) => {
    if (!value) return;
    const clean = String(value).replace(/\/+$/, '');
    if (!urls.includes(clean)) urls.push(clean);
  };
  push(url);
  push(cfg.publicUrl);
  push(localUrlOf(cfg));
  let token = null;
  let tokenId = null;
  if (withToken) {
    const created = createInboundToken(cfg, label ?? `invite:${cfg.name}`);
    token = created.token;
    tokenId = created.id;
  }
  const invite = {
    v: INVITE_VERSION,
    kind: 'dshlink-invite',
    name: cfg.name,
    nodeId: cfg.nodeId,
    urls,
    token,
    tokenId,
    stcp: stcpShareOf(cfg),
    issuedAt: nowIso(),
    expiresAt: ttlMinutes > 0 ? new Date(Date.now() + ttlMinutes * 60_000).toISOString() : null,
    note: note ?? null,
    software: 'dsh-link',
    softwareVersion: DSHLINK_VERSION
  };
  return { code: encodeInvite(invite), invite };
}

/** Turn an accepted invite into a peer registry entry for this node. */
export function peerEntryFromInvite(cfg, invite, { name, token, visitorPort } = {}) {
  const peerName = slugName(name ?? invite.name);
  if (!peerName) throw badRequest('the invite has no usable node name');
  if (peerName === cfg.name) throw badRequest(`invite is from this node ("${cfg.name}")`);
  const warnings = [];
  const hasStcp = !!(invite.stcp?.proxyName && invite.stcp?.secretKey);
  let stcp = null;
  if (hasStcp) {
    stcp = {
      serverName: invite.stcp.proxyName,
      secretKey: invite.stcp.secretKey,
      visitorPort: Number(visitorPort ?? 0) || allocateVisitorPort(cfg)
    };
  }
  const tunnelReady = hasStcp && cfg.tunnel?.enabled && !!cfg.tunnel?.serverAddr;
  const sameServer = tunnelReady && String(cfg.tunnel.serverAddr) === String(invite.stcp.serverAddr) &&
    Number(cfg.tunnel.serverPort ?? 7000) === Number(invite.stcp.serverPort ?? 7000);
  let url = null;
  let usedStcp = false;
  if (hasStcp && sameServer) {
    url = `http://127.0.0.1:${stcp.visitorPort}`;
    usedStcp = true;
  } else {
    if (hasStcp && cfg.tunnel?.enabled && !sameServer) {
      warnings.push(`invite uses frps ${invite.stcp.serverAddr}:${invite.stcp.serverPort}, this node uses ${cfg.tunnel.serverAddr}:${cfg.tunnel.serverPort} — falling back to the invite URL (visitors only work inside one frps)`);
    } else if (hasStcp && !cfg.tunnel?.enabled) {
      warnings.push('invite carries STCP details but this node has no tunnel configured; run: dshlink tunnel setup');
    }
    url = invite.urls?.[0] ?? (stcp ? `http://127.0.0.1:${stcp.visitorPort}` : null);
  }
  if (!url) throw badRequest('the invite has neither a reachable URL nor STCP details');
  const entry = {
    name: peerName,
    url: String(url).replace(/\/+$/, ''),
    token: token ?? invite.token ?? undefined,
    autoSync: false,
    note: noteFor(invite),
    stcp
  };
  if (!entry.token) warnings.push('the invite carried no token — add one with: dshlink peers add --name <peer> --token <its token>');
  return { entry, warnings, usedStcp, invite };
}

function noteFor(invite) {
  const parts = [`paired ${nowIso().slice(0, 10)}`];
  if (invite.softwareVersion) parts.push(`invite v${invite.softwareVersion}`);
  return parts.join(' ');
}

export function upsertPeer(cfg, entry) {
  const index = cfg.peers.findIndex((peer) => peer.name === entry.name);
  if (index >= 0) {
    cfg.peers[index] = { ...cfg.peers[index], ...entry };
    return { action: 'updated', peer: cfg.peers[index] };
  }
  cfg.peers.push(entry);
  return { action: 'added', peer: entry };
}

// --------------------------------------------------------------------- DSH ---

export function defaultDshHome() {
  // No DSH_HOME (service, scheduled task, plain shell) => the documented default ~/.dsh.
  return process.env.DSH_HOME ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh');
}

function mcpEntry({ url, serverName }) {
  return [
    '- insert:',
    '    - id: mcp-dshlink',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${serverName}`,
    '        transport: streamable-http',
    `        url: ${url}`,
    '        toolCallTimeoutMs: 120000'
  ].join('\n');
}

/** Quote a filesystem path as a YAML double-quoted scalar (backslashes are escapes there). */
function yamlPath(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** One "- insert:" item for the auto-wake bridge plugin (see integrations/dsh-link-bridge). */
function bridgeItem({ workspacePath, nodeUrl, sessionId, pollSeconds, cooldownSeconds }) {
  return [
    '    - id: dsh-link-bridge',
    '      name: dsh-link-bridge',
    '      config:',
    '        enabled: true',
    '        nodeUrl: ' + nodeUrl,
    '        workspacePath: ' + yamlPath(workspacePath),
    '        sessionId: ' + yamlPath(sessionId || ''),
    '        pollSeconds: ' + Number(pollSeconds),
    '        cooldownSeconds: ' + Number(cooldownSeconds)
  ].join('\n');
}

function bridgeBlock(item) {
  return '- insert:\n' + item;
}

export async function planDshInstall({ dshHome = defaultDshHome(), profile = 'web', url = 'http://127.0.0.1:8787/mcp', serverName = 'dshlink', includeSkill = true, projectDir, bridge = false, bridgeWorkspace, bridgeSessionId = '', bridgeNodeUrl = 'http://127.0.0.1:8787', bridgePollSeconds = 15, bridgeCooldownSeconds = 30 } = {}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  const skillSrc = path.join(projectDir ?? path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'integrations', 'dsh-skill');
  const skillDest = path.join(dshHome, 'skills', 'dshlink');
  const existing = await fs.readFile(patchPath, 'utf8').catch(() => null);
  const entry = mcpEntry({ url, serverName });
  const already = !!existing && /id:\s*mcp-dshlink\b/.test(existing);
  const urlMatches = !!existing && new RegExp(`url:\\s*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(existing);
  let plan;
  if (existing === null) {
    plan = { mode: 'create', content: `# created by dsh-link ${DSHLINK_VERSION}\n${entry}\n` };
  } else if (already && urlMatches) {
    plan = { mode: 'unchanged', content: existing };
  } else if (already) {
    plan = { mode: 'update-url', content: existing.replace(/(id:\s*mcp-dshlink[\s\S]*?url:\s*)(\S+)/, `$1${url}`) };
  } else if (/^\s*\[\s*\]\s*$/m.test(existing)) {
    plan = { mode: 'replace-empty', content: existing.replace(/^\s*\[\s*\]\s*$/m, entry) };
  } else {
    plan = { mode: 'append', content: `${existing.replace(/\s*$/, '')}\n\n${entry}\n` };
  }
  let bridgeMode = 'skip';
  if (bridge) {
    if (!bridgeWorkspace) throw new LinkError(2, 'usage', 'installing the auto-wake bridge needs a workspace path (--bridge-workspace <dir>)');
    const item = bridgeItem({
      workspacePath: bridgeWorkspace,
      nodeUrl: bridgeNodeUrl,
      sessionId: bridgeSessionId,
      pollSeconds: bridgePollSeconds,
      cooldownSeconds: bridgeCooldownSeconds
    });
    if (/id:\s*dsh-link-bridge\b/.test(plan.content)) {
      // Replace the whole managed item: its id line plus every indented field line.
      const replaced = plan.content.replace(/ {4}- id:\s*dsh-link-bridge\n(?: {6}.*\n?)*/, item + '\n');
      bridgeMode = replaced === plan.content ? 'unchanged' : 'update';
      plan.content = replaced;
    } else {
      plan.content = plan.content.replace(/\s*$/, '') + '\n\n' + bridgeBlock(item) + '\n';
      bridgeMode = plan.mode === 'create' ? 'create' : 'append';
    }
    if (plan.mode === 'unchanged') plan.mode = 'bridge-' + bridgeMode;
  }

  let skillAction = 'skip';
  if (includeSkill) {
    const srcText = await fs.readFile(path.join(skillSrc, 'SKILL.md'), 'utf8').catch(() => null);
    const destText = await fs.readFile(path.join(skillDest, 'SKILL.md'), 'utf8').catch(() => null);
    if (srcText === null) skillAction = 'source-missing';
    else if (destText === null) skillAction = 'install';
    else if (destText.trim() === srcText.trim()) skillAction = 'unchanged';
    else skillAction = 'update';
  }
  return {
    dshHome,
    profile,
    profileDir,
    patchPath,
    patchExists: existing !== null,
    patchMode: plan.mode,
    patchContent: plan.content,
    mcp: { id: 'mcp-dshlink', name: '@deepseek-ai/dsh-mcp-client', url, serverName },
    bridge: bridge
      ? {
        id: 'dsh-link-bridge',
        name: 'dsh-link-bridge',
        mode: bridgeMode,
        workspacePath: bridgeWorkspace,
        nodeUrl: bridgeNodeUrl,
        sessionId: bridgeSessionId || null,
        pollSeconds: bridgePollSeconds
      }
      : null,
    skill: { src: skillSrc, dest: skillDest, action: skillAction, include: includeSkill },
    pluginResolvable: await resolvable(dshHome, '@deepseek-ai/dsh-mcp-client')
  };
}

async function resolvable(dshHome, spec) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(dshHome, 'profiles', 'web', 'package.json'));
    require.resolve(spec);
    return true;
  } catch {
    return false;
  }
}

async function validateYaml(dshHome, text) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(dshHome, 'package.json'));
    const yamlPath = require.resolve('yaml');
    const yaml = await import(new URL(`file:///${yamlPath.replace(/\\/g, '/')}`).href);
    const parsed = yaml.parse(text);
    if (!Array.isArray(parsed)) throw new Error('the patch file must be a YAML array');
    return { validated: true, entries: parsed.length };
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') return { validated: false, reason: 'no yaml parser available next to DSH_HOME' };
    throw new LinkError(400, 'invalid_patch', `generated patch would not parse: ${err.message}`);
  }
}

export async function applyDshInstall(plan, { dryRun = true } = {}) {
  const result = { ...plan, written: false, backupPath: null, skillWritten: false, validation: null };
  if (dryRun) return result;
  if (plan.patchMode !== 'unchanged') {
    result.validation = await validateYaml(plan.dshHome, plan.patchContent);
    if (plan.patchExists) {
      const backupPath = `${plan.patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.copyFile(plan.patchPath, backupPath);
      result.backupPath = backupPath;
    }
    await fs.mkdir(path.dirname(plan.patchPath), { recursive: true });
    await fs.writeFile(plan.patchPath, plan.patchContent, 'utf8');
    result.written = true;
  }
  if (plan.skill.include && ['install', 'update'].includes(plan.skill.action)) {
    if (plan.skill.action === 'update') {
      await fs.copyFile(path.join(plan.skill.dest, 'SKILL.md'), `${path.join(plan.skill.dest, 'SKILL.md')}.bak-${Date.now()}`);
    }
    await fs.mkdir(plan.skill.dest, { recursive: true });
    await fs.copyFile(path.join(plan.skill.src, 'SKILL.md'), path.join(plan.skill.dest, 'SKILL.md'));
    result.skillWritten = true;
  }
  return result;
}

export function newInviteId() {
  return newId('pair');
}
