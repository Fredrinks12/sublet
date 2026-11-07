// SSH keys made in the browser. The private key never leaves this page.
import { KeyPair } from 'near-api-js';

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const text = (s) => new TextEncoder().encode(s);

const str = (value) => {
  const body = typeof value === 'string' ? text(value) : value;
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, body.length);
  return concat(length, body);
};

const base64 = (bytes) => btoa(String.fromCharCode(...bytes));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(input) {
  let n = 0n;
  for (const c of input) n = n * 58n + BigInt(B58.indexOf(c));
  const hex = n.toString(16).padStart(input.length * 2, '0');
  const bytes = Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
  return bytes;
}

/** Serializes an Ed25519 key in OpenSSH's own private key format, unencrypted. */
function opensshPrivateKey(seed, publicKey, comment) {
  const check = crypto.getRandomValues(new Uint8Array(4));
  const blob = concat(str('ssh-ed25519'), str(publicKey));
  let body = concat(check, check, str('ssh-ed25519'), str(publicKey), str(concat(seed, publicKey)), str(comment));
  const padding = (8 - (body.length % 8)) % 8;
  body = concat(body, Uint8Array.from({ length: padding }, (_, i) => i + 1));
  const file = concat(text('openssh-key-v1\0'), str('none'), str('none'), str(''), new Uint8Array([0, 0, 0, 1]), str(blob), str(body));
  const wrapped = base64(file).match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A fresh key for one lease. */
export function newSshKey(comment = 'sublet-tenant') {
  const pair = KeyPair.fromRandom('ed25519');
  const secret = b58decode(pair.toString().replace('ed25519:', '')).slice(-64);
  const seed = secret.slice(0, 32);
  const publicKey = secret.slice(32);
  const line = `ssh-ed25519 ${base64(concat(str('ssh-ed25519'), str(publicKey)))} ${comment}`;
  return { publicLine: line, privateKey: opensshPrivateKey(seed, publicKey, comment) };
}

/** A paste-ready script that saves the key and certificate, then logs in. */
export function loginScript({ lease, unit, key }) {
  const dir = `~/.sublet/lease-${lease.id}`;
  return [
    `mkdir -p ${dir} && cd ${dir}`,
    `cat > id_ed25519 <<'KEY'`,
    key.privateKey.trim(),
    `KEY`,
    `chmod 600 id_ed25519`,
    `echo '${lease.certificate}' > id_ed25519-cert.pub`,
    `ssh -i id_ed25519 -o CertificateFile=id_ed25519-cert.pub -o IdentitiesOnly=yes -p ${unit.terms.port} ${unit.terms.principal}@${unit.terms.host}`,
  ].join('\n');
}
