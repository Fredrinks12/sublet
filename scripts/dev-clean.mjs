// Development helper: removes every unit the owner has listed on the current contract.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Near } from '../cli/src/near.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env'), 'utf8').trim().split(/\r?\n/).map((l) => l.split('=')));
const contract = process.env.SUBLET_CONTRACT ?? env.CONTRACT;
const owner = new Near({ accountId: env.OWNER });
const units = await owner.view(contract, 'list_units', { limit: 100 });
for (const unit of units.filter((u) => u.owner === env.OWNER)) {
  const outcome = await owner.call(contract, 'delist_unit', { id: unit.id }, { gasTera: 30 });
  console.log(`${outcome.success ? 'delisted' : 'failed'} ${unit.id}`);
}
