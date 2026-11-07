// dsh-link QR frames (0.10.2)
//
// Phone connect codes are ~7 KB (dshlink2 includes the hub CA and, with a tunnel, an frpc
// configuration plus client certificates), which is far beyond a single QR symbol. We therefore
// split the code into N ASCII chunks and paint one QR per chunk, as one text frame:
//
//     dshlinkqr:<index>/<total>:<chunk>
//
// index is 1-based; concatenating chunk in index order reconstructs the original code exactly.
// The frames are transport only: decode, reassemble, then run the normal ConnectProfile validation
// (and one-time bootstrap exchange) on the phone.
import { qrcodegen } from '../vendor/qrcodegen/qrcodegen.mjs';

export const QR_FRAME_PREFIX = 'dshlinkqr';
export const QR_FRAME_RE = /^dshlinkqr:([0-9]+)\/([0-9]+):([\s\S]*)$/;
export const QR_CHUNK_DEFAULT = 900;
export const QR_CHUNK_MIN = 200;
export const QR_CHUNK_MAX = 2400;
export const QR_MAX_FRAMES = 32;
export const QR_CODE_MIN = 16;
export const QR_CODE_MAX = 100000;
const QR_CHUNK_HARD_MAX = 4096;
const CONNECT_PREFIXES = ['dshlink1:', 'dshlink2:'];

export function validateConnectCode(code) {
  if (typeof code !== 'string') return { ok: false, error: 'code must be a string' };
  if (code.length < QR_CODE_MIN) return { ok: false, error: 'code is shorter than ' + QR_CODE_MIN + ' characters' };
  if (code.length > QR_CODE_MAX) return { ok: false, error: 'code is longer than ' + QR_CODE_MAX + ' characters' };
  if (!/^[\x20-\x7E]+$/.test(code)) return { ok: false, error: 'code must be printable ASCII' };
  if (!CONNECT_PREFIXES.some((prefix) => code.startsWith(prefix))) {
    return { ok: false, error: 'code must start with dshlink1: or dshlink2:' };
  }
  return { ok: true };
}

export function normalizeChunkSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return QR_CHUNK_DEFAULT;
  return Math.max(QR_CHUNK_MIN, Math.min(QR_CHUNK_MAX, Math.floor(number)));
}

export function frameCount(codeLength, chunkSize) {
  const size = normalizeChunkSize(chunkSize);
  return Math.max(1, Math.ceil(Math.max(0, Number(codeLength) || 0) / size));
}

export function buildFrameText(index, total, chunk) {
  return QR_FRAME_PREFIX + ':' + index + '/' + total + ':' + chunk;
}

export function splitCode(code, chunkSize) {
  const size = normalizeChunkSize(chunkSize);
  const chunks = [];
  for (let offset = 0; offset < code.length; offset += size) chunks.push(code.slice(offset, offset + size));
  return chunks;
}

export function parseFrameText(text) {
  if (typeof text !== 'string') return null;
  const match = QR_FRAME_RE.exec(text.trim());
  if (!match) return null;
  const index = Number(match[1]);
  const total = Number(match[2]);
  const chunk = match[3];
  if (!Number.isInteger(index) || !Number.isInteger(total)) return null;
  if (total < 1 || total > QR_MAX_FRAMES) return null;
  if (index < 1 || index > total) return null;
  if (!chunk.length || chunk.length > QR_CHUNK_HARD_MAX) return null;
  return { index, total, chunk };
}

export function assembleFrames(texts) {
  const parts = new Map();
  let total = 0;
  let invalid = 0;
  for (const text of texts || []) {
    const frame = parseFrameText(text);
    if (!frame) {
      invalid += 1;
      continue;
    }
    if (total === 0) {
      total = frame.total;
    } else if (frame.total !== total) {
      // A different animation started: restart with the new frame set.
      parts.clear();
      total = frame.total;
    }
    parts.set(frame.index, frame.chunk);
  }
  if (!total) {
    return { ok: false, total: 0, received: 0, missing: [], code: null, invalid, error: 'no QR frames were recognized' };
  }
  const missing = [];
  for (let index = 1; index <= total; index += 1) if (!parts.has(index)) missing.push(index);
  const code = missing.length ? null : Array.from({ length: total }, (_, i) => parts.get(i + 1)).join('');
  return {
    ok: missing.length === 0,
    total,
    received: parts.size,
    missing,
    code,
    invalid,
    error: missing.length ? 'missing frames: ' + missing.join(',') : null
  };
}

export function encodeQrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  const segment = qrcodegen.QrSegment.makeBytes([...bytes]);
  const qr = qrcodegen.QrCode.encodeSegments([segment], qrcodegen.QrCode.Ecc.LOW, 1, 40, -1, true);
  const rows = [];
  for (let y = 0; y < qr.size; y += 1) {
    let row = '';
    for (let x = 0; x < qr.size; x += 1) row += qr.getModule(x, y) ? '1' : '0';
    rows.push(row);
  }
  return { size: qr.size, rows };
}

// Turn a complete connect code into one QR matrix per frame. Pure function: no I/O, no logging.
export function encodeFrames(code, options = {}) {
  const check = validateConnectCode(code);
  if (!check.ok) {
    const error = new Error(check.error);
    error.code = 'bad_connect_code';
    throw error;
  }
  const chunkSize = normalizeChunkSize(options.chunkSize);
  const chunks = splitCode(code, chunkSize);
  if (chunks.length > QR_MAX_FRAMES) {
    const error = new Error('code needs ' + chunks.length + ' frames, more than the ' + QR_MAX_FRAMES + '-frame limit');
    error.code = 'too_many_frames';
    throw error;
  }
  const frames = chunks.map((chunk, offset) => {
    const index = offset + 1;
    const payload = buildFrameText(index, chunks.length, chunk);
    const matrix = encodeQrMatrix(payload);
    return { index, total: chunks.length, payload, chunkLength: chunk.length, size: matrix.size, rows: matrix.rows };
  });
  return { codeBytes: code.length, total: chunks.length, chunkSize, frames };
}
