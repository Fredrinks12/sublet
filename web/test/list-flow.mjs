// Drives the "List a machine" form in a real browser, including its refusals.
//   node web/test/list-flow.mjs <site-url> <contract> <account>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const [site, , account] = process.argv.slice(2);
const shots = process.env.SHOTS ?? os.tmpdir();
const credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.near-credentials', 'testnet', `${account}.json`), 'utf8'));

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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((pocket) => {
    localStorage.setItem('sublet.pocket.v1', JSON.stringify(pocket));
  }, { accountId: account, secretKey: credentials.private_key });
  await page.goto(`${site}?edition=day`, { waitUntil: 'networkidle2', timeout: 60_000 });

  const fill = async (fields) => {
    for (const [name, value] of Object.entries(fields)) {
      await page.$eval(`#list-${name}`, (input) => { input.value = ''; });
      await page.type(`#list-${name}`, value);
    }
  };
  const submitAndWait = async () => {
    await page.click('dialog[open] .btn.go');
    await page.waitForFunction(
      () => document.querySelector('.listing .errorbox') || document.querySelector('#rent-title')?.textContent.endsWith('is listed'),
      { timeout: 120_000 },
    );
    return page.$eval('.listing .errorbox', (n) => n.textContent).catch(() => null);
  };

  await page.click('#list-machine');
  await page.waitForSelector('dialog[open] form.listing');
  await page.screenshot({ path: path.join(shots, 'list-form.png') });

  const id = `form-${Date.now().toString(36)}`;
  await fill({ id, title: 'Listed through the form', blurb: '<img src=x onerror=alert(1)> hostile text', host: '198.51.100.9', principal: 'root' });
  const asRoot = await submitAndWait();
  check('the form explains why root is refused', /root/i.test(asRoot ?? ''), asRoot ?? 'no error shown');

  await fill({ principal: 'tenant' });
  await page.$eval('#list-price', (input) => { input.value = '0.025'; });
  const refused = await submitAndWait();
  check('a valid listing goes through', !refused, refused ?? '');
  await page.screenshot({ path: path.join(shots, 'list-done.png') });
  const setup = await page.$eval('pre.script', (n) => n.textContent);
  check('the owner gets the server commands', setup.includes('TrustedUserCAKeys') && setup.includes('ssh-ed25519 '));

  await page.keyboard.press('Escape');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#ads .ad');
  const ad = await page.evaluate((unit) => {
    const node = [...document.querySelectorAll('#ads .ad')].find((a) => a.querySelector('.ref')?.textContent === unit);
    return node ? { price: node.querySelector('.price').textContent, blurb: node.querySelector('.blurb').textContent, images: node.querySelectorAll('img').length } : null;
  }, id);
  check('the new listing appears with an exact price', ad?.price.startsWith('0.025 NEAR'), ad?.price);
  check('hostile listing text is shown as text, not run', ad?.blurb.includes('<img') && ad.images === 0, ad?.blurb);
  check('no JavaScript errors on the page', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
}
console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'ALL PASSED');
process.exit(failures.length ? 1 : 0);
