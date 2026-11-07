// Development helper. A contract's stored layout cannot change in place, so each test build goes to
// a fresh sub-account of the dev account. The previous one is deleted and its balance reclaimed.
//   node scripts/dev-redeploy.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPairSigner, Near, NETWORKS, actions, loadCredentials } from '../cli/src/near.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '..', '.env');
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').trim().split(/\r?\n/).map((line) => line.split('=')),
);

const parent = env.DEV_PARENT ?? env.CONTRACT;
const parentNear = new Near({ accountId: parent });
const privateKey = loadCredentials(parent);
const publicKey = await KeyPairSigner.fromSecretKey(privateKey).getPublicKey();

if (env.CONTRACT !== parent) {
  try {
    const old = new Near({ accountId: env.CONTRACT, privateKey });
    const hash = await old.submit(env.CONTRACT, [actions.deleteAccount(parent)]);
    await old.outcome(hash);
    console.log(`deleted ${env.CONTRACT}, balance returned to ${parent}`);
  } catch (error) {
    console.log(`could not delete ${env.CONTRACT}: ${String(error.message).slice(0, 120)}`);
  }
}

const name = `c${Date.now().toString(36)}.${parent}`;
const wasm = fs.readFileSync(path.join(here, '..', 'contract', 'target', 'near', 'sublet.wasm'));
const TGAS = 10n ** 12n;
const hash = await parentNear.submit(name, [
  actions.createAccount(),
  actions.transfer(4n * 10n ** 24n),
  actions.addFullAccessKey(publicKey),
  actions.deployContract(wasm),
  actions.functionCall('new', { mpc: NETWORKS.testnet.mpc, sign_domain: 1, foreign_domain: 3 }, 30n * TGAS, 0n),
]);
const outcome = await parentNear.outcome(hash);
if (!outcome.success) throw new Error(outcome.error);

const credentials = path.join(os.homedir(), '.near-credentials', 'testnet', `${name}.json`);
fs.writeFileSync(credentials, JSON.stringify({ account_id: name, public_key: publicKey.toString(), private_key: privateKey }));

env.DEV_PARENT = parent;
env.CONTRACT = name;
fs.writeFileSync(envFile, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
console.log(`deployed ${name}\n  tx ${hash}`);
