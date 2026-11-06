// dsh-link 0.10 (B2): the local certificate authority for phone controllers.
//
// The hub gateway terminates TLS and asks every phone for a client certificate. The phone has no
// way to trust a certificate it receives over the very connection that certificate is supposed to
// protect, so the first connection is bootstrapped differently: the connect code pins this CA and
// carries a one-time secret. The phone then generates its keypair locally, sends only the public
// key, and receives a client certificate signed by this CA. Every later connection is ordinary
// mutual TLS: both sides verify a certificate issued by the same local CA, and the hub can revoke
// one device by fingerprint without touching any other phone.
import { spawn, spawnSync } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LinkError } from './util.mjs';

export const PHONE_CA_DIRNAME = 'phone-ca';
export const PHONE_CA_CERT = 'ca.crt';
export const PHONE_CA_KEY = 'ca.key';
export const PHONE_SERVER_CERT = 'server.crt';
export const PHONE_SERVER_KEY = 'server.key';
export const PHONE_CA_DAYS = 3650;
export const PHONE_SERVER_DAYS = 825;
export const PHONE_DEVICE_DAYS = 365;

const WINDOWS_OPENSSL = [
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe'
];

// Git for Windows is the most common way OpenSSL reaches a Windows box, and it is not
// necessarily installed on C:. Derive its location from the git.exe that is on PATH.
function gitOpensslCandidates() {
  if (process.platform !== 'win32') return [];
  const found = [];
  try {
    const which = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const gitExe = String(which.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (gitExe) {
      const root = path.dirname(path.dirname(gitExe));
      found.push(path.join(root, 'usr', 'bin', 'openssl.exe'));
      found.push(path.join(root, 'mingw64', 'bin', 'openssl.exe'));
    }
  } catch { /* fall through to the static list */ }
  return found;
}

/** Find an OpenSSL executable. The phone CA only needs the CLI during setup/enrollment. */
export function findOpenssl(explicit = null) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DSHLINK_OPENSSL) candidates.push(process.env.DSHLINK_OPENSSL);
  candidates.push('openssl');
  if (process.platform === 'win32') candidates.push(...WINDOWS_OPENSSL, ...gitOpensslCandidates());
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function run(exe, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new LinkError(500, 'openssl_failed', 'openssl ' + args[0] + ' failed (' + code + '): ' + (stderr.trim() || stdout.trim()).slice(0, 500)));
    });
  });
}

