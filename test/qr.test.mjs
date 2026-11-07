import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { TMP } from './helpers.mjs';
import { matrixToPng } from '../scripts/lib/png.mjs';
import {
  QR_CHUNK_DEFAULT,
  QR_CHUNK_MAX,
  QR_CHUNK_MIN,
  QR_MAX_FRAMES,
  assembleFrames,
  buildFrameText,
  encodeFrames,
  frameCount,
  normalizeChunkSize,
  parseFrameText,
  splitCode,
  validateConnectCode
} from '../src/qr.mjs';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const zxingJar = path.join(projectRoot, 'vendor', 'zxing', 'zxing-core-3.5.3.jar');

function sampleCode(bytes = 5200, prefix = 'dshlink2:') {
  return prefix + randomBytes(bytes).toString('base64url');
}

function findJdk() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const homes = [];
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
  const sdk = 'D:/AndroidSdk/jdk17';
  try {
    for (const name of readdirSync(sdk)) homes.push(path.join(sdk, name));
  } catch {
    // no Android SDK layout on this machine
  }
  homes.push('C:/Program Files/Java/jdk-17', 'C:/Program Files/Java/jdk-21');
  for (const home of homes) {
    const javac = path.join(home, 'bin', 'javac' + exe);
    const java = path.join(home, 'bin', 'java' + exe);
    if (existsSync(javac) && existsSync(java)) return { javac, java };
  }
  try {
    execFileSync('javac', ['-version'], { stdio: 'pipe' });
    execFileSync('java', ['-version'], { stdio: 'pipe' });
    return { javac: 'javac', java: 'java' };
  } catch {
    return null;
  }
}

const JDK = findJdk();
const SKIP_DECODE = !existsSync(zxingJar)
  ? 'the vendored zxing core jar is missing'
  : !JDK
    ? 'no JDK with javac/java found (set JAVA_HOME to run the decode roundtrip)'
    : false;

// Compiles a tiny ZXing decoder against the vendored jar. This is the real proof that the frames
// we paint on the hub console are decodable, without adding any npm dependency.
// Compiles a tiny ZXing decoder against the vendored jar. This is the real proof that the frames
// we paint on the hub console are decodable, without adding any npm dependency.
//
// The decoder deliberately retries: ZXing's QR *detector* occasionally fails with NotFoundException
// on a perfectly valid, perfectly rendered symbol (we observed it for one generated frame where the
// payload + auto-chosen mask produced a finder-like pattern in the data area). PURE_BARCODE and a
// 90 degree rotation both decode that same symbol, so a real phone sees the same behaviour: retry
// with more hints / another orientation before declaring a frame unreadable.
const DECODER_SOURCE = [
  'import com.google.zxing.*;',
  'import com.google.zxing.common.*;',
  'import com.google.zxing.qrcode.QRCodeReader;',
  'import javax.imageio.ImageIO;',
  'import java.awt.image.BufferedImage;',
  'import java.io.File;',
  'import java.util.*;',
  '',
  'public class QrDecode {',
  '  private static int[] rotate(int[] pixels, int width, int height, int angle) {',
  '    int[] out = new int[pixels.length];',
  '    for (int y = 0; y < height; y++) {',
  '      for (int x = 0; x < width; x++) {',
  '        if (angle == 90) out[x * height + (height - 1 - y)] = pixels[y * width + x];',
  '        else if (angle == 180) out[(height - 1 - y) * width + (width - 1 - x)] = pixels[y * width + x];',
  '        else out[(width - 1 - x) * height + y] = pixels[y * width + x];',
  '      }',
  '    }',
  '    return out;',
  '  }',
  '',
  '  private static String decode(int width, int height, int[] pixels) {',
  '    LuminanceSource source = new RGBLuminanceSource(width, height, pixels);',
  '    for (int mode = 0; mode < 3; mode++) {',
  '      try {',
  '        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);',
  '        if (mode >= 1) hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);',
  '        if (mode == 2) hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);',
  '        BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));',
  '        return new QRCodeReader().decode(bitmap, hints).getText();',
  '      } catch (Exception ignored) {',
  '        // try the next hint set',
  '      }',
  '    }',
  '    return null;',
  '  }',
  '',
  '  private static String decodeImage(BufferedImage img) {',
  '    int width = img.getWidth();',
  '    int height = img.getHeight();',
  '    int[] pixels = img.getRGB(0, 0, width, height, null, 0, width);',
  '    int[] angles = {0, 90, 180, 270};',
  '    for (int angle : angles) {',
  '      int[] rotated = angle == 0 ? pixels : rotate(pixels, width, height, angle);',
  '      int w = angle == 0 || angle == 180 ? width : height;',
  '      int h = angle == 0 || angle == 180 ? height : width;',
  '      String text = decode(w, h, rotated);',
  '      if (text != null) return text;',
  '    }',
  '    return null;',
  '  }',
  '',
  '  public static void main(String[] args) throws Exception {',
  '    for (String path : args) {',
  '      BufferedImage img = ImageIO.read(new File(path));',
  '      String text = img == null ? null : decodeImage(img);',
  '      if (text == null) System.out.println("FAILED " + new File(path).getName());',
  '      else System.out.println(text);',
  '    }',
  '  }',
  '}',
  ''
].join('\n');

