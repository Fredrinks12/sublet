// Writes docs/EVIDENCE.md and docs/evidence.json from what is on chain and in the Attack Lab results.
//   node scripts/make-evidence.mjs <contract> <lease ids, comma separated>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near } from '../cli/src/near.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [contract, leaseArg] = process.argv.slice(2);
const leases = leaseArg.split(',').map((id) => id.trim()).filter(Boolean);
const near = new Near();
const lab = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'attack-lab-results.json'), 'utf8'));
const about = await near.view(contract, 'about');
const account = await near.accountState(contract);
const keys = await near.accessKeys(contract);
const explorer = near.config.explorer;

const evidence = { network: 'testnet', contract, leases: leases.map(Number), generated_at: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'docs', 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

const extras = fs.existsSync(path.join(root, 'docs', 'evidence-extra.md'))
  ? fs.readFileSync(path.join(root, 'docs', 'evidence-extra.md'), 'utf8').trim()
  : '';
const row = (r) => `| ${r.attack} | ${r.tx ? `[${r.result}](${explorer}${r.tx})` : r.result} |`;
const leaseRows = [];
for (const id of leases) {
  const lease = await near.view(contract, 'get_lease', { id: String(id) });
  leaseRows.push(`| ${id} | ${lease.unit} | ${lease.tenant} | ${lease.ticks} | ${lease.status} |`);
}

const text = `# Evidence

Everything here can be re-checked from public data, with no account or funds:

\`\`\`sh
cd cli && npm ci && cd ..
node scripts/verify-evidence.mjs
\`\`\`

## The contract

| | |
| --- | --- |
| Account | [\`${contract}\`](https://testnet.nearblocks.io/address/${contract}) |
| Build | ${about.build}, version ${about.version} |
| Code hash | \`${account.code_hash}\` |
| Access keys | ${keys.length} |
| MPC contract | \`${about.mpc}\` |

## Real leases

Each of these is a certificate on the public record. The verifier checks each one's Ed25519 signature itself.

| Lease | Unit | Tenant | Ticks | Status |
| --- | --- | --- | --- | --- |
${leaseRows.join('\n')}

## The Attack Lab

${lab.stopped} of ${lab.total} attacks stopped, run on ${lab.run_at.slice(0, 10)} against this contract and stock OpenSSH 10.0p2 on Debian 13. To run it yourself, see \`scripts/attack-lab.mjs\`.

| Attack | What stopped it |
| --- | --- |
${lab.results.map(row).join('\n')}

${lab.results.filter((r) => r.note).map((r) => `**${r.attack}:** ${r.note}`).join('\n\n')}

${extras}
`;
fs.writeFileSync(path.join(root, 'docs', 'EVIDENCE.md'), text.replace(/\n{3,}/g, '\n\n'));
console.log('wrote docs/EVIDENCE.md and docs/evidence.json');
