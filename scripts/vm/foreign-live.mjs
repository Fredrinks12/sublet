// Live round trip of a foreign payment, with no test funds. Needs a contract built with the
// dev-any-payer feature, which skips only the check that the payer signed the claim.
//
// Takes a real USDC transfer made by a stranger on Base Sepolia, lists a unit that names that
// transfer's recipient as the owner, and claims it. Everything else is real: the MPC network reads
// Base, the contract rebuilds the hash, and stock sshd in the VM accepts the resulting certificate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near } from '../../cli/src/near.js';
import { claimForeign, leaseConnection } from '../../cli/src/leases.js';
import { execSsh } from '../../cli/src/ssh.js';
import { toContractLog, walletFor } from '../../cli/src/evm.js';
import { Serial } from './serial.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').trim().split(/\r?\n/).map((l) => l.split('=')));
const contract = env.CONTRACT;

const BASE_RPCS = ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function baseRpc(method, params) {
  let last;
  for (const url of BASE_RPCS) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const body = await response.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

const about = await new Near().view(contract, 'about');
if (about.build !== 'dev-any-payer') throw new Error(`Needs a dev-any-payer build, found ${about.build}`);

const head = parseInt(await baseRpc('eth_blockNumber', []), 16);
let logs = [];
for (let end = head - 20; end > head - 1500 && !logs.length; end -= 100) {
  logs = await baseRpc('eth_getLogs', [{
    address: USDC,
    topics: [TRANSFER],
    fromBlock: `0x${(end - 99).toString(16)}`,
    toBlock: `0x${end.toString(16)}`,
  }]);
}
const usable = logs.filter((l) => BigInt(l.data) > 0n && l.topics.length === 3);
if (!usable.length) throw new Error('No recent USDC transfer found');
const stranger = usable[usable.length - 1];
const payTo = `0x${stranger.topics[2].slice(-40)}`;
console.log(`a stranger's real payment: ${stranger.transactionHash}, raw amount ${BigInt(stranger.data)}, to ${payTo}`);

const owner = new Near({ accountId: env.OWNER });
const unitId = `base-${Date.now().toString(36)}`;
const terms = {
  title: 'Foreign payment test unit',
  blurb: 'Takes USDC on Base Sepolia.',
  host: '127.0.0.1',
  port: 2222,
  principal: 'tenant',
  command: null,
  evict_user: true,
  permit_pty: true,
  permit_port_forwarding: false,
  tick_secs: 60,
  max_ticks: 5,
  near_per_tick: '0',
  foreign: [{ chain: 'Base', token: USDC, pay_to: payTo, amount_per_tick: '1', finality: 'Latest' }],
  allowlist: null,
  needs_approval: false,
};
const listing = await owner.call(contract, 'list_unit', { id: unitId, terms }, { gasTera: 100, depositYocto: 2n * 10n ** 22n });
if (!listing.success) throw new Error(listing.error);
console.log(`listed ${unitId}`);

const serial = new Serial();
await serial.connect();
await serial.login();
const unit = await owner.view(contract, 'get_unit', { id: unitId });
await serial.run(`echo '${unit.ca_public_key}' > /etc/ssh/sublet_ca.pub`);
await serial.run('systemctl reload ssh');
const skew = await serial.run('date +%s');
console.log(`clock check: guest minus host = ${Number(skew.output) - Math.floor(Date.now() / 1000)}s`);

const wallet = walletFor(env.EVM_TENANT_KEY);
const tenant = new Near({ accountId: env.TENANT });
const t0 = Date.now();
const log = toContractLog(stranger);
const result = await claimForeign(tenant, contract, unitId, 'Base', log, (message) => wallet.signMessage({ message }));
console.log(`lease ${result.lease.id} ${result.lease.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.lease.ticks} ticks`);
console.log(`NEAR tx ${result.hash}`);
console.log(`tenant recorded as ${result.lease.tenant}`);

const options = leaseConnection(contract, unit, result.lease);
const hello = execSsh(options, 'echo paid on Base, logged in as $(whoami)', 'ssh', 90_000);
console.log(`[${hello.code === 0 ? 'PASS' : 'FAIL'}] ${hello.stdout || hello.stderr}`);

const replay = await claimForeign(tenant, contract, unitId, 'Base', log, (message) => wallet.signMessage({ message })).catch((e) => e);
console.log(`[${replay.code === 'E_PAYMENT_ALREADY_USED' || replay.code === 'E_BUSY' ? 'PASS' : 'FAIL'}] replaying the payment: ${replay.code ?? replay.message}`);
serial.close();
process.exit(hello.code === 0 ? 0 : 1);
