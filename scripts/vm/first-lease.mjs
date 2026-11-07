// The core test, against real Debian and the live MPC network. No mock anywhere.
//   1. A key with no lease is refused.
//   2. A lease from the contract logs in.
//   3. A tenant tries to outlive the lease with an open session, nohup and setsid. All must die.
//   4. The same certificate is refused after expiry.
//   5. A renewal keeps a running session alive past the first end time, then it ends too.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Near } from '../../cli/src/near.js';
import { rentWithNear, leaseConnection } from '../../cli/src/leases.js';
import { execSsh, newKeyPair, sshArgs } from '../../cli/src/ssh.js';
import { Serial } from './serial.mjs';

const [contract, tenant, unitId = 'debian-vm'] = process.argv.slice(2);
const near = new Near({ accountId: tenant });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`);
};
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serial = new Serial();
await serial.connect();
await serial.login();
const tenantProcesses = async () => {
  const { output } = await serial.run('ps -u tenant -o pid=,args= | grep -v "sshd-session" || true', { check: false });
  return output.split('\n').map((l) => l.trim()).filter(Boolean);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-'));
const stranger = newKeyPair(scratch, 'stranger');
const unit = await near.view(contract, 'get_unit', { id: unitId });
const known = path.join(scratch, 'known_hosts');
const base = { host: unit.terms.host, port: unit.terms.port, user: unit.terms.principal, knownHosts: known };

const noLease = spawnSync('ssh', [
  '-p', String(base.port), '-i', stranger.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`,
  `${base.user}@${base.host}`, 'whoami',
], { encoding: 'utf8', timeout: 90_000 });
check('a key with no lease is refused', noLease.status === 255, (noLease.stderr ?? '').trim().split('\n').pop());

const t0 = Date.now();
const first = await rentWithNear(near, contract, unitId, 2);
console.log(`lease ${first.lease.id} ${first.lease.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, tx ${first.hash}`);
const end = Number(first.lease.valid_before);
const options = { ...leaseConnection(contract, unit, first.lease), knownHosts: known };

const hello = execSsh(options, 'whoami; uname -sr', 'ssh', 90_000);
check('the lease logs in', hello.code === 0 && hello.stdout.startsWith(unit.terms.principal), hello.stdout.replaceAll('\n', ' | ') || hello.stderr);

const escape = execSsh(
  options,
  'nohup sh -c "while :; do sleep 7; done" >/dev/null 2>&1 & setsid sh -c "while :; do sleep 9; done" >/dev/null 2>&1 & echo planted',
  'ssh',
  90_000,
);
check('the tenant plants nohup and setsid processes', escape.stdout === 'planted', escape.stderr);

const openSession = spawn('ssh', [...sshArgs({ ...options, extra: ['-o', 'BatchMode=yes'] }), 'sleep 100000; echo SURVIVED'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
openSession.stdout.on('data', (d) => { output += d; });
openSession.stderr.on('data', (d) => { output += d; });
const exited = new Promise((resolve) => openSession.on('exit', (code) => resolve({ code })));

await sleep(4000);
const before = await tenantProcesses();
console.log(`tenant processes before the end: ${before.length}, lease ends in ${end - nowSecs()}s`);
const outcome = await Promise.race([exited, sleep((end - nowSecs() + 40) * 1000).then(() => 'still-open')]);
const late = nowSecs() - end;
if (outcome === 'still-open') {
  openSession.kill();
  check('an open session dies when the lease ends', false, `still open ${late}s after the end`);
} else {
  check('an open session dies when the lease ends', !output.includes('SURVIVED'), `ended ${late}s after the lease`);
}
await sleep(1500);
const left = await tenantProcesses();
check('nothing the tenant started survives', left.length === 0, left.join(' ; ') || 'no tenant processes remain');

const after = execSsh(options, 'whoami', 'ssh', 90_000);
check('the same certificate is refused after expiry', after.code === 255, after.stderr.split('\n').pop());

console.log('--- renewal ---');
const second = await rentWithNear(near, contract, unitId, 1);
const firstEnd = Number(second.lease.valid_before);
const options2 = { ...leaseConnection(contract, unit, second.lease), knownHosts: known };
const session = spawn('ssh', [...sshArgs({ ...options2, extra: ['-o', 'BatchMode=yes'] }), 'sleep 100000'], { stdio: 'ignore' });
let sessionEnded = false;
session.on('exit', () => { sessionEnded = true; });
await sleep(3000);
const renewal = await rentWithNear(near, contract, unitId, 1);
const renewedEnd = Number(renewal.lease.valid_before);
check('a renewal extends the end time', renewedEnd > firstEnd, `${firstEnd} -> ${renewedEnd}`);
const options3 = { ...leaseConnection(contract, unit, renewal.lease), knownHosts: known };
const touch = execSsh(options3, 'cat ~/.sublet-until', 'ssh', 90_000);
check('logging in with the new key records the new end', touch.stdout === String(renewedEnd), touch.stdout || touch.stderr);
await sleep(Math.max(0, (firstEnd - nowSecs() + 6) * 1000));
check('the running session survives the first end time', !sessionEnded, `${nowSecs() - firstEnd}s past it`);
await sleep(Math.max(0, (renewedEnd - nowSecs() + 8) * 1000));
check('it ends at the renewed time', sessionEnded, `${nowSecs() - renewedEnd}s past it`);
if (!sessionEnded) session.kill();

const unitAfter = await near.view(contract, 'get_unit', { id: unitId });
console.log(`unit stats: ${unitAfter.leases} leases, ${unitAfter.renewals} renewals, ${unitAfter.ticks_sold} ticks`);
console.log(results.every(Boolean) ? 'ALL PASSED' : 'SOME CHECKS FAILED');
serial.close();
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
