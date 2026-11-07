# Nayuki QR Code generator (vendored, MIT)

- Upstream: https://www.nayuki.io/page/qr-code-generator-library
- File downloaded: https://www.nayuki.io/res/qr-code-generator-library/qrcodegen.js
- License: MIT (copyright Project Nayuki; the full notice is at the top of `qrcodegen.mjs`)
- Modification: exactly one line appended at the end, `export { qrcodegen };`, so Node 24 ESM can
  import the library without a bundler.

Used by `src/qr.mjs` to turn phone connect codes into QR frames on the hub side (rendered by the
hub Web console canvas; the Android app decodes them with ZXing).
