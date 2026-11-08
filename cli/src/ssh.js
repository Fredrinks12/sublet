// Local SSH helpers. Every lease gets a fresh key by default, generated here and never sent anywhere.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const str = (value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
};

export function subletHome() {
  return process.env.SUBLET_HOME ?? path.join(os.homedir(), '.sublet');
}

function ed25519Raw(privateKeyObject) {
  const jwk = privateKeyObject.export({ format: 'jwk' });
  return {
    seed: Buffer.from(jwk.d, 'base64url'),
    public: Buffer.from(jwk.x, 'base64url'),
  };
}

/** Serializes an Ed25519 key in OpenSSH's own private key format, unencrypted. */
export function opensshPrivateKey(seed, publicKey, comment) {
  const check = crypto.randomBytes(4);
  const keyBlob = Buffer.concat([str('ssh-ed25519'), str(publicKey)]);
  let body = Buffer.concat([
    check,
    check,
    str('ssh-ed25519'),
    str(publicKey),
    str(Buffer.concat([seed, publicKey])),
    str(comment),
  ]);
  const padding = (8 - (body.length % 8)) % 8;
  body = Buffer.concat([body, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))]);
  const file = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    str('none'),
    str('none'),
    str(''),
    Buffer.from([0, 0, 0, 1]),
    str(keyBlob),
    str(body),
  ]);
  const wrapped = file.toString('base64').match(/.{1,70}/g).join('\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export function publicKeyLine(publicKey, comment = '') {
  const blob = Buffer.concat([str('ssh-ed25519'), str(publicKey)]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`.trim();
}

/**
 * On Windows, OpenSSH refuses a private key another account could read, and a new file inherits
 * its folder's permissions. POSIX modes from Node do nothing there, so this sets the ACL.
 */
function restrictToOwner(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`], { stdio: 'ignore' });
  } else {
    fs.chmodSync(file, 0o600);
  }
}

/** Creates a fresh key pair in `dir`. Returns the paths and the public key line. */
export function newKeyPair(dir, comment = 'sublet-tenant') {
  fs.mkdirSync(dir, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = ed25519Raw(privateKey);
  const keyPath = path.join(dir, 'id_ed25519');
  fs.rmSync(keyPath, { force: true });
  fs.writeFileSync(keyPath, opensshPrivateKey(raw.seed, raw.public, comment), { mode: 0o600 });
  restrictToOwner(keyPath);
  const line = publicKeyLine(raw.public, comment);
  fs.writeFileSync(`${keyPath}.pub`, `${line}\n`);
  return { keyPath, publicLine: line, publicKey: raw.public };
}

export function saveCertificate(keyPath, certificateLine) {
  const certPath = `${keyPath}-cert.pub`;
  fs.writeFileSync(certPath, `${certificateLine}\n`);
  return certPath;
}

export function sshArgs({ keyPath, certPath, host, port, user, knownHosts, extra = [] }) {
  const args = [
    '-p', String(port),
    '-i', keyPath,
    '-o', `CertificateFile=${certPath}`,
    '-o', 'IdentitiesOnly=yes',
    // A lease is a key and nothing else. Without this, an expired lease falls back to asking for
    // a password the tenant never had.
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...extra,
  ];
  if (knownHosts) args.push('-o', `UserKnownHostsFile=${knownHosts}`);
  args.push(`${user}@${host}`);
  return args;
}

/** Runs ssh attached to this terminal, or runs one command when `command` is given. */
export function runSsh(options, command, sshBinary = 'ssh') {
  const args = sshArgs(options);
  if (command) args.push(command);
  return new Promise((resolve) => {
    const child = spawn(sshBinary, args, { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`Could not start ssh: ${error.message}`);
      resolve(127);
    });
  });
}

/** Runs one command and captures its output. */
export function execSsh(options, command, sshBinary = 'ssh', timeoutMs = 30_000) {
  const args = sshArgs({ ...options, extra: ['-o', 'BatchMode=yes', ...(options.extra ?? [])] });
  args.push(command);
  const result = spawnSync(sshBinary, args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}