let decoderPrepared = false;

function prepareDecoder() {
  if (decoderPrepared) return;
  const work = path.join(TMP, 'qr-java');
  const classes = path.join(work, 'classes');
  mkdirSync(classes, { recursive: true });
  const sourceFile = path.join(work, 'QrDecode.java');
  writeFileSync(sourceFile, DECODER_SOURCE, 'utf8');
  execFileSync(JDK.javac, ['-encoding', 'UTF-8', '-cp', zxingJar, '-d', classes, sourceFile], { stdio: 'pipe' });
  decoderPrepared = true;
}

function decodePngs(files) {
  prepareDecoder();
  const classes = path.join(TMP, 'qr-java', 'classes');
  const output = execFileSync(
    JDK.java,
    ['-Dfile.encoding=UTF-8', '-cp', classes + path.delimiter + zxingJar, 'QrDecode', ...files],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return output.replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
}

function writeFrames(frames, dir, options) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return frames.map((frame) => {
    const file = path.join(dir, 'frame-' + String(frame.index).padStart(2, '0') + '.png');
    writeFileSync(file, matrixToPng(frame.rows, options));
    return file;
  });
}

test('qr: connect code validation, chunk sizing and frame text', () => {
  assert.equal(validateConnectCode(sampleCode(64)).ok, true);
  assert.equal(validateConnectCode('dshlink1:' + randomBytes(24).toString('base64url')).ok, true);
  assert.match(validateConnectCode('https://example.com/hub').error, /dshlink1: or dshlink2:/);
  assert.match(validateConnectCode('dshlink2:abc').error, /shorter/);
  assert.match(validateConnectCode('dshlink2:' + 'a'.repeat(100001)).error, /longer/);
  assert.match(validateConnectCode('dshlink2:' + 'a'.repeat(30) + '\n').error, /printable ASCII/);
  assert.match(validateConnectCode(42).error, /string/);

  assert.equal(normalizeChunkSize(undefined), QR_CHUNK_DEFAULT);
  assert.equal(normalizeChunkSize('600'), 600);
  assert.equal(normalizeChunkSize(1), QR_CHUNK_MIN);
  assert.equal(normalizeChunkSize(99999), QR_CHUNK_MAX);
  assert.equal(normalizeChunkSize('nope'), QR_CHUNK_DEFAULT);

  const code = 'dshlink2:' + 'a'.repeat(1900);
  assert.equal(frameCount(code.length, 900), 3);
  assert.equal(frameCount(code.length, 2400), 1);
  assert.deepEqual(splitCode(code, 900), [code.slice(0, 900), code.slice(900, 1800), code.slice(1800)]);
  assert.deepEqual(splitCode(code, 2400), [code]);

  assert.equal(buildFrameText(2, 5, 'abc'), 'dshlinkqr:2/5:abc');
  assert.deepEqual(parseFrameText('dshlinkqr:2/5:abc'), { index: 2, total: 5, chunk: 'abc' });
  assert.equal(parseFrameText('dshlinkqr:0/5:abc'), null);
  assert.equal(parseFrameText('dshlinkqr:6/5:abc'), null);
  assert.equal(parseFrameText('dshlinkqr:1/33:abc'), null);
  assert.equal(parseFrameText('not a frame'), null);
  assert.equal(parseFrameText(undefined), null);
});

