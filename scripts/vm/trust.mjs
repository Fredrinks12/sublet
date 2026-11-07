// Runs the exact commands `sublet setup` prints, inside the VM, using its serial console.
//   node scripts/vm/trust.mjs <unit> <contract>
import { Serial } from './serial.mjs';
import { Near } from '../../cli/src/near.js';

const [unitId, contract] = process.argv.slice(2);
const near = new Near();
const unit = await near.view(contract, 'get_unit', { id: unitId });
if (!unit?.ca_public_key) throw new Error(`Unit ${unitId} has no CA key`);

const serial = new Serial();
await serial.connect();
await serial.login();
await serial.run(`echo '${unit.ca_public_key}' > /etc/ssh/sublet_ca.pub`);
await serial.run(`echo 'TrustedUserCAKeys /etc/ssh/sublet_ca.pub' > /etc/ssh/sshd_config.d/sublet.conf`);
await serial.run('systemctl reload ssh');
const { output } = await serial.run('sshd -T | grep -i trustedusercakeys');
console.log(`VM now trusts: ${unit.ca_public_key}`);
console.log(`sshd reports:  ${output}`);
serial.close();
