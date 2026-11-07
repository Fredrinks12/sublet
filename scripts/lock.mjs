// Deletes every access key from a contract account, after which nobody can change its code or sign
// as it, ever. This cannot be undone. Run it only when you have finished testing that deployment.
//   node scripts/lock.mjs <account> --yes
import { Near, PublicKey, actions } from '../cli/src/near.js';

const [accountId, confirmation] = process.argv.slice(2);
if (!accountId || confirmation !== '--yes') {
  console.error('usage: node scripts/lock.mjs <account> --yes\nThis permanently removes every key from the account.');
  process.exit(2);
}

const near = new Near({ accountId });
const about = await near.view(accountId, 'about');
if (about.build !== 'release') throw new Error(`Refusing to lock a ${about.build} build.`);

const keys = await near.accessKeys(accountId);
console.log(`${accountId}: ${keys.length} keys to remove`);
const hash = await near.submit(accountId, keys.map((key) => actions.deleteKey(PublicKey.fromString(key.public_key))));
const outcome = await near.outcome(hash);
if (!outcome.success) throw new Error(outcome.error);
const left = await near.accessKeys(accountId);
console.log(`locked in ${near.config.explorer}${hash}\n${left.length} access keys remain`);
