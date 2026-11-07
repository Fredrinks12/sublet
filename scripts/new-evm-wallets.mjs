// Creates two throwaway testnet wallets, a tenant and an owner, and stores them in the gitignored
// .env file. Testnet only. Never send real funds to these keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walletFor } from '../cli/src/evm.js';

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const lines = fs.readFileSync(envFile, 'utf8').trim().split(/\r?\n/);
const has = (name) => lines.some((line) => line.startsWith(`${name}=`));
for (const name of ['EVM_TENANT_KEY', 'EVM_OWNER_KEY']) {
  if (!has(name)) lines.push(`${name}=0x${crypto.randomBytes(32).toString('hex')}`);
}
fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
const value = (name) => lines.find((line) => line.startsWith(`${name}=`)).split('=')[1];
console.log('tenant wallet:', walletFor(value('EVM_TENANT_KEY')).address);
console.log('owner wallet: ', walletFor(value('EVM_OWNER_KEY')).address);
