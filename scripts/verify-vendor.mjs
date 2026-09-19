// Verify the frp binaries you downloaded against the sha256 values recorded next to this repo.
//
// dsh-link does NOT ship frp: see vendor/README.md for the download links and the two target
// directories. This check is here because the frp binaries are UNSIGNED, and antivirus products
// (Huorong/火绒 and friends) sometimes block execution or quarantine them silently — that turns a
// mysterious "the tunnel does not start" into one clear line per file.
//
//   node scripts/verify-vendor.mjs                          # everything in the manifest
//   node scripts/verify-vendor.mjs --platform linux-amd64   # only the files you actually have
//   node scripts/verify-vendor.mjs --strict                 # missing files fail too
//   node scripts/verify-vendor.mjs --json
//
// Exit codes: 0 = every file that is present matches; 1 = a file is corrupt/changed, or --strict
// and something is missing; 2 = the manifest itself could not be read.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const manifest = path.join(root, 'vendor', 'frp', 'SHA256SUMS.txt');

const argv = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const platform = valueOf('--platform', 'all');

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex').toUpperCase();
}

let text;
try {
  text = await fs.readFile(manifest, 'utf8');
} catch (err) {
  console.error('cannot read ' + manifest + ' (' + (err.code ?? err.message) + ')');
  process.exit(2);
}

const all = [];
for (const line of text.split(/\r?\n/)) {
  const match = /^([0-9A-F]{64})\s+(\d+)\s+(\S+)$/.exec(line.trim());
  if (match) all.push({ sha256: match[1], size: Number(match[2]), rel: match[3].replace(/\\/g, '/') });
}
if (!all.length) {
  console.error('no entries found in ' + manifest);
  process.exit(2);
}

const entries = platform === 'all' ? all : all.filter((entry) => path.posix.basename(path.posix.dirname(entry.rel)) === platform);
if (!entries.length) {
  console.error('no manifest entries for platform "' + platform + '" (try: windows-amd64, linux-amd64, all)');
  process.exit(2);
}

const results = [];
for (const entry of entries) {
  const file = path.join(root, entry.rel);
  try {
    const stat = await fs.stat(file);
    const actual = await sha256(file);
    const ok = actual === entry.sha256 && stat.size === entry.size;
    results.push({ ...entry, ok, actual, actualSize: stat.size, status: ok ? 'ok' : 'mismatch' });
  } catch (err) {
    results.push({ ...entry, ok: false, missing: true, status: 'missing', error: err.code ?? err.message });
  }
}

const ok = results.filter((r) => r.status === 'ok').length;
const missing = results.filter((r) => r.status === 'missing').length;
const mismatched = results.filter((r) => r.status === 'mismatch').length;

if (asJson) {
  console.log(JSON.stringify({ ok: mismatched === 0 && (!strict || missing === 0), platform, checked: results.length, verified: ok, missing, mismatched, results }, null, 2));
} else {
  for (const r of results) {
    if (r.status === 'ok') console.log('ok       ' + r.rel + '  (' + r.size + ' bytes, frp v0.71.0)');
    else if (r.status === 'missing') console.log('MISSING  ' + r.rel + '  (not downloaded yet)');
    else console.log('MISMATCH ' + r.rel + '  expected ' + r.sha256 + ' got ' + r.actual);
  }
  console.log('');
  console.log(verified(ok, missing, mismatched, platform));
}

function verified(ok, missing, mismatched, platform) {
  if (mismatched === 0 && missing === 0) return 'all ' + ok + ' vendored frp binaries verified (' + platform + ')';
  if (mismatched > 0) {
    return [
      mismatched + ' file(s) do not match ' + path.relative(root, manifest) + '.',
      'The frp binaries are unsigned: antivirus products sometimes block execution or quarantine',
      'them. Add these paths to your product trust list and restore anything it removed:',
      '  ' + path.join(root, 'vendor', 'frp'),
      '  (and wherever else you keep your frp binaries)',
      'Re-download from https://github.com/fatedier/frp/releases/tag/v0.71.0 and see vendor/README.md.'
    ].join('\n');
  }
  return ok + ' file(s) verified, ' + missing + ' not downloaded yet — see vendor/README.md for the links.';
}

if (mismatched > 0 || (strict && missing > 0)) process.exit(1);
