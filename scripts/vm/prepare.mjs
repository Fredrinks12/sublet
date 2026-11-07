// Makes the booted VM a stock SSH server with a `tenant` user, and nothing else. No NEAR software is
// installed. Reports what it finds, so a demo can show that the server is plain Debian.
import { Serial } from './serial.mjs';

const serial = new Serial();
await serial.connect();
if (process.argv.includes('--echo')) serial.echo = true;
console.log('waiting for the guest to boot (software emulation is slow)...');
const t0 = Date.now();
await serial.login();
console.log(`logged in after ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const installed = await serial.run('command -v sshd || ls /usr/sbin/sshd', { check: false });
if (installed.code !== 0) {
  console.log('installing the distribution openssh-server package...');
  await serial.run('apt-get update -qq', { timeoutMs: 300_000 });
  await serial.run('DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server', { timeoutMs: 600_000 });
}
await serial.run('command -v curl >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl)', { timeoutMs: 300_000 });
await serial.run('id tenant >/dev/null 2>&1 || useradd -m -s /bin/bash tenant');
await serial.run('passwd -l tenant >/dev/null');
await serial.run('ssh-keygen -A >/dev/null');
await serial.run('systemctl enable --now ssh >/dev/null 2>&1 || systemctl restart ssh');

const facts = [
  ['OS', 'grep PRETTY_NAME /etc/os-release'],
  ['sshd', 'sshd -V 2>&1 | head -1 || true'],
  ['ssh package', 'dpkg -l openssh-server | tail -1 | tr -s " " | cut -d" " -f2,3'],
  ['coreutils timeout', 'timeout --version | head -1'],
  ['listening', 'ss -ltn | grep :22 | head -2 || true'],
];
for (const [name, command] of facts) {
  const { output } = await serial.run(command, { check: false });
  console.log(`${name}: ${output}`);
}
serial.close();
console.log('VM ready');
