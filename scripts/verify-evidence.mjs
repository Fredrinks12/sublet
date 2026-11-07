#!/usr/bin/env node
// Re-checks this project's claims from public chain data. Needs no account, funds or keys.
//   node scripts/verify-evidence.mjs
//
// It reads docs/evidence.json for what to look at, but trusts none of it: each fact is fetched from
// the chain, and each certificate's signature is verified here, with Node's own Ed25519.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near, refusalCode } from '../cli/src/near.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'evidence.json'), 'utf8'));
const attacks = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'attack-lab-results.json'), 'utf8'));
const near = new Near({ network: evidence.network });
const { contract } = evidence;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

/** Reads an OpenSSH certificate field by field, from its wire format. */
function parseCertificate(line) {
  const blob = Buffer.from(line.split(' ')[1], 'base64');
  let at = 0;
  const string = () => {
    const length = blob.readUInt32BE(at);
    const value = blob.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return value;
  };
  const u64 = () => {
    const value = blob.readBigUInt64BE(at);
    at += 8;
    return value;
  };
  const type = string().toString();
  string(); // nonce
  const subject = string();
  const serial = u64();
  at += 4; // certificate type
  const keyId = string().toString();
  const principals = string();
  const validAfter = u64();
  const validBefore = u64();
  const critical = string().toString('latin1');
  string(); // extensions
  string(); // reserved
  const signatureKey = string();
  const signedLength = at;
  const signatureBlob = string();
  const ca = signatureKey.subarray(signatureKey.length - 32);
  const signature = signatureBlob.subarray(signatureBlob.length - 64);
  return {
    type,
    subject,
    serial,
    keyId,
    principal: principals.subarray(4).toString(),
    validAfter,
    validBefore,
    critical,
    ca,
    signature,
    signed: blob.subarray(0, signedLength),
  };
}

function ed25519Verify(publicKey, message, signature) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return crypto.verify(null, message, key, signature);
}

console.log(`Contract ${contract} on ${evidence.network}\n`);

console.log('--- The contract');
const about = await near.view(contract, 'about');
check('this is the release build', about.build === 'release', `build ${about.build}, version ${about.version}`);
const keys = await near.accessKeys(contract);
check('nobody holds a key to the contract', keys.length === 0, `${keys.length} access keys`);
const account = await near.accountState(contract);
const wasmFile = path.join(root, 'contract', 'target', 'near', 'sublet.wasm');
if (fs.existsSync(wasmFile)) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(wasmFile)).digest();
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of account.code_hash) n = n * 58n + BigInt(B58.indexOf(c));
  check('the deployed code matches a local build', n.toString(16).padStart(64, '0') === digest.toString('hex'), `code hash ${account.code_hash}`);
} else {
  console.log(`SKIP  deployed code matches a local build\n      code hash ${account.code_hash}. Build the contract to compare.`);
}

console.log('\n--- Certificates on the public record');
for (const id of evidence.leases) {
  const lease = await near.view(contract, 'get_lease', { id: String(id) });
  if (!lease?.certificate) {
    check(`lease ${id} has a certificate`, false);
    continue;
  }
  const cert = parseCertificate(lease.certificate);
  const unit = await near.view(contract, 'get_unit', { id: lease.unit });
  const caMatches = unit ? Buffer.from(unit.ca_public_key.split(' ')[1], 'base64').subarray(-32).equals(cert.ca) : null;
  check(
    `lease ${id}: the signature on this certificate is valid`,
    ed25519Verify(cert.ca, cert.signed, cert.signature),
    `${cert.type}, ${lease.unit}, ${lease.tenant}`,
  );
  if (caMatches !== null) check(`lease ${id}: signed by the key the contract holds for ${lease.unit}`, caMatches);
  check(
    `lease ${id}: the certificate says what the chain says`,
    Number(cert.validBefore) === Number(lease.valid_before) && cert.subject.toString('hex') === lease.subject && Number(cert.serial) === Number(lease.id),
    `valid until ${new Date(Number(cert.validBefore) * 1000).toISOString()}, serial ${cert.serial}`,
  );
}

console.log('\n--- Refusals on the public record');
const refusals = attacks.results.filter((r) => r.tx && r.expected.startsWith('E_'));
let confirmed = 0;
for (const refusal of refusals) {
  const outcome = await near.outcome(refusal.tx, refusal.signer, 30_000).catch(() => null);
  const code = outcome ? refusalCode(outcome.error) : null;
  if (code === refusal.expected) confirmed += 1;
  else check(refusal.attack, false, `expected ${refusal.expected}, chain says ${code}`);
}
check(`${confirmed} of ${refusals.length} recorded refusals are on chain with the same code`, confirmed === refusals.length);

console.log(failures ? `\n${failures} checks failed.` : '\nEverything checked out.');
process.exit(failures ? 1 : 0);
