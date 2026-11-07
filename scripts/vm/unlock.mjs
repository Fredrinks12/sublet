// Run once, while the VM is booted with `start.ps1 -Unlock`. Gives root a serial-console password.
// sshd's default PermitRootLogin refuses passwords, so this opens nothing over the network.
import { Serial } from './serial.mjs';

const serial = new Serial();
await serial.connect();
serial.echo = process.argv.includes('--echo');
console.log('waiting for the single-user shell...');
const deadline = Date.now() + 420_000;
for (;;) {
  serial.send('\n');
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (/root@[^\n]*#\s*$|bash-[\d.]+#\s*$|#\s*$/.test(serial.buffer)) break;
  if (Date.now() > deadline) throw new Error(`No shell. Tail:\n${serial.buffer.slice(-500)}`);
}
const commands = [
  'mount -o remount,rw /',
  'mount -t proc proc /proc',
  'echo root:sublet-vm | chpasswd',
  'grep -c "^root:\\$" /etc/shadow',
  'sync',
  'echo __UNLOCKED__',
];
for (const command of commands) {
  serial.send(`${command}\n`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
await serial.expect(/__UNLOCKED__\s*\r?\n/, 60_000);
console.log('root password set');
serial.send('poweroff -f\n');
await new Promise((resolve) => setTimeout(resolve, 3000));
serial.close();
