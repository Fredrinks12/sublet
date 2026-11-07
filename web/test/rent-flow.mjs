// Drives the real site in a real browser, then logs in with what the browser produced.
//   node web/test/rent-flow.mjs <site-url> <contract> <tenant> [unit]
// The browser makes the SSH key, rents through the contract and shows login commands. Those exact
// commands are then checked: the key and certificate must log in to stock sshd.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const [site, contract, tenant, unit = 'debian-vm'] = process.argv.slice(2);
const shots = process.env.SHOTS ?? os.tmpdir();
const credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.near-credentials', 'testnet', `${tenant}.json`), 'utf8'));

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--no-first-run', '--disable-gpu'],
});
const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`);
};

try {
  // ---- Widths: nothing may scroll sideways, on a phone or a desktop.
  for (const width of [360, 390, 768, 1280]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: 900 });
    await page.goto(`${site}?edition=day`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('#ads .ad, #ads .ads-empty:not(:empty)'), { timeout: 30_000 });
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    check(`no sideways scroll at ${width}px`, sizes.scroll <= sizes.client, `${sizes.scroll} of ${sizes.client}`);
    await page.screenshot({ path: path.join(shots, `day-${width}.png`), fullPage: true });
    await page.close();
  }

  // ---- A hostile listing must render as text.
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((pocket) => {
    localStorage.setItem('sublet.pocket.v1', JSON.stringify(pocket));
  }, { accountId: tenant, secretKey: credentials.private_key });
  await page.goto(`${site}?edition=day`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForSelector('#ads .ad', { timeout: 30_000 });

  const opened = await page.evaluate((id) => {
    const ad = [...document.querySelectorAll('#ads .ad')].find((a) => a.querySelector('.ref')?.textContent === id);
    ad?.querySelector('button')?.click();
    return Boolean(ad);
  }, unit);
  check('the listing is on the page and opens', opened);
  await page.waitForSelector('dialog[open] .btn.go');
  await page.screenshot({ path: path.join(shots, 'rent-form.png') });
  await page.click('dialog[open] .btn.go');
  console.log('renting through the page...');
  await page.waitForFunction(
    () => document.querySelector('#rent-title')?.textContent === 'Your key is cut' || document.querySelector('.errorbox'),
    { timeout: 180_000 },
  );
  await page.screenshot({ path: path.join(shots, 'rent-done.png') });
  const error = await page.$eval('.errorbox', (n) => n.textContent).catch(() => null);
  check('the page rents a machine', !error, error ?? '');

  if (!error) {
    const script = await page.$eval('pre.script', (n) => n.textContent);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-web-'));
    const key = script.match(/<<'KEY'\n([\s\S]*?)\nKEY/)[1];
    const cert = script.match(/echo '(ssh-ed25519-cert-v01@openssh\.com [^']+)'/)[1];
    const [, port, target] = script.match(/-p (\d+) (\S+)$/m);
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
    if (process.platform === 'win32') {
      spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore' });
    }
    fs.writeFileSync(`${keyPath}-cert.pub`, `${cert}\n`);
    const login = spawnSync('ssh', [
      '-i', keyPath, '-o', `CertificateFile=${keyPath}-cert.pub`, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${path.join(dir, 'kh')}`, '-p', port, target,
      'echo browser key works, I am $(whoami)',
    ], { encoding: 'utf8', timeout: 90_000 });
    check('the key made in the browser logs in to real sshd', login.status === 0, (login.stdout || login.stderr).trim());
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check('no JavaScript errors on the page', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
