import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROJECT_DIR } from './helpers.mjs';
import { DSHLINK_VERSION } from '../src/util.mjs';

test('release: package.json, runtime and FRP provider name agree on the version', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.version, DSHLINK_VERSION, 'package.json version must match DSHLINK_VERSION in src/util.mjs');

  const server = await fs.readFile(path.join(PROJECT_DIR, 'src', 'server.mjs'), 'utf8');
  assert.match(server, /version: DSHLINK_VERSION/);
});
test('release: every PowerShell script keeps its UTF-8 BOM', async () => {
  // Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM, which corrupts the Chinese
  // text and can break quoting/parsing. Editing tools often drop the BOM: run `npm run bom`.
  const dirs = ['scripts', 'packaging', 'test', 'integrations'];
  const found = [];
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (/(^|\\)(dist|node_modules|\.tmp)(\\|$)/.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.toLowerCase().endsWith('.ps1')) found.push(full);
    }
  };
  for (const dir of dirs) await walk(path.join(PROJECT_DIR, dir));
  assert.ok(found.length >= 3, `expected to find .ps1 files, got ${found.length}`);
  for (const file of found) {
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.startsWith('\uFEFF'), `${path.relative(PROJECT_DIR, file)} lost its UTF-8 BOM — run: npm run bom`);
  }
});
