// Runs scripts/judge.mjs on real Linux, inside the Debian VM, the way a judge would: as an ordinary
// user with no root, from a fresh copy of the repository.
//   node scripts/vm/judge-on-linux.mjs <testnet-account>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Serial } from './serial.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const account = process.argv[2];
const credentials = fs.readFileSync(path.join(os.homedir(), '.near-credentials', 'testnet', `${account}.json`), 'utf8');

const archive = path.join(os.tmpdir(), `sublet-${Date.now()}.tgz`);
execFileSync('git', ['archive', '--format=tar.gz', '-o', archive, 'HEAD'], { cwd: root });
console.log(`archive of HEAD: ${(fs.statSync(archive).size / 1024).toFixed(0)} KB`);

// QEMU's user networking shows the host's loopback to the guest as 10.0.2.2.
const server = http.createServer((request, response) => {
  if (request.url === '/repo.tgz') fs.createReadStream(archive).pipe(response);
  else if (request.url === '/credentials') response.end(credentials);
  else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const serial = new Serial();
await serial.connect();
await serial.login();
const quiet = { timeoutMs: 590_000 };
console.log('installing the official Node tarball...');
const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
const version = index.find((release) => release.version.startsWith('v22.')).version;
await serial.run(`test -x /opt/node/bin/node || (mkdir -p /opt/node && curl -fsSL https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.gz | tar xz -C /opt/node --strip-components=1 && ln -sf /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /usr/local/bin/)`, quiet);
console.log('node', (await serial.run('node --version')).output);
await serial.run('id judge >/dev/null 2>&1 || useradd -m -s /bin/bash judge');
await serial.run('rm -rf /home/judge/repo /home/judge/.near-credentials /home/judge/.sublet');
const asJudge = (command, options) => serial.run(`runuser -u judge -- sh -c '${command.replaceAll("'", "'\\''")}'`, options);
await asJudge('mkdir -p ~/repo ~/.near-credentials/testnet');
await asJudge(`curl -fsS http://10.0.2.2:${port}/repo.tgz | tar xz -C ~/repo`);
await asJudge(`curl -fsS http://10.0.2.2:${port}/credentials > ~/.near-credentials/testnet/${account}.json`);
console.log('installing dependencies from the lockfile...');
await asJudge('cd ~/repo/cli && npm ci --no-audit --no-fund --omit=dev >/dev/null 2>&1', quiet);
console.log('running the judge script as an ordinary user...\n');
const contract = process.env.SUBLET_CONTRACT;
const prefix = contract ? `SUBLET_CONTRACT=${contract} ` : '';
const { output, code } = await asJudge(`cd ~/repo && ${prefix}SUBLET_ACCOUNT=${account} node scripts/judge.mjs 2>&1`, { timeoutMs: 400_000, check: false });
console.log(output);
serial.close();
server.close();
fs.rmSync(archive, { force: true });
process.exit(code);
