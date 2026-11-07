#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Near } from '../src/near.js';
import { doctor } from '../src/doctor.js';
import { claimForeign, leaseConnection, payAndClaim, rentWithNear } from '../src/leases.js';
import { execSsh, runSsh } from '../src/ssh.js';
import { findTransfer, publicClient, toContractLog, walletFor } from '../src/evm.js';

const HELP = `sublet: rent out or rent a Linux machine by the minute

Find a machine
  sublet units                         list machines for rent
  sublet show <unit>                   a machine's terms
  sublet doctor <unit>                 audit the chain of trust

Rent one
  sublet rent <unit> [--ticks 1]       pay in NEAR, get a key
  sublet pay <unit> --chain Base       pay on another chain, get a key
  sublet claim <unit> --chain Base --tx 0x...   claim a payment you already made
  sublet ssh <lease> [-- command]      connect with a lease
  sublet lease <lease>                 a lease's status

Rent out your machine
  sublet list <unit> <terms.json>      list a machine
  sublet setup <unit>                  print the commands for your server
  sublet pause <unit> | resume <unit>  stop or restart new keys
  sublet approve <lease> | reject <lease>

Options
  --contract <id>   default $SUBLET_CONTRACT or sublet.testnet
  --account <id>    NEAR account to use, default $SUBLET_ACCOUNT
  --network <name>  testnet or mainnet, default testnet
  --json            machine-readable output
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contract: { type: 'string' },
    account: { type: 'string' },
    network: { type: 'string', default: 'testnet' },
    ticks: { type: 'string', default: '1' },
    chain: { type: 'string' },
    tx: { type: 'string' },
    rpc: { type: 'string' },
    'ca-file': { type: 'string' },
    wasm: { type: 'string' },
    'source-address': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, ...rest] = positionals;
const contract = flags.contract ?? process.env.SUBLET_CONTRACT ?? 'sublet.testnet';
const accountId = flags.account ?? process.env.SUBLET_ACCOUNT;
const near = new Near({ network: flags.network, accountId });

const print = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text());

function requireArg(value, name) {
  if (!value) {
    console.error(`Missing ${name}.\n\n${HELP}`);
    process.exit(2);
  }
  return value;
}

function evmAccount() {
  const key = process.env.SUBLET_EVM_KEY;
  if (!key) throw new Error('Set SUBLET_EVM_KEY to the 0x private key of the wallet that pays.');
  return walletFor(key);
}

const money = (yocto) => `${(Number(BigInt(yocto) / 10n ** 18n) / 1e6).toString()} NEAR`;

function describeRent(unit) {
  const parts = [];
  if (BigInt(unit.terms.near_per_tick) > 0n) parts.push(money(unit.terms.near_per_tick));
  for (const r of unit.terms.foreign) parts.push(`${r.amount_per_tick} raw units on ${r.chain}`);
  return parts.join(' or ') || 'free';
}

function leaseSummary({ lease, hash, unit, keyPath, certPath, paymentTx }) {
  const until = new Date(Number(lease.valid_before) * 1000).toISOString();
  return [
    `Lease ${lease.id} on ${lease.unit}: ${lease.status}`,
    paymentTx ? `  rent paid in   ${paymentTx}` : null,
    `  NEAR tx       ${near.config.explorer}${hash}`,
    `  valid until   ${until}`,
    `  key           ${keyPath}`,
    `  certificate   ${certPath}`,
    `  connect       sublet ssh ${lease.id}`,
    `  or            ssh -i "${keyPath}" -o CertificateFile="${certPath}" -p ${unit.terms.port} ${unit.terms.principal}@${unit.terms.host}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const commands = {
  async units() {
    const units = await near.view(contract, 'list_units', { limit: 100 });
    print(units, () =>
      units
        .map((u) => `${u.paused ? '[paused] ' : ''}${u.id}  ${u.terms.title}\n  ${describeRent(u)} per ${u.terms.tick_secs}s, ${u.leases} leases, ${u.renewals} renewals`)
        .join('\n') || 'No machines listed yet.',
    );
  },

  async show() {
    const unit = await near.view(contract, 'get_unit', { id: requireArg(rest[0], '<unit>') });
    print(unit, () => JSON.stringify(unit, null, 2));
  },

  async setup() {
    const id = requireArg(rest[0], '<unit>');
    const unit = await near.view(contract, 'get_unit', { id });
    if (!unit?.ca_public_key) throw new Error(`Unit ${id} has no CA key yet.`);
    const lines = [
      `# Run on your server. Nothing is installed.`,
      `sudo useradd -m -s /bin/bash ${unit.terms.principal}   # skip if the user exists`,
      `echo '${unit.ca_public_key}' | sudo tee /etc/ssh/sublet_ca.pub`,
      `echo 'TrustedUserCAKeys /etc/ssh/sublet_ca.pub' | sudo tee /etc/ssh/sshd_config.d/sublet.conf`,
      `sudo systemctl reload ssh`,
    ];
    print({ lines }, () => lines.join('\n'));
  },

  async list() {
    const id = requireArg(rest[0], '<unit>');
    const terms = JSON.parse(fs.readFileSync(requireArg(rest[1], '<terms.json>'), 'utf8'));
    const outcome = await near.call(contract, 'list_unit', { id, terms }, { gasTera: 100, depositYocto: 2n * 10n ** 22n });
    if (!outcome.success) throw new Error(outcome.error);
    print(outcome, () => `Listed ${id}.\nTrust line: ${outcome.value}\nNext: sublet setup ${id}`);
  },

  async rent() {
    const unit = requireArg(rest[0], '<unit>');
    const result = await rentWithNear(near, contract, unit, Number(flags.ticks), { sourceAddress: flags['source-address'] });
    print(result, () => (result.lease.status === 'AwaitingApproval'
      ? `Lease ${result.lease.id} is waiting for the owner to approve it.`
      : leaseSummary(result)));
  },

  async pay() {
    const unit = requireArg(rest[0], '<unit>');
    const chain = requireArg(flags.chain, '--chain');
    const result = await payAndClaim(near, contract, unit, chain, Number(flags.ticks), evmAccount(), {
      rpcUrl: flags.rpc,
      sourceAddress: flags['source-address'],
    });
    print(result, () => leaseSummary(result));
  },

  async claim() {
    const unitId = requireArg(rest[0], '<unit>');
    const chain = requireArg(flags.chain, '--chain');
    const tx = requireArg(flags.tx, '--tx');
    const unit = await near.view(contract, 'get_unit', { id: unitId });
    const rent = unit?.terms.foreign.find((r) => r.chain === chain);
    if (!rent) throw new Error(`${unitId} does not take rent on ${chain}.`);
    const receipt = await publicClient(chain, flags.rpc).getTransactionReceipt({ hash: tx });
    const transfer = findTransfer(receipt, rent.token, rent.pay_to);
    if (!transfer) throw new Error(`No payment to ${rent.pay_to} in ${tx}.`);
    const account = evmAccount();
    const result = await claimForeign(near, contract, unitId, chain, toContractLog(transfer), (message) => account.signMessage({ message }), {
      sourceAddress: flags['source-address'],
    });
    print(result, () => leaseSummary(result));
  },

  async lease() {
    const lease = await near.view(contract, 'get_lease', { id: requireArg(rest[0], '<lease>') });
    print(lease, () => JSON.stringify(lease, null, 2));
  },

  async ssh() {
    const id = requireArg(rest[0], '<lease>');
    const lease = await near.view(contract, 'get_lease', { id });
    if (!lease) throw new Error(`No lease ${id}`);
    const unit = await near.view(contract, 'get_unit', { id: lease.unit });
    const options = leaseConnection(contract, unit, lease);
    if (!fs.existsSync(options.keyPath)) throw new Error(`No local key for lease ${id}. It was rented elsewhere.`);
    if (flags.json) {
      print(execSsh(options, rest.slice(1).join(' ')), () => '');
      return;
    }
    process.exit(await runSsh(options, rest.slice(1).join(' ') || undefined));
  },

  async approve() {
    const outcome = await near.call(contract, 'approve', { lease_id: requireArg(rest[0], '<lease>') }, { gasTera: 150 });
    if (!outcome.success) throw new Error(outcome.error);
    print(outcome, () => `Approved lease ${rest[0]}.`);
  },

  async reject() {
    const outcome = await near.call(contract, 'reject', { lease_id: requireArg(rest[0], '<lease>') }, { gasTera: 30 });
    if (!outcome.success) throw new Error(outcome.error);
    print(outcome, () => `Rejected lease ${rest[0]}. The tenant was refunded.`);
  },

  async pause() {
    const outcome = await near.call(contract, 'set_paused', { id: requireArg(rest[0], '<unit>'), paused: true }, { gasTera: 30 });
    if (!outcome.success) throw new Error(outcome.error);
    print(outcome, () => `${rest[0]} is paused. Keys already cut die at their expiry.`);
  },

  async resume() {
    const outcome = await near.call(contract, 'set_paused', { id: requireArg(rest[0], '<unit>'), paused: false }, { gasTera: 30 });
    if (!outcome.success) throw new Error(outcome.error);
    print(outcome, () => `${rest[0]} is taking tenants again.`);
  },

  async doctor() {
    const checks = await doctor(near, contract, requireArg(rest[0], '<unit>'), {
      caFile: flags['ca-file'],
      wasmFile: flags.wasm,
    });
    print(checks, () =>
      checks
        .map((c) => `${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP'}  ${c.name}\n      ${c.detail}`)
        .join('\n'),
    );
    if (checks.some((c) => c.ok === false)) process.exitCode = 1;
  },
};

if (flags.help || !command) {
  console.log(HELP);
} else if (!commands[command]) {
  console.error(`Unknown command ${command}.\n\n${HELP}`);
  process.exit(2);
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(flags.json ? JSON.stringify({ error: error.message, code: error.code, hash: error.hash }) : error.message);
    process.exit(1);
  }
}
