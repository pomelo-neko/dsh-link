#!/usr/bin/env node
// Compare the repository with the tree DSH actually runs, and (on request) update it by hand.
//
// The deployed tree is a plain copy of this repository under
// \`<DSH_HOME>/plugins/vendored/dsh-link\` that the DSH profile links to. Nothing keeps the two in
// step: the copy was moved here from an older deployment and carries a few machine-local edits, so
// "is the running code the code I just committed?" is a real question with no cheap answer.
//
// This tool answers it and nothing else:
//   --check          classify every file (missing / different / local / stale) and exit 1 on drift
//   --apply --write  copy the differing repository files over the deployed tree, with a backup
//
// It is deliberately manual: applying a sync only changes files on disk, and the running node
// (and, for the bridge, the DSH host) keeps the old code in memory until it is restarted — which
// stays an operator decision. Nothing here restarts a process.
//
// Usage:
//   node scripts/deploy-sync.mjs --check [--json]
//   node scripts/deploy-sync.mjs --apply --write [--delete-extra] [--keep <glob>]
//
// --keep marks files that belong to the deployed machine (a site-edited start script, for example):
// they are neither compared nor copied nor reported as drift.
//   node scripts/deploy-sync.mjs --check --target <deployed tree> [--repo <checkout>]

import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directories never compared on either side: build output and runtime scratch. */
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.dshlink', '.deploy-backup']);
/** Repository paths that are vendored binaries or generated, so they are not part of a sync. */
export const SKIP_PATTERNS = [
  /^test[\\/]\.tmp[\\/]/,
  /^vendor[\\/]frp[\\/][^\\/]+-amd64[\\/]/,
  /^.*\.log$/
];
/** Files that belong to the deployed machine only: reported as local, never copied or deleted. */
export const LOCAL_PATTERNS = [
  /^dshlink\.config\.json$/,
  // The vendored frp binaries are downloaded per machine (scripts/verify-vendor.mjs checks them).
  // They must never count as "stale", or --delete-extra would remove the machine's frpc.
  /^vendor[\\/]frp[\\/][^\\/]+-amd64[\\/]/,
  /^dshlink\.config\..*\.json$/,
  /^README\.local\./,
  /^local[\\/]/,
  /\.local\.[^\\/]*$/,
  /^test[\\/]\.tmp[\\/]/
];

function matches(patterns, relative) {
  return patterns.some((pattern) => pattern.test(relative));
}

/** Glob for --keep: `**` spans directories, `*` stays inside one segment, case-insensitive. */
export function globToRegExp(glob) {
  const escaped = String(glob)
    .split('/')
    .map((segment) => segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*'))
    .join('/');
  return new RegExp('^' + escaped + '$', 'i');
}

/** Compile --keep globs; matching files are site-owned and left out of the comparison. */
export function compileKeep(patterns = []) {
  return patterns.map((pattern) => globToRegExp(pattern));
}

/** Skip rules for the repository side; the deployed side uses LOCAL_PATTERNS instead. */
export function isSkipped(relative) {
  return SKIP_DIRS.has(relative.split('/')[0]) || matches(SKIP_PATTERNS, relative);
}

export function isLocal(relative) {
  const head = relative.split('/')[0];
  return SKIP_DIRS.has(head) || matches(LOCAL_PATTERNS, relative);
}

async function hashFile(file) {
  const data = await fs.readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

/** Every comparable file under a root, keyed by its slash-separated relative path. */
export async function collectTree(root, keep) {
  const found = new Map();
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (keep(relative)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) found.set(relative, { path: absolute, hash: await hashFile(absolute) });
    }
  }
  await walk(root, '');
  return found;
}

/** Resolve the two trees. The deployed path is never guessed from ~/.dsh: that is the footgun
 *  documented in OPERATIONS.md, where a service-started process reads a different DSH home. */
