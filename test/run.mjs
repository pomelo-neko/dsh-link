// Runs every *.test.mjs in one process. (node --test would spawn child processes,
// which some sandboxes deny; importing the test files keeps everything in-process.)
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const dir = new URL('.', import.meta.url);
const files = (await readdir(dir)).filter((name) => name.endsWith('.test.mjs')).sort();
if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}
console.log(`running ${files.length} test file(s): ${files.join(', ')}\n`);
for (const file of files) {
  await import(pathToFileURL(new URL(file, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href);
}

