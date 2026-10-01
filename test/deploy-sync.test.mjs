import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { TMP, resetTmp } from './helpers.mjs';
import {
  applySync,
  compareTrees,
  compileKeep,
  formatReport,
  globToRegExp,
  isLocal,
  isSkipped,
  resolveTrees
} from '../scripts/deploy-sync.mjs';

async function put(root, relative, text) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

/** A miniature repository/deployment pair with every classification represented once. */
async function makeTrees() {
  await resetTmp();
  const repo = path.join(TMP, 'deploy-repo');
  const target = path.join(TMP, 'deploy-target');
  await put(repo, 'a.txt', 'same');
  await put(repo, 'b.txt', 'new revision');
  await put(repo, 'c.txt', 'only in the repository');
  await put(repo, 'package.json', JSON.stringify({ name: 'dsh-link', version: '0.3.1' }));
  await put(repo, 'dist/bundle.txt', 'build output');
  await put(repo, 'test/.tmp/scratch.txt', 'scratch');
  await put(repo, 'vendor/frp/windows-amd64/frpc.exe', 'binary');
  await put(repo, 'vendor/frp/SHA256SUMS.txt', 'sums');

  await put(target, 'a.txt', 'same');
  await put(target, 'b.txt', 'old revision');
  await put(target, 'd.txt', 'left over from an older sync');
  await put(target, 'dshlink.config.json', '{"port":8787}');
  await put(target, 'README.local.md', 'site notes');
  await put(target, 'vendor/frp/windows-amd64/frpc.exe', 'binary');
  await put(target, 'package.json', JSON.stringify({ name: 'dsh-link', version: '0.3.0' }));
  return { repo, target };
}

test('deploy-sync: the deployed tree is resolved explicitly, never guessed from a home default', () => {
  assert.deepEqual(
    resolveTrees({ repo: 'D:\\dsh-link', target: 'D:\\deploy', env: {} }),
    { repoDir: path.resolve('D:\\dsh-link'), targetDir: path.resolve('D:\\deploy') }
  );
  assert.equal(
    resolveTrees({ repo: 'D:\\dsh-link', env: { DSHLINK_DEPLOY_DIR: 'D:\\from-env' } }).targetDir,
    path.resolve('D:\\from-env')
  );
  assert.equal(
    resolveTrees({ repo: 'D:\\dsh-link', env: { DSH_HOME: 'D:\\DSH' } }).targetDir,
    path.join('D:\\DSH', 'plugins', 'vendored', 'dsh-link')
  );
  assert.throws(
    () => resolveTrees({ repo: 'D:\\dsh-link', env: {} }),
    /where is the deployed tree/,
    'without any hint the tool must ask instead of reading the wrong DSH home'
  );
});

test('deploy-sync: build output, scratch and vendored binaries are outside the comparison', () => {
  assert.equal(isSkipped('dist/x.js'), true);
  assert.equal(isSkipped('test/.tmp/unit/a.txt'), true);
  assert.equal(isSkipped('vendor/frp/windows-amd64/frpc.exe'), true);
  assert.equal(isSkipped('vendor/frp/SHA256SUMS.txt'), false, 'the tracked sums file still syncs');
  assert.equal(isSkipped('src/server.mjs'), false);

  assert.equal(isLocal('dshlink.config.json'), true);
  assert.equal(isLocal('README.local.md'), true);
  assert.equal(isLocal('.gitignore'), false);
});

test('deploy-sync: compare classifies missing, different, stale and local files', async () => {
  const { repo, target } = await makeTrees();
  const result = await compareTrees(repo, target);

  assert.deepEqual(result.missing, ['c.txt', 'vendor/frp/SHA256SUMS.txt']);
  assert.deepEqual(result.different, ['b.txt', 'package.json']);
  assert.deepEqual(result.stale, ['d.txt']);
  assert.deepEqual(result.identical, ['a.txt']);
  assert.deepEqual(result.local, ['README.local.md', 'dshlink.config.json', 'vendor/frp/windows-amd64/frpc.exe']);
  assert.equal(result.drift, 5, '2 missing + 2 different + 1 stale');
  assert.equal(result.counts.repo, 5, 'a.txt, b.txt, c.txt, package.json and the tracked vendor sums file');

  const report = formatReport(result);
  assert.match(report, /missing here     : 2/);
  assert.match(report, /different content: 2/);
  assert.match(report, /stale in target  : 1/);
  assert.match(report, /run with --apply --write/);
});

test('deploy-sync: apply without --write only reports what it would do', async () => {
  const { repo, target } = await makeTrees();
  const result = await compareTrees(repo, target);
  const planned = await applySync(result, { write: false });
  assert.deepEqual(planned.wrote, []);
  assert.deepEqual(planned.planned, ['c.txt', 'vendor/frp/SHA256SUMS.txt', 'b.txt', 'package.json']);
  assert.equal(await fs.readFile(path.join(target, 'b.txt'), 'utf8'), 'old revision', 'nothing was copied');
});

test('deploy-sync: apply --write copies the repository revision and backs up what it overwrites', async () => {
  const { repo, target } = await makeTrees();
  const backupRoot = path.join(TMP, 'deploy-backups');
  const result = await compareTrees(repo, target);
  const applied = await applySync(result, { write: true, backupRoot });

  assert.deepEqual(applied.wrote, ['c.txt', 'vendor/frp/SHA256SUMS.txt', 'b.txt', 'package.json']);
  assert.equal(await fs.readFile(path.join(target, 'b.txt'), 'utf8'), 'new revision');
  assert.equal(await fs.readFile(path.join(target, 'c.txt'), 'utf8'), 'only in the repository');
  assert.deepEqual(applied.removed, [], 'a stale file is never deleted unless asked');
  assert.equal(await fs.readFile(path.join(target, 'd.txt'), 'utf8'), 'left over from an older sync');
  assert.equal(
    await fs.readFile(path.join(applied.backupDir, 'b.txt'), 'utf8'),
    'old revision',
    'the overwritten file is recoverable'
  );
  assert.equal(await fs.readFile(path.join(target, 'dshlink.config.json'), 'utf8'), '{"port":8787}', 'local files are untouched');
});

test('deploy-sync: --delete-extra removes stale files, with a backup', async () => {
  const { repo, target } = await makeTrees();
  const result = await compareTrees(repo, target);
  const applied = await applySync(result, { write: true, deleteExtra: true, backupRoot: path.join(TMP, 'deploy-backups-2') });
  assert.deepEqual(applied.removed, ['d.txt']);
  assert.equal(
    await fs.readFile(path.join(target, 'vendor/frp/windows-amd64/frpc.exe'), 'utf8'),
    'binary',
    'the machine\'s frp binary is local, so --delete-extra must not remove it'
  );
  await assert.rejects(fs.access(path.join(target, 'd.txt')));
  assert.equal(await fs.readFile(path.join(applied.backupDir, 'd.txt'), 'utf8'), 'left over from an older sync');
  const after = await compareTrees(repo, target);
  assert.deepEqual(after.stale, []);
  assert.equal(after.drift, 0, 'once synced the trees agree');
});

test('deploy-sync: a missing deployed tree reports cleanly', async () => {
  const { repo } = await makeTrees();
  const result = await compareTrees(repo, path.join(TMP, 'does-not-exist'));
  assert.deepEqual(result.missing.sort(), ['a.txt', 'b.txt', 'c.txt', 'package.json', 'vendor/frp/SHA256SUMS.txt'].sort());
  assert.deepEqual(result.local, []);
  assert.equal(result.counts.target, 0);
});

test('deploy-sync: --keep marks a site-owned file as out of scope instead of drift', async () => {
  const { repo, target } = await makeTrees();
  await put(repo, 'scripts/start-dshlink.ps1', 'repo default config path');
  await put(target, 'scripts/start-dshlink.ps1', 'site config path');
  const before = await compareTrees(repo, target);
  assert.ok(before.different.includes('scripts/start-dshlink.ps1'), 'without --keep it is drift');

  const result = await compareTrees(repo, target, { keep: ['scripts/start-dshlink.ps1'] });
  assert.deepEqual(result.kept, ['scripts/start-dshlink.ps1']);
  assert.ok(!result.different.includes('scripts/start-dshlink.ps1'));
  assert.ok(!result.missing.includes('scripts/start-dshlink.ps1'));
  assert.match(formatReport(result), /kept \(site files\): scripts\/start-dshlink\.ps1/);

  const applied = await applySync(result, { write: true, backupRoot: path.join(TMP, 'deploy-backups-keep') });
  assert.ok(!applied.wrote.includes('scripts/start-dshlink.ps1'), 'a kept file is never overwritten');
  assert.equal(await fs.readFile(path.join(target, 'scripts/start-dshlink.ps1'), 'utf8'), 'site config path');
});

test('deploy-sync: keep globs span directories, stay inside one segment, and ignore case', () => {
  assert.equal(globToRegExp('scripts/start-dshlink.ps1').test('scripts/start-dshlink.ps1'), true);
  assert.equal(globToRegExp('scripts/*.ps1').test('scripts/anything.ps1'), true);
  assert.equal(globToRegExp('scripts/*.ps1').test('scripts/sub/x.ps1'), false, '* stops at a slash');
  assert.equal(globToRegExp('**/start-dshlink.ps1').test('a/b/start-dshlink.ps1'), true, '** spans directories');
  assert.equal(globToRegExp('Scripts/Start-Dshlink.PS1').test('scripts/start-dshlink.ps1'), true, 'case-insensitive');
  assert.equal(compileKeep(['a.txt']).length, 1);
});