export function resolveTrees({ repo, target, dshHome, env = process.env } = {}) {
  const repoDir = path.resolve(repo ?? path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'));
  const home = dshHome ?? env.DSH_HOME;
  const deployed = target ?? env.DSHLINK_DEPLOY_DIR ?? (home ? path.join(home, 'plugins', 'vendored', 'dsh-link') : null);
  if (!deployed) {
    throw new Error('where is the deployed tree? pass --target <dir>, set DSHLINK_DEPLOY_DIR, or set DSH_HOME (so <DSH_HOME>/plugins/vendored/dsh-link can be used)');
  }
  return { repoDir, targetDir: path.resolve(deployed) };
}

/** Classify both trees. This is the whole product: a diff an operator can read and act on. */
export async function compareTrees(repoDir, targetDir, { keep = [] } = {}) {
  const keepPatterns = compileKeep(keep);
  const isKept = (relative) => matches(keepPatterns, relative);
  const [repoFiles, targetFiles] = await Promise.all([
    collectTree(repoDir, (relative) => isSkipped(relative) || isKept(relative)),
    collectTree(targetDir, (relative) => isLocal(relative) || isKept(relative))
  ]);
  const missing = [];   // in the repository, not deployed yet
  const different = []; // deployed, but an older/different revision
  const identical = [];
  for (const [relative, entry] of repoFiles) {
    const deployed = targetFiles.get(relative);
    if (!deployed) missing.push(relative);
    else if (deployed.hash !== entry.hash) different.push(relative);
    else identical.push(relative);
  }
  const stale = [];
  const localOnly = [];
  for (const relative of targetFiles.keys()) {
    if (repoFiles.has(relative)) continue;
    (matches(LOCAL_PATTERNS, relative) ? localOnly : stale).push(relative);
  }
  // Untracked-but-local files were filtered out of targetFiles already; list them for the report.
  const local = await listLocalOnly(targetDir);
  return {
    repoDir,
    targetDir,
    counts: { repo: repoFiles.size, target: targetFiles.size, identical: identical.length },
    identical: identical.sort(),
    missing: missing.sort(),
    different: different.sort(),
    stale: stale.sort(),
    localOnly: localOnly.sort(),
    local,
    kept: keep.map(String).sort(),
    drift: missing.length + different.length + stale.length
  };
}

/** Files the deployed tree owns (config, binaries, local docs) — never touched by a sync. */
async function listLocalOnly(targetDir) {
  const found = [];
  async function walk(dir, prefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const absolute = path.join(dir, entry.name);
      const skippedHere = SKIP_DIRS.has(relative.split('/')[0]);
      if (entry.isDirectory()) {
        if (skippedHere) continue;
        await walk(absolute, relative);
      } else if (entry.isFile() && !skippedHere && matches(LOCAL_PATTERNS, relative)) {
        found.push(relative);
      }
    }
  }
  await walk(targetDir, '');
  return found.sort();
}

