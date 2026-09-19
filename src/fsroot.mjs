// dsh-link: sandboxed access to shared directories. Every path is confined to a configured root.
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden, matchesAnyGlob, notFound } from './util.mjs';
import { slugName } from './config.mjs';

function expandDenyGlobs(globs) {
  const out = [];
  for (const glob of globs) {
    out.push(glob);
    if (glob.startsWith('**/')) out.push(glob.slice(3));
  }
  return out;
}

export function normalizeRelPath(relPath) {
  let rel = String(relPath ?? '').replace(/\\/g, '/').trim();
  if (rel === '' || rel === '.' || rel === '/') return '';
  if (rel.startsWith('/')) throw forbidden('absolute paths are not allowed', { path: relPath });
  if (/^[A-Za-z]:/.test(rel)) throw forbidden('absolute paths are not allowed', { path: relPath });
  if (rel.includes('\0')) throw badRequest('path contains a NUL byte');
  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (segment === '..') throw forbidden('parent traversal is not allowed', { path: relPath });
    if (segment.includes(':')) throw forbidden('invalid path segment', { path: relPath, segment });
  }
  return segments.join('/');
}

/** Normalize one configured root. `kind: 'workspaces'` makes it a virtual root over the local DSH workspace registry. */
function mapRoot(root) {
  const base = { name: slugName(root.name), read: root.read !== false, write: root.write === true };
  if (root.kind === 'workspaces' || root.kind === 'dsh-workspaces') return { ...base, kind: 'workspaces', path: null };
  return { ...base, kind: 'dir', path: path.resolve(root.path) };
}

