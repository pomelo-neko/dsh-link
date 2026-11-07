#!/usr/bin/env node
// Render a dsh-link connect code as multi-frame QR PNGs.
//
//   node scripts/qrgen.mjs --code-file phone-invite.txt --out-dir test/.tmp/qr-frames
//   node scripts/qrgen.mjs --code "$(cat code.txt)" --out-dir frames --chunk 600 --scale 6
//   cat code.txt | node scripts/qrgen.mjs --out-dir frames
//
// Writes frame-01.png ... frame-NN.png plus manifest.json. Used by the Android image-import
// end-to-end test, by docs screenshots, and to inspect a code offline.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { encodeFrames } from '../src/qr.mjs';
import { matrixToPng } from './lib/png.mjs';

const argv = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flagNumber = (flag, fallback) => {
  const raw = valueOf(flag, null);
  if (raw == null) return fallback;
  const number = Number(raw);
  return Number.isFinite(number) ? number : fallback;
};
const asJson = argv.includes('--json');

function usage() {
  console.log('usage: node scripts/qrgen.mjs [--code <text> | --code-file <path> | stdin] [--out-dir <dir>]');
  console.log('       [--chunk 900] [--scale 8] [--margin 4] [--json]');
}

function cleanCode(raw) {
  return String(raw).replace(/^\uFEFF/, '').replace(/\s+/g, '');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }
  const outDir = path.resolve(valueOf('--out-dir', 'qr-frames'));
  const chunkSize = flagNumber('--chunk', 900);
  const scale = flagNumber('--scale', 8);
  const margin = flagNumber('--margin', 4);
  let raw = valueOf('--code', null);
  if (raw == null) {
    const file = valueOf('--code-file', null);
    if (file) raw = await fs.readFile(file, 'utf8');
    else raw = await readStdin();
  }
  const code = cleanCode(raw);
  const encoded = encodeFrames(code, { chunkSize });
  await fs.mkdir(outDir, { recursive: true });
  const frames = [];
  for (const frame of encoded.frames) {
    const name = 'frame-' + String(frame.index).padStart(2, '0') + '.png';
    const png = matrixToPng(frame.rows, { scale, margin });
    const file = path.join(outDir, name);
    await fs.writeFile(file, png);
    frames.push({
      index: frame.index,
      total: frame.total,
      file: name,
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex').toUpperCase(),
      qrSize: frame.size,
      payloadLength: frame.payload.length,
      payload: frame.payload
    });
  }
  const manifest = {
    format: 'dshlink-qr-frames',
    version: 1,
    codeBytes: encoded.codeBytes,
    total: encoded.total,
    chunkSize: encoded.chunkSize,
    scale,
    margin,
    frames
  };
  const manifestFile = path.join(outDir, 'manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  if (asJson) {
    console.log(JSON.stringify({ outDir, manifest: manifestFile, total: encoded.total, chunkSize: encoded.chunkSize, frames: frames.map((f) => ({ index: f.index, file: f.file, bytes: f.bytes, qrSize: f.qrSize })) }, null, 2));
  } else {
    console.log('code: ' + encoded.codeBytes + ' bytes -> ' + encoded.total + ' frame(s), chunk ' + encoded.chunkSize);
    for (const frame of frames) console.log('  ' + frame.file + '  qr ' + frame.qrSize + 'x' + frame.qrSize + '  ' + frame.bytes + ' bytes');
    console.log('manifest: ' + manifestFile);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error('qrgen failed: ' + (error && error.message ? error.message : error));
  process.exit(2);
});