export function formatReport(result, { apply = false } = {}) {
  const lines = [];
  lines.push((apply ? 'deploy-sync: repository -> ' : 'deploy-sync: compare repository with ') + result.targetDir);
  lines.push('  repository files : ' + result.counts.repo);
  lines.push('  identical        : ' + result.counts.identical);
  lines.push('  missing here     : ' + result.missing.length + (result.missing.length ? ' (in the repository, not deployed)' : ''));
  lines.push('  different content: ' + result.different.length + (result.different.length ? ' (deployed copy is older or edited)' : ''));
  lines.push('  stale in target  : ' + result.stale.length + (result.stale.length ? ' (not in the repository any more)' : ''));
  if (result.local.length) lines.push('  local to target  : ' + result.local.length + ' (config/binaries/local docs, left alone)');
  if (result.kept.length) lines.push('  kept (site files): ' + result.kept.join(', '));
  const version = result.versions;
  if (version) lines.push('  version          : repo ' + (version.repo ?? '?') + ' / deployed ' + (version.deployed ?? '?'));
  if (result.missing.length) {
    lines.push('  --- missing ---');
    for (const file of result.missing.slice(0, 40)) lines.push('    + ' + file);
    if (result.missing.length > 40) lines.push('    ... ' + (result.missing.length - 40) + ' more');
  }
  if (result.different.length) {
    lines.push('  --- different ---');
    for (const file of result.different.slice(0, 40)) lines.push('    ~ ' + file);
    if (result.different.length > 40) lines.push('    ... ' + (result.different.length - 40) + ' more');
  }
  if (result.stale.length) {
    lines.push('  --- stale in target ---');
    for (const file of result.stale.slice(0, 40)) lines.push('    - ' + file);
    if (result.stale.length > 40) lines.push('    ... ' + (result.stale.length - 40) + ' more');
  }
  if (result.wrote) {
    lines.push('  --- written ---');
    for (const file of result.wrote) lines.push('    > ' + file);
    lines.push('  backup           : ' + result.backupDir);
    lines.push('  restart needed   : node for bin/src changes; DSH host for integrations/dsh-link-bridge changes');
  }
  if (!apply && result.drift) lines.push('  => drift: ' + result.drift + ' file(s); run with --apply --write to update the deployed tree');
  return lines.join('\n');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Default backup root: next to the node's data dir when DSH_HOME is known, else the temp dir. */
export function defaultBackupRoot(env = process.env) {
  const base = env.DSHLINK_DEPLOY_BACKUP ?? (env.DSH_HOME ? path.join(env.DSH_HOME, 'plugin-data', 'dsh-link-deploy-backups') : path.join(os.tmpdir(), 'dsh-link-deploy-backups'));
  return base;
}

/**
 * Copy the differing repository files over the deployed tree. Backs up every file it overwrites,
 * never deletes unless told to, and reports what it did so the operator can restart deliberately.
 */
export async function applySync(result, { write = false, deleteExtra = false, backupRoot } = {}) {
  const backupDir = path.join(backupRoot ?? defaultBackupRoot(), timestamp());
  const wrote = [];
  const removed = [];
  const plan = [...result.missing, ...result.different];
  if (!write) return { ...result, wrote, removed, backupDir, planned: plan };
  for (const relative of plan) {
    const from = path.join(result.repoDir, relative);
    const to = path.join(result.targetDir, relative);
    if (existsSync(to)) {
      const backup = path.join(backupDir, relative);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(to, backup);
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    wrote.push(relative);
  }
  if (deleteExtra) {
    for (const relative of result.stale) {
      const target = path.join(result.targetDir, relative);
      const backup = path.join(backupDir, relative);
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(target, backup);
      await fs.rm(target, { force: true });
      removed.push(relative);
    }
  }
  return { ...result, wrote, removed, backupDir, planned: plan };
}

async function versionsOf(repoDir, targetDir) {
  const read = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')).version ?? null; } catch { return null; }
  };
  return {
    repo: await read(path.join(repoDir, 'package.json')),
    deployed: await read(path.join(targetDir, 'package.json')),
    bridgeRepo: await read(path.join(repoDir, 'integrations', 'dsh-link-bridge', 'package.json')),
    bridgeDeployed: await read(path.join(targetDir, 'integrations', 'dsh-link-bridge', 'package.json'))
  };
}

async function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  // --keep <glob> (repeatable, comma-separated): site-owned files the sync must not touch.
  const keep = argv
    .flatMap((arg, index) => (arg === '--keep' ? [argv[index + 1]] : []))
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const apply = flags.has('--apply');
  const write = flags.has('--write');
  const json = flags.has('--json');
  if (!apply && !flags.has('--check')) {
    console.error('usage: node scripts/deploy-sync.mjs --check [--json] | --apply [--write] [--delete-extra]');
    console.error('       [--repo <checkout>] [--target <deployed tree>] [--dsh-home <dir>]');
    return 2;
  }
  let trees;
  try {
    trees = resolveTrees({ repo: value('--repo'), target: value('--target'), dshHome: value('--dsh-home') });
  } catch (error) {
    console.error(String(error.message));
    return 2;
  }
  if (!existsSync(trees.targetDir)) {
    console.error('deployed tree not found: ' + trees.targetDir);
    return 2;
  }
  let result = await compareTrees(trees.repoDir, trees.targetDir, { keep });
  result.versions = await versionsOf(trees.repoDir, trees.targetDir);
  if (apply) {
    result = await applySync(result, { write, deleteExtra: flags.has('--delete-extra'), backupRoot: value('--backup-dir') });
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatReport(result, { apply }));
  if (!apply && result.drift) return 1;
  return 0;
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error('deploy-sync failed: ' + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
  });
}
