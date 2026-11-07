# ZXing core (vendored for the Android control app)

- Version: 3.5.3
- Artifact: com.google.zxing:core:3.5.3
- Source: https://repo1.maven.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar
- SHA-256: 8D8064C1636FDAEF7189DD9055C7D59950A8940A12F2293956446EC3C109FD82
- License: Apache-2.0 (see LICENSE in this directory)
- Vendored: file copied byte-for-byte; no modifications.

Used by:

- `android/build-apk.ps1` — added to javac classpath and d8 input so the control app can decode QR codes from the camera (ScanActivity) and from picked images (QrImages).
- `test/qr.test.mjs` — the Node test compiles a tiny Java decoder against this jar to prove the
  generated QR frames really decode (end-to-end roundtrip without any npm dependency).

The jar is not packaged as an asset; d8 merges its classes into classes.dex.
