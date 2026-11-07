// Renders the narrated explainer. The picture follows out/timeline.json, so it stays in step with
// the voice, and every claim is checked against real data before a frame is drawn.
//   node render.mjs <out.mp4>           the whole film
//   node render.mjs --stills 3,20,40    a few frames, for checking the layout
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const FPS = 24;

const stillsAt = process.argv.indexOf('--stills');
const stills = stillsAt >= 0 ? process.argv[stillsAt + 1].split(',').map(Number) : null;
const out = stillsAt >= 0 ? null : process.argv[2] ?? path.join(here, 'out', 'sublet-explainer.mp4');
const stillsDir = process.env.STILLS ?? path.join(here, 'out', 'stills');

const read = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const timeline = read(here, 'out', 'timeline.json');
const transcript = read(root, 'demo', 'transcript.json');
const lab = read(root, 'docs', 'attack-lab-results.json');

async function rpcView(method, args) {
  const response = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: 'sublet.testnet', method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const body = await response.json();
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

async function accessKeyCount() {
  const response = await fetch('https://test.rpc.fastnear.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: 'sublet.testnet' } }),
  });
  return (await response.json()).result.keys.length;
}

// The narration states these as facts, so the film refuses to render if they stop being true.
const spokenText = timeline.lines.map((l) => l.text).join(' ');
if (lab.stopped !== 37 || lab.total !== 37 || !spokenText.includes('thirty-seven')) {
  throw new Error(`The script says thirty-seven attacks, but the results say ${lab.stopped} of ${lab.total}.`);
}
const keys = await accessKeyCount();
if (keys !== 0 || !spokenText.includes('zero access keys')) throw new Error(`The script says zero keys, but the chain says ${keys}.`);
const unit = await rpcView('get_unit', { id: 'debian-vm' });
const trustLine = `${unit.ca_public_key.slice(0, 19)}... sublet:debian-vm`;
const film = { timeline, transcript, attacks: lab.stopped, keys, trustLine };
console.log(`checked: ${lab.stopped} attacks stopped, ${keys} keys, ${timeline.total.toFixed(1)}s long`);

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--no-first-run', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
await page.evaluateOnNewDocument((data) => { window.FILM = data; }, film);
await page.goto(pathToFileURL(path.join(here, 'film.html')).href, { waitUntil: 'networkidle2', timeout: 60_000 });
// Hidden scenes do not load their fonts until shown, which would flash a fallback mid-film.
await page.evaluate(async () => {
  const faces = ['400 20px "Archivo Black"', '700 20px Fraunces', '900 20px Fraunces', '400 20px "IBM Plex Mono"', '600 20px "IBM Plex Mono"', '400 20px "Source Serif 4"', '600 20px "Source Serif 4"'];
  await Promise.all(faces.map((face) => document.fonts.load(face, 'Sublet TO LET')));
  await document.fonts.ready;
});

if (stills) {
  fs.mkdirSync(stillsDir, { recursive: true });
  for (const t of stills) {
    await page.evaluate((time) => window.seek(time), t);
    await page.screenshot({ path: path.join(stillsDir, `at-${String(t).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 85 });
  }
  await browser.close();
  console.log(`wrote ${stills.length} stills to ${stillsDir}`);
  process.exit(0);
}

const silent = path.join(os.tmpdir(), `sublet-explainer-${process.pid}.mp4`);
const encoder = spawn(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', silent,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = new Promise((resolve, reject) => {
  encoder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});

// Most frames repeat the one before, so only draw a new one when something on screen has changed.
const frames = Math.ceil(timeline.total * FPS);
let last = null;
let previous = '';
let drawn = 0;
let reported = -1;
for (let i = 0; i < frames; i += 1) {
  const state = await page.evaluate((t) => {
    window.seek(t);
    return document.getElementById('stage').innerHTML.length + document.getElementById('caption').textContent
      + [...document.querySelectorAll('.scene, [data-at], .token, .cert, .line-h, .line-v, .sealed, .dot, .node, #lease span, #held')]
        .map((el) => el.style.cssText + el.className).join('|');
  }, i / FPS);
  if (state !== previous || !last) {
    last = await page.screenshot({ type: 'jpeg', quality: 92 });
    previous = state;
    drawn += 1;
  }
  if (!encoder.stdin.write(last)) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
  const tenth = Math.floor((i / frames) * 10);
  if (tenth !== reported) {
    console.log(`${tenth * 10}%, ${drawn} frames drawn`);
    reported = tenth;
  }
}
encoder.stdin.end();
await encoded;
await browser.close();

// Add the voice, levelled to the loudness social video expects.
await new Promise((resolve, reject) => {
  const mix = spawn(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-i', silent, '-i', path.join(here, 'out', 'voice.wav'),
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest', '-movflags', '+faststart', out,
  ], { stdio: 'inherit' });
  mix.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mix exited ${code}`))));
});
fs.rmSync(silent, { force: true });
console.log(`wrote ${out}, ${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${timeline.total.toFixed(1)}s, ${drawn} of ${frames} frames drawn`);