export function isInside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class FileRoots {
  constructor(filesCfg = {}, { dshView = null } = {}) {
    this.roots = (filesCfg.roots ?? []).map(mapRoot);
    this.dshView = dshView;
    this.deny = expandDenyGlobs(filesCfg.deny ?? []);
    this.allowUpload = filesCfg.allowUpload === true;
    this.maxListEntries = filesCfg.maxListEntries ?? 2000;
    this.maxInlineQuery = filesCfg.maxInlineQuery ?? 0;
    this._real = new Map();
  }

  /** Re-read the shared-folder settings after a config-file change (see src/reload.mjs). */
  reconfigure(filesCfg = {}, { dshView } = {}) {
    this.roots = (filesCfg.roots ?? []).map(mapRoot);
    if (dshView !== undefined) this.dshView = dshView;
    this.deny = expandDenyGlobs(filesCfg.deny ?? []);
    this.allowUpload = filesCfg.allowUpload === true;
    this.maxListEntries = filesCfg.maxListEntries ?? 2000;
    this.maxInlineQuery = filesCfg.maxInlineQuery ?? 0;
    this._real = new Map();
    return this.describe();
  }

  describe() {
    return this.roots.map((r) => r.kind === 'workspaces'
      ? { name: r.name, kind: 'workspaces', path: null, read: r.read, write: r.write, allowUpload: this.allowUpload }
      : { name: r.name, kind: 'dir', path: r.path, read: r.read, write: r.write, allowUpload: this.allowUpload });
  }

  /**
   * Resolve the first path segment of a `workspaces` root to one DSH workspace record.
   * Accepts the workspace id, its title slug, or a trailing piece of its path.
   */
  async _resolveWorkspace(root, selector) {
    if (!this.dshView) throw forbidden('root "' + root.name + '" needs the DSH workspace view; set "dsh": {"enabled": true} in the node config');
    const view = await this.dshView.available();
    if (!view || view.ok !== true) throw notFound('the DSH workspace view is unavailable (' + ((view && view.reason) || 'unknown') + ')');
    const list = await this.dshView.workspaces();
    const wanted = String(selector).toLowerCase();
    const normalize = (value) => String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const workspace = list.find((w) => String(w.id).toLowerCase() === wanted)
      ?? list.find((w) => slugName(w.title).toLowerCase() === wanted)
      ?? list.find((w) => normalize(w.path) === wanted || normalize(w.path).endsWith('/' + wanted));
    if (!workspace) throw notFound('unknown DSH workspace: ' + selector, { known: list.map((w) => w.id) });
    return workspace;
  }

  async _listWorkspaces(root) {
    if (!this.dshView) throw forbidden('root "' + root.name + '" needs the DSH workspace view; set "dsh": {"enabled": true} in the node config');
    const view = await this.dshView.available();
    if (!view || view.ok !== true) throw notFound('the DSH workspace view is unavailable (' + ((view && view.reason) || 'unknown') + ')');
    return this.dshView.workspaces();
  }

  getRoot(name) {
    if (name === undefined || name === null || name === '' || name === 'self') {
      const first = this.roots[0];
      if (!first) throw notFound('no file roots are configured on this node');
      return first;
    }
    const wanted = slugName(name);
    const root = this.roots.find((r) => r.name === wanted);
    if (!root) throw notFound(`unknown file root: ${name}`, { known: this.roots.map((r) => r.name) });
    return root;
  }

  isDenied(relPath) {
    if (!relPath) return false;
    const basename = relPath.split('/').pop();
    return matchesAnyGlob(this.deny, relPath, basename);
  }

  async _realRoot(root, cacheKey = root.name) {
    if (this._real.has(cacheKey)) return this._real.get(cacheKey);
    let real;
    try {
      real = await fs.realpath(root.path);
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`file root "${root.name}" does not exist: ${root.path}`);
      throw err;
    }
    this._real.set(cacheKey, real);
    return real;
  }

  /** Resolve a root-relative path to an absolute path, proving confinement after symlink resolution. */
  async resolve(rootName, relPath, { forWrite = false } = {}) {
    const root = this.getRoot(rootName);
    if (!root.read && !forWrite) throw forbidden(`root "${root.name}" is not readable`);
    if (forWrite) {
      if (!root.write) throw forbidden(`root "${root.name}" is read-only`);
    }
    let rel = normalizeRelPath(relPath);
    let base = root.path;
    let cacheKey = root.name;
    let displayPrefix = root.name;
    let workspace = null;
    if (root.kind === 'workspaces') {
      const segments = rel === '' ? [] : rel.split('/');
      const selector = segments.shift() ?? '';
      if (!selector) {
        throw badRequest('root "' + root.name + '" addresses DSH workspaces: use ' + root.name + ':<workspace-id|title>/<path>');
      }
      workspace = await this._resolveWorkspace(root, selector);
      rel = segments.join('/');
      base = workspace.path;
      cacheKey = root.name + '|' + workspace.id;
      displayPrefix = root.name + ':' + selector;
    }
    if (this.isDenied(rel)) throw forbidden(`path is blocked by the deny list: ${rel}`, { path: rel });
    const realRoot = await this._realRoot({ ...root, path: base }, cacheKey);
    const abs = path.resolve(realRoot, rel);
    if (!isInside(realRoot, abs)) throw forbidden('path escapes the root', { path: rel });
    // Walk up to the deepest existing ancestor and resolve it, so junctions/symlinks cannot escape.
    let ancestor = abs;
    for (;;) {
      try {
        await fs.lstat(ancestor);
        break;
      } catch {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    let realAncestor;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch {
      realAncestor = ancestor;
    }
    const realTarget = path.resolve(realAncestor, path.relative(ancestor, abs));
    if (!isInside(realRoot, realTarget)) throw forbidden('path escapes the root through a link', { path: rel });
    return {
      root,
      rel,
      abs: realTarget,
      workspace,
      displayPath: rel === '' ? displayPrefix : `${displayPrefix}/${rel}`
    };
  }

  async statPath(rootName, relPath) {
    const resolved = await this.resolve(rootName, relPath);
    let stat;
    try {
      stat = await fs.stat(resolved.abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`no such path: ${resolved.displayPath}`);
      throw err;
    }
    return {
      root: resolved.root.name,
      path: resolved.rel,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      readonly: !resolved.root.write
    };
  }

  async listDir(rootName, relPath = '', { limit } = {}) {
    const root = this.getRoot(rootName);
    if (root.kind === 'workspaces' && normalizeRelPath(relPath) === '') {
      const workspaces = await this._listWorkspaces(root);
      const max = limit ?? this.maxListEntries;
      const entries = workspaces.slice(0, max).map((w) => ({
        name: slugName(w.title) || w.id,
        type: 'dir',
        link: false,
        size: 0,
        mtime: w.lastActivityAt ?? null,
        path: w.id,
        workspaceId: w.id,
        title: w.title
      }));
      return { root: root.name, path: '', count: entries.length, truncated: workspaces.length > max, entries };
    }
    const resolved = await this.resolve(rootName, relPath);
    let entries;
    try {
      entries = await fs.readdir(resolved.abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`no such directory: ${resolved.displayPath}`);
      if (err.code === 'ENOTDIR') throw badRequest(`not a directory: ${resolved.displayPath}`);
      throw err;
    }
    const max = limit ?? this.maxListEntries;
    const out = [];
    for (const entry of entries) {
      const childRel = resolved.rel ? `${resolved.rel}/${entry.name}` : entry.name;
      if (this.isDenied(childRel)) continue;
      const childAbs = path.join(resolved.abs, entry.name);
      let stat = null;
      try {
        stat = await fs.stat(childAbs);
      } catch {
        continue;
      }
      out.push({
        name: entry.name,
        type: stat.isDirectory() ? 'dir' : 'file',
        link: entry.isSymbolicLink(),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        path: childRel
      });
      if (out.length >= max) break;
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { root: resolved.root.name, path: resolved.rel, count: out.length, truncated: out.length >= max, entries: out };
  }

  async hashFile(rootName, relPath) {
    const resolved = await this.resolve(rootName, relPath);
    const stat = await fs.stat(resolved.abs);
    if (stat.isDirectory()) throw badRequest('cannot hash a directory');
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      createReadStream(resolved.abs).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
    });
    return { root: resolved.root.name, path: resolved.rel, size: stat.size, mtime: stat.mtime.toISOString(), sha256: hash.digest('hex') };
  }

  async openRead(rootName, relPath) {
    const resolved = await this.resolve(rootName, relPath);
    const stat = await fs.stat(resolved.abs);
    if (stat.isDirectory()) throw badRequest(`cannot download a directory: ${resolved.displayPath}`);
    return { ...resolved, stat };
  }

  async writeFile(rootName, relPath, buffer) {
    if (!this.allowUpload) throw forbidden('this node does not accept uploads (files.allowUpload is false)');
    const resolved = await this.resolve(rootName, relPath, { forWrite: true });
    if (resolved.rel === '') throw badRequest('a target file path is required');
    await fs.mkdir(path.dirname(resolved.abs), { recursive: true });
    const tmp = `${resolved.abs}.${process.pid}.part`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, resolved.abs);
    return { root: resolved.root.name, path: resolved.rel, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
  }
}
