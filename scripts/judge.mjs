#!/usr/bin/env node
// One command, with no Docker, funds or wallet. Needs Node 20+ and OpenSSH (ssh and sshd).
//   node scripts/judge.mjs
//
// Starts a private sshd on a local port that trusts one key held by no person. Then it lists that
// server on the live testnet contract, rents it, logs in, and watches the lease end. It runs as you,
// so it uses session-only eviction (`evict_user: false`) and cannot touch your other processes.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair, Near, createTestnetAccount, loadCredentials } from '../cli/src/near.js';
import { leaseConnection, rentWithNear } from '../cli/src/leases.js';
import { execSsh, newKeyPair, sshArgs, subletHome } from '../cli/src/ssh.js';
import { doctor } from '../cli/src/doctor.js';

const contract = process.env.SUBLET_CONTRACT ?? 'sublet.testnet';
const user = os.userInfo().username;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};
const step = (text) => console.log(`\n--- ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBinary(name) {
  if (process.env[`SUBLET_${name.toUpperCase()}`]) return process.env[`SUBLET_${name.toUpperCase()}`];
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), '/usr/sbin', '/usr/local/sbin', '/sbin']) {
    for (const candidate of [path.join(dir, name), path.join(dir, `${name}.exe`)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  console.error(`Could not find ${name}. Install OpenSSH (on Debian or Ubuntu: apt-get install openssh-server).`);
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function testAccount() {
  if (process.env.SUBLET_ACCOUNT) {
    return { accountId: process.env.SUBLET_ACCOUNT, privateKey: loadCredentials(process.env.SUBLET_ACCOUNT) };
  }
  const pair = KeyPair.fromRandom('ed25519');
  const accountId = `sublet-judge-${crypto.randomBytes(5).toString('hex')}.testnet`;
  await createTestnetAccount(accountId, pair.getPublicKey().toString());
  await sleep(2500);
  return { accountId, privateKey: pair.toString() };
}

const SSHD = findBinary('sshd');
const SSH = findBinary('ssh');
const KEYGEN = findBinary('ssh-keygen');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-judge-'));
process.env.SUBLET_HOME = path.join(dir, 'home');
const stamp = path.join(os.homedir(), '.sublet-until');
const hadStamp = fs.existsSync(stamp);
const posix = (p) => p.replaceAll('\\', '/');
let sshd;

async function main() {
  step('1. A free testnet account and a private server');
  const { accountId, privateKey } = await testAccount();
  console.log(`account ${accountId}\ncontract ${contract}`);
  const near = new Near({ accountId, privateKey });
  const about = await near.view(contract, 'about');
  console.log(`contract build: ${about.build}, version ${about.version}, MPC ${about.mpc}`);

  const port = await freePort();
  const unitId = `judge-${crypto.randomBytes(4).toString('hex')}`;
  const terms = {
    title: 'A judge runs this locally',
    blurb: 'Listed by scripts/judge.mjs for one test run.',
    host: '127.0.0.1',
    port,
    principal: user,
    command: null,
    evict_user: false,
    permit_pty: true,
    permit_port_forwarding: false,
    tick_secs: 30,
    max_ticks: 4,
    near_per_tick: '1000000000000000000000',
    foreign: [],
    allowlist: null,
    needs_approval: false,
  };
  const listing = await near.call(contract, 'list_unit', { id: unitId, terms }, { gasTera: 100, depositYocto: 2n * 10n ** 22n });
  if (!listing.success) throw new Error(`Could not list the test server: ${listing.error}`);
  const unit = await near.view(contract, 'get_unit', { id: unitId });
  check('the contract listed this server and returned a key only it can use', Boolean(unit.ca_public_key), unit.ca_public_key);

  const hostKey = path.join(dir, 'host_key');
  spawnSync(KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  fs.writeFileSync(path.join(dir, 'sublet_ca.pub'), `${unit.ca_public_key}\n`);
  fs.writeFileSync(
    path.join(dir, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${posix(hostKey)}`,
      `PidFile ${posix(path.join(dir, 'sshd.pid'))}`,
      `TrustedUserCAKeys ${posix(path.join(dir, 'sublet_ca.pub'))}`,
      'AuthorizedKeysFile none',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'StrictModes no',
      process.platform === 'win32' ? '' : 'UsePAM no',
      '',
    ].join('\n'),
  );
  const log = fs.openSync(path.join(dir, 'sshd.log'), 'w');
  sshd = spawn(SSHD, ['-D', '-e', '-f', path.join(dir, 'sshd_config')], { stdio: ['ignore', log, log] });
  await sleep(1200);

  step('2. No lease, no entry');
  const known = path.join(dir, 'known_hosts');
  const stranger = newKeyPair(path.join(dir, 'stranger'), 'stranger');
  const refused = spawnSync(
    SSH,
    ['-p', String(port), '-i', stranger.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`, `${user}@127.0.0.1`, 'whoami'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  check('a key with no lease is refused', refused.status === 255, (refused.stderr ?? '').trim().split('\n').pop());

  step('3. Rent it from the contract');
  const t0 = Date.now();
  const rented = await rentWithNear(near, contract, unitId, 2);
  const { lease } = rented;
  check('the contract issued a certificate, signed by the MPC network', lease.status === 'Issued', `in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${near.config.explorer}${rented.hash}`);
  const details = spawnSync(KEYGEN, ['-L', '-f', rented.certPath], { encoding: 'utf8' });
  console.log(details.stdout.split('\n').filter((l) => /Key ID|Valid:|Signing CA/.test(l)).map((l) => `      ${l.trim()}`).join('\n'));

  const options = { ...leaseConnection(contract, unit, lease), knownHosts: known };
  const hello = execSsh(options, 'echo logged in as $(id -un)', SSH, 30_000);
  check('stock sshd accepts it', hello.code === 0, hello.stdout || hello.stderr);

  step('4. The lease ends');
  const end = Number(lease.valid_before);
  const open = spawn(SSH, [...sshArgs({ ...options, extra: ['-o', 'BatchMode=yes'] }), 'sleep 100000'], { stdio: 'ignore' });
  let ended = null;
  open.on('exit', () => {
    ended = Math.floor(Date.now() / 1000);
  });
  console.log(`a session is open. Waiting ${end - Math.floor(Date.now() / 1000)}s for the lease to end...`);
  await sleep((end - Math.floor(Date.now() / 1000) + 8) * 1000);
  check('the open session ended with the lease', ended !== null, ended ? `${ended - end}s after the end` : 'still open');
  if (ended === null) open.kill();

  const after = execSsh(options, 'whoami', SSH, 30_000);
  check('the same certificate is now refused', after.code === 255, after.stderr.split('\n').pop());

  step('5. Audit the chain of trust from public data');
  const audit = await doctor(near, contract, unitId, { caFile: path.join(dir, 'sublet_ca.pub') });
  for (const item of audit) {
    if (item.ok === null) console.log(`SKIP  ${item.name}\n      ${item.detail}`);
    else if (item.name.startsWith('Nobody') && process.env.SUBLET_CONTRACT) console.log(`NOTE  ${item.name}\n      ${item.detail}`);
    else check(item.name, item.ok, item.detail);
  }

  await near.call(contract, 'delist_unit', { id: unitId }, { gasTera: 30 });
}

try {
  await main();
} catch (error) {
  results.push(false);
  console.error(`\nStopped: ${error.message}`);
} finally {
  sshd?.kill();
  if (!hadStamp) fs.rmSync(stamp, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} checks passed.`);
process.exit(passed === results.length ? 0 : 1);
