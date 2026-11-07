// Deploys contract/target/near/sublet.wasm to an account and initialises it.
//   node scripts/deploy.mjs <account.testnet>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near, NETWORKS } from '../cli/src/near.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const accountId = process.argv[2];
const network = process.argv[3] ?? 'testnet';
if (!accountId) throw new Error('usage: node scripts/deploy.mjs <account> [network]');

const near = new Near({ network, accountId });
const wasm = fs.readFileSync(path.join(here, '..', 'contract', 'target', 'near', 'sublet.wasm'));
const result = await near.deploy(wasm, 'new', {
  mpc: NETWORKS[network].mpc,
  sign_domain: 1,
  foreign_domain: 3,
});
console.log(result.success ? `deployed: ${result.hash}` : `failed: ${result.error}`);
console.log(await near.view(accountId, 'about'));
