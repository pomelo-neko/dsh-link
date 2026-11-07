// Minimal PNG writer (grayscale 8-bit) for QR frame images.
//
// Zero dependencies: tests and scripts need real PNG files so ZXing can decode them; pulling an
// image library in for 40 lines of zlib + CRC would be silly.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

// rows: array of '0'/'1' strings (all the same length, square). margin/scale are in modules.
export function matrixToPng(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('rows must be a non-empty array');
  const size = rows.length;
  if (rows.some((row) => typeof row !== 'string' || row.length !== size)) throw new Error('rows must be square strings of 0/1');
  const scale = Math.max(1, Math.floor(Number(options.scale) || 8));
  const margin = Math.max(0, Math.floor(options.margin ?? 4));
  const pixels = (size + margin * 2) * scale;
  const raw = Buffer.alloc((pixels + 1) * pixels);
  for (let y = 0; y < pixels; y += 1) {
    const rowStart = y * (pixels + 1);
    raw[rowStart] = 0; // filter type: none
    const moduleY = Math.floor(y / scale) - margin;
    for (let x = 0; x < pixels; x += 1) {
      const moduleX = Math.floor(x / scale) - margin;
      const inside = moduleY >= 0 && moduleY < size && moduleX >= 0 && moduleX < size;
      const black = inside && rows[moduleY][moduleX] === '1';
      raw[rowStart + 1 + x] = black ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pixels, 0);
  ihdr.writeUInt32BE(pixels, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
