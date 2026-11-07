// Records a real lease from a tenant's point of view, using the real commands and their real output.
// The website's replay and the demo video are both driven from this file, so neither is invented.
//   node scripts/vm/capture-transcript.mjs <contract> <tenant> <unit>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near } from '../../cli/src/near.js';
import { leaseConnection, rentWithNear } from '../../cli/src/leases.js';
import { execSsh, newKeyPair, sshArgs } from '../../cli/src/ssh.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [contract, tenant, unitId] = process.argv.slice(2);
const near = new Near({ accountId: tenant });
const unit = await near.view(contract, 'get_unit', { id: unitId });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-capture-'));
const known = path.join(scratch, 'known_hosts');
const target = `${unit.terms.principal}@${unit.terms.host}`;
const lines = [];
const say = (text, kind = 'out') => {
  lines.push({ text, kind });
  console.log(kind === 'cmd' ? `$ ${text}` : text);
};
const cleanLines = (text) => text.split('\n').map((l) => l.trimEnd()).filter((l) => l && !/^Warning: Permanently added/.test(l));

say(`ssh -p ${unit.terms.port} ${target}`, 'cmd');
const stranger = newKeyPair(path.join(scratch, 'k'), 'stranger');
const refused = spawnSync('ssh', [
  '-p', String(unit.terms.port), '-i', stranger.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${known}`, target,
], { encoding: 'utf8', timeout: 60_000 });
for (const line of cleanLines(refused.stderr)) say(line, 'bad');

const ticks = 2;
say(`sublet rent ${unitId} --ticks ${ticks}`, 'cmd');
const t0 = Date.now();
const { lease, hash } = await rentWithNear(near, contract, unitId, ticks);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
say(`Lease ${lease.id} on ${lease.unit}: ${lease.status}`, 'good');
say(`  cut in        ${seconds}s by the NEAR MPC network`, 'dim');
say(`  NEAR tx       ${hash}`, 'dim');
say(`  valid until   ${new Date(Number(lease.valid_before) * 1000).toISOString()}`, 'dim');

const options = { ...leaseConnection(contract, unit, lease), knownHosts: known };
const first = 'whoami; uname -sr';
say(`sublet ssh ${lease.id} -- "${first}"`, 'cmd');
const hello = execSsh(options, first, 'ssh', 60_000);
for (const line of cleanLines(hello.stdout)) say(line, 'good');

const held = 'sleep 100000; echo survived';
say(`sublet ssh ${lease.id} -- "${held}"`, 'cmd');
const left = Number(lease.valid_before) - Math.floor(Date.now() / 1000);
say(`[${left} seconds pass. The lease ends.]`, 'dim');
const session = spawnSync('ssh', [...sshArgs({ ...options, extra: ['-o', 'BatchMode=yes'] }), held], {
  encoding: 'utf8',
  timeout: (left + 45) * 1000,
});
for (const line of cleanLines(`${session.stdout}\n${session.stderr}`)) say(line, 'bad');
if (session.status === null) throw new Error('The session did not end with the lease');

await new Promise((resolve) => setTimeout(resolve, 12_000));
say(`sublet ssh ${lease.id}`, 'cmd');
const after = execSsh(options, 'whoami', 'ssh', 60_000);
for (const line of cleanLines(after.stderr)) say(line, 'bad');
if (after.code !== 255) throw new Error('The expired certificate was not refused');

const transcript = { contract, lease: lease.id, tx: hash, captured_at: new Date().toISOString(), lines };
fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
fs.writeFileSync(path.join(root, 'demo', 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'web', 'src', 'transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`);
fs.rmSync(scratch, { recursive: true, force: true });
console.log(`saved, from lease ${lease.id}`);