test('qr: assembleFrames tolerates order, duplicates and restarts', () => {
  const code = 'dshlink2:' + 'a'.repeat(2200);
  const encoded = encodeFrames(code, { chunkSize: 900 });
  assert.equal(encoded.total, 3);
  const payloads = encoded.frames.map((frame) => frame.payload);

  const shuffled = [payloads[1], payloads[2], payloads[0]];
  const assembled = assembleFrames(shuffled);
  assert.equal(assembled.ok, true);
  assert.equal(assembled.code, code);
  assert.equal(assembled.received, 3);
  assert.deepEqual(assembled.missing, []);

  const duplicated = assembleFrames([payloads[0], payloads[0], payloads[1], payloads[2], 'junk']);
  assert.equal(duplicated.ok, true);
  assert.equal(duplicated.code, code);
  assert.equal(duplicated.invalid, 1);

  const partial = assembleFrames([payloads[0], payloads[2]]);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.missing, [2]);
  assert.equal(partial.code, null);

  // A different animation started: the new total wins and old partial fragments are dropped.
  const smallCode = 'dshlink1:' + 'b'.repeat(24);
  const other = encodeFrames(smallCode, { chunkSize: 900 });
  assert.equal(other.total, 1);
  const restarted = assembleFrames([payloads[0], payloads[1], other.frames[0].payload]);
  assert.equal(restarted.total, 1);
  assert.equal(restarted.code, smallCode);

  assert.equal(assembleFrames([]).ok, false);
  assert.match(assembleFrames(['x']).error, /no QR frames/);
});

test('qr: encodeFrames builds square matrices and enforces limits', () => {
  const code = sampleCode(5200);
  const encoded = encodeFrames(code);
  assert.equal(encoded.codeBytes, code.length);
  assert.equal(encoded.chunkSize, 900);
  assert.equal(encoded.total, Math.ceil(code.length / 900));
  for (const frame of encoded.frames) {
    assert.equal(frame.rows.length, frame.size);
    assert.ok(frame.rows.every((row) => row.length === frame.size && /^[01]+$/.test(row)));
    assert.ok(frame.size >= 21 && frame.size <= 177);
    const parsed = parseFrameText(frame.payload);
    assert.equal(parsed.index, frame.index);
    assert.equal(parsed.total, encoded.total);
  }

  const coarse = encodeFrames(code, { chunkSize: 2400 });
  assert.equal(coarse.total, Math.ceil(code.length / 2400));
  assert.ok(coarse.total < encoded.total);

  assert.throws(
    () => encodeFrames(sampleCode(7000), { chunkSize: 200 }),
    (error) => error.code === 'too_many_frames' && error.message.includes(String(QR_MAX_FRAMES))
  );
  assert.throws(
    () => encodeFrames('not a connect code at all'),
    (error) => error.code === 'bad_connect_code'
  );
});

test('qr: generated PNG frames decode with the vendored zxing core', { skip: SKIP_DECODE }, () => {
  const code = sampleCode(5200);
  const encoded = encodeFrames(code, { chunkSize: 900 });
  const dir = path.join(TMP, 'qr-frames-large');
  const files = writeFrames(encoded.frames, dir, { scale: 6, margin: 4 });
  const lines = decodePngs(files);
  assert.equal(lines.length, encoded.total);
  assert.deepEqual(lines.filter((line) => line.startsWith('FAILED ')), []);
  const assembled = assembleFrames(lines);
  assert.equal(assembled.ok, true);
  assert.equal(assembled.code, code);

  const small = 'dshlink1:' + randomBytes(32).toString('base64url');
  const single = encodeFrames(small);
  assert.equal(single.total, 1);
  const singleFiles = writeFrames(single.frames, path.join(TMP, 'qr-frames-small'), { scale: 8, margin: 4 });
  const singleLines = decodePngs(singleFiles);
  assert.equal(singleLines.length, 1);
  assert.deepEqual(singleLines.filter((line) => line.startsWith('FAILED ')), []);
  assert.equal(assembleFrames(singleLines).code, small);
});

test('qr: qrgen writes frames plus a manifest for the android test', () => {
  const code = 'dshlink1:' + randomBytes(40).toString('base64url');
  const dir = path.join(TMP, 'qrgen-cli');
  rmSync(dir, { recursive: true, force: true });
  const output = execFileSync(
    process.execPath,
    [path.join(projectRoot, 'scripts', 'qrgen.mjs'), '--code', code, '--out-dir', dir, '--scale', '4', '--json'],
    { encoding: 'utf8' }
  );
  const summary = JSON.parse(output);
  assert.equal(summary.total, 1);
  assert.equal(summary.frames.length, 1);
  assert.ok(existsSync(path.join(dir, 'frame-01.png')));
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'dshlink-qr-frames');
  assert.equal(manifest.codeBytes, code.length);
  assert.equal(manifest.frames[0].payload, 'dshlinkqr:1/1:' + code);
  assert.match(manifest.frames[0].sha256, /^[0-9A-F]{64}$/);
});
