// Generate the secrets a dsh-link deployment needs — without openssl, without dependencies.
//
//   frp auth.token        shared by frps and every frpc (what "openssl rand -hex 32" produces)
//   STCP secretKey        per node; the real boundary of an STCP proxy (see docs/FRP.md)
//   dsh-link inbound token  what you hand to one peer; your config stores only its sha256
//   dashboard password    optional, for the frps webServer (keep it on loopback anyway)
//
//   node scripts/gen-secrets.mjs                  # one set, with ready-to-paste snippets
//   node scripts/gen-secrets.mjs --count 3        # three sets (one per machine)
//   node scripts/gen-secrets.mjs --name alice-pc  # label the snippets
//   node scripts/gen-secrets.mjs --json           # machine-readable
//
// Rotate both ends at the same time: `peers[].token` is the token the OTHER side issued to you,
// so changing one side alone turns every cross-machine call into a 401 (docs/OPERATIONS.md §5).
import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const count = Math.max(1, Math.min(50, Number(valueOf('--count', '1')) || 1));
const nameArg = valueOf('--name', null);
const asJson = has('--json');

// Same shapes the product uses: randomToken() in src/util.mjs is base64url of 32 bytes, and
// frp's documented token format is 32 random bytes as hex.
const hexToken = () => randomBytes(32).toString('hex');
const urlToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const sets = [];
for (let i = 0; i < count; i += 1) {
  const name = count === 1
    ? (nameArg ?? 'this-node')
    : (nameArg ? nameArg + '-' + (i + 1) : 'node-' + (i + 1));
  const dshlinkToken = urlToken(32);
  sets.push({
    name,
    frpToken: hexToken(),
    stcpSecretKey: urlToken(32),
    dashboardPassword: urlToken(18),
    dshlinkToken,
    dshlinkTokenSha256: sha256(dshlinkToken)
  });
}

if (asJson) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), note: 'secrets — do not commit', sets }, null, 2));
} else {
  console.log('dsh-link secret generator — treat everything below as a credential.');
  console.log('Do not paste it into a repository, a shared folder, or a chat log.\n');
  for (const set of sets) {
    console.log('=== ' + set.name + ' ===');
    console.log('  frp auth.token          ' + set.frpToken);
    console.log('  stcp secretKey          ' + set.stcpSecretKey);
    console.log('  dshlink inbound token   ' + set.dshlinkToken);
    console.log('    sha256 (config value) ' + set.dshlinkTokenSha256);
    console.log('  dashboard password      ' + set.dashboardPassword);
    console.log('');
    console.log('  # frps.toml (the public relay)');
    console.log('  auth.method = "token"');
    console.log('  auth.token = "' + set.frpToken + '"');
    console.log('  webServer.user = "admin"');
    console.log('  webServer.password = "' + set.dashboardPassword + '"');
    console.log('');
    console.log('  # this machine');
    console.log('  node bin/dshlink.mjs tunnel setup --server <frps-host> --port 7000 --token "' + set.frpToken + '"');
    console.log('  #   dshlink.config.json -> "stcp": { "proxyName": "dshlink-' + set.name + '", "secretKey": "' + set.stcpSecretKey + '" }');
    console.log('  #   dshlink.config.json -> "auth": { "tokens": [ { "id": "tok_' + set.name + '", "label": "<peer>",');
    console.log('  #                                          "hash": "' + set.dshlinkTokenSha256 + '" } ] }');
    console.log('  # Giving a peer this token by hand is equivalent to:');
    console.log('  #   node bin/dshlink.mjs token new --label <peer>     (prints the plaintext once, stores the hash)');
    console.log('');
  }
  console.log('Reminders:');
  console.log('  - the STCP secretKey is the boundary of an STCP proxy — rotate it together with the token;');
  console.log('  - with auth.trustLocalhost = true (default), a request that arrives through an frp tunnel');
  console.log('    looks like it came from 127.0.0.1 and is accepted without a token (SECURITY.md);');
  console.log('  - rotate both ends at the same time, and hand the new value over out of band.');
}