function extFile(lines) {
  return lines.join('\n') + '\n';
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** The CA + gateway server certificate stored under <hub dataDir>/phone-ca. */
export class PhoneCA {
  constructor({ dir, opensslPath = null, log = null } = {}) {
    if (!dir) throw new LinkError(500, 'phone_ca_missing_dir', 'the phone CA needs a directory');
    this.dir = path.resolve(dir);
    this.explicitOpenssl = opensslPath;
    this.log = log;
    this.openssl = null;
    this.caCert = null;
    this.caKeyPath = path.join(this.dir, PHONE_CA_KEY);
    this.caCertPath = path.join(this.dir, PHONE_CA_CERT);
    this.serverCertPath = path.join(this.dir, PHONE_SERVER_CERT);
    this.serverKeyPath = path.join(this.dir, PHONE_SERVER_KEY);
    this._ca = null;
    this._server = null;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    this.openssl = findOpenssl(this.explicitOpenssl);
    if (!this.openssl) {
      throw new LinkError(3, 'openssl_missing', 'openssl was not found; install OpenSSL or set phoneGateway.opensslPath / DSHLINK_OPENSSL');
    }
    if (!(await exists(this.caCertPath)) || !(await exists(this.caKeyPath))) {
      await this._createCa();
    }
    if (!(await exists(this.serverCertPath)) || !(await exists(this.serverKeyPath))) {
      await this._createServerCert();
    }
    this.caCert = await fs.readFile(this.caCertPath, 'utf8');
    this._ca = new X509Certificate(this.caCert);
    this._server = {
      cert: await fs.readFile(this.serverCertPath, 'utf8'),
      key: await fs.readFile(this.serverKeyPath, 'utf8')
    };
    return this;
  }

  async _createCa() {
    const args = [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(PHONE_CA_DAYS), '-nodes',
      '-keyout', this.caKeyPath, '-out', this.caCertPath,
      '-subj', '/CN=dsh-link phone CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign'
    ];
    await run(this.openssl, args);
    this.log?.info?.('dsh-link phone CA created at ' + this.caCertPath);
  }

  async _createServerCert() {
    const csr = path.join(this.dir, 'server.csr');
    const ext = path.join(this.dir, 'server.ext');
    await run(this.openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', this.serverKeyPath, '-out', csr, '-subj', '/CN=dsh-link phone gateway']);
    await fs.writeFile(ext, extFile(['subjectAltName=IP:127.0.0.1,DNS:localhost', 'extendedKeyUsage=serverAuth']), 'utf8');
    await run(this.openssl, [
      'x509', '-req', '-in', csr, '-CA', this.caCertPath, '-CAkey', this.caKeyPath, '-CAcreateserial',
      '-out', this.serverCertPath, '-days', String(PHONE_SERVER_DAYS), '-sha256', '-extfile', ext
    ]);
    await fs.rm(csr, { force: true });
    await fs.rm(ext, { force: true });
    this.log?.info?.('dsh-link phone gateway certificate created at ' + this.serverCertPath);
  }

  serverTls() {
    if (!this._server) throw new LinkError(500, 'phone_ca_not_initialized', 'the phone CA has not been initialized');
    return { cert: this._server.cert, key: this._server.key, ca: this.caCert };
  }

  caPem() {
    if (!this.caCert) throw new LinkError(500, 'phone_ca_not_initialized', 'the phone CA has not been initialized');
    return this.caCert;
  }

  caFingerprint() {
    return this._ca ? this._ca.fingerprint256 : null;
  }

  /**
   * Sign a client certificate for a phone-supplied public key. The private key never leaves the
   * phone, so a stolen hub backup cannot impersonate a phone and a leaked phone cannot sign for
   * another phone.
   */
  async issueDevice({ publicKeyPem, deviceId, label = 'phone', days = PHONE_DEVICE_DAYS } = {}) {
    if (!this._ca) throw new LinkError(500, 'phone_ca_not_initialized', 'the phone CA has not been initialized');
    let normalized;
    try {
      normalized = createPublicKey(String(publicKeyPem ?? '')).export({ type: 'spki', format: 'pem' });
    } catch {
      throw new LinkError(400, 'bad_public_key', 'the device public key is not a valid PEM public key');
    }
    const id = String(deviceId ?? '').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'device';
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dshlink-phone-device-'));
    try {
      const pub = path.join(tmp, 'device.pub');
      const csr = path.join(tmp, 'device.csr');
      const ext = path.join(tmp, 'device.ext');
      const cert = path.join(tmp, 'device.crt');
      await fs.writeFile(pub, normalized, 'utf8');
      // The CSR only carries the subject; -force_pubkey replaces its key with the phone's public
      // key, so the CA never sees (and never needs) the device private key.
      await run(this.openssl, ['req', '-new', '-key', this.serverKeyPath, '-out', csr, '-subj', '/CN=' + id]);
      await fs.writeFile(ext, extFile([
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=clientAuth',
        'subjectAltName=DNS:' + id
      ]), 'utf8');
      await run(this.openssl, [
        'x509', '-req', '-in', csr, '-CA', this.caCertPath, '-CAkey', this.caKeyPath, '-CAcreateserial',
        '-out', cert, '-days', String(Math.max(1, Math.min(3650, Number(days) || PHONE_DEVICE_DAYS))),
        '-sha256', '-extfile', ext, '-force_pubkey', pub
      ]);
      const pem = await fs.readFile(cert, 'utf8');
      const parsed = new X509Certificate(pem);
      return {
        certPem: pem,
        fingerprint: parsed.fingerprint256,
        serialNumber: parsed.serialNumber,
        validFrom: parsed.validFrom,
        validTo: parsed.validTo,
        label: String(label).slice(0, 64),
        publicKeyPem: normalized
      };
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  /** Verify a peer certificate against this CA and its validity window. */
  verifyClientCertificate(pem) {
    if (!this._ca) return { ok: false, reason: 'the phone CA has not been initialized' };
    let cert;
    try { cert = new X509Certificate(String(pem ?? '')); } catch { return { ok: false, reason: 'client certificate is not valid PEM' }; }
    const now = Date.now();
    if (Date.parse(cert.validFrom) > now) return { ok: false, reason: 'client certificate is not valid yet', fingerprint: cert.fingerprint256 };
    if (Date.parse(cert.validTo) < now) return { ok: false, reason: 'client certificate expired', fingerprint: cert.fingerprint256 };
    let chainOk = false;
    try { chainOk = cert.checkIssued(this._ca) && cert.verify(this._ca.publicKey); } catch { chainOk = false; }
    if (!chainOk) return { ok: false, reason: 'client certificate is not issued by this hub CA', fingerprint: cert.fingerprint256 };
    const usages = Array.isArray(cert.keyUsage) ? cert.keyUsage : [];
    if (usages.length && !usages.includes('1.3.6.1.5.5.7.3.2')) {
      return { ok: false, reason: 'client certificate is not valid for client authentication', fingerprint: cert.fingerprint256 };
    }
    return { ok: true, fingerprint: cert.fingerprint256, subject: cert.subject, validTo: cert.validTo };
  }
}

export async function openPhoneCA({ dir, opensslPath = null, log = null } = {}) {
  const ca = new PhoneCA({ dir, opensslPath, log });
  return ca.init();
}
