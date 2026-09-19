// Windows PowerShell 5.1 reads .ps1 files as ANSI unless they start with a UTF-8 BOM,
// which corrupts non-ASCII text (and can break quoting). Run this after writing any .ps1:
//   node scripts/ensure-bom.mjs                 # scans scripts/, packaging/, test/
//   node scripts/ensure-bom.mjs <file.ps1> ...  # or just the files you touched
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SCAN_DIRS = ['scripts', 'packaging', 'test', 'integrations'];
const SKIP = /(^|\\)(dist|node_modules|.tmp)(\\|$)/;

async function collect(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) out.push(...await collect(full));
    else if (entry.name.toLowerCase().endsWith('.ps1')) out.push(full);
  }
  return out;
}

let files = process.argv.slice(2);
if (!files.length) {
  const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  files = (await Promise.all(SCAN_DIRS.map((name) => collect(path.join(root, name))))).flat().sort();
  console.log(`scanning ${files.length} .ps1 file(s)`);
}

let changed = 0;
for (const file of files) {
  const text = await fs.readFile(file, 'utf8');
  if (text.startsWith('\uFEFF')) {
    console.log('already has BOM: ' + path.relative(process.cwd(), file));
    continue;
  }
  await fs.writeFile(file, '\uFEFF' + text, 'utf8');
  changed += 1;
  console.log('BOM added: ' + path.relative(process.cwd(), file));
}
console.log(changed + ' file(s) updated');