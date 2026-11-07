// Renders the demo film from real data: the transcript of a real lease, and numbers read from the
// repository. Every frame is drawn by a real browser, then encoded with ffmpeg.
//   node render.mjs <out.mp4> [repo-url]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const out = process.argv[2] ?? path.join(here, 'sublet-demo.mp4');
const repo = process.argv[3] ?? 'github.com/your-team/sublet';
const FPS = 24;

const transcript = JSON.parse(fs.readFileSync(path.join(root, 'demo', 'transcript.json'), 'utf8'));
const lab = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'attack-lab-results.json'), 'utf8'));
const tests = (fs.readFileSync(path.join(root, 'contract', 'src', 'tests.rs'), 'utf8').match(/#\[test\]/g) ?? []).length
  + (fs.readFileSync(path.join(root, 'contract', 'src', 'ssh.rs'), 'utf8').match(/#\[test\]/g) ?? []).length
  + (fs.readFileSync(path.join(root, 'contract', 'src', 'evm.rs'), 'utf8').match(/#\[test\]/g) ?? []).length;
const keys = process.env.FILM_KEYS ?? '0';
const film = { lines: transcript.lines, keys, attacks: lab.stopped, tests, repo };

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--no-first-run', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.evaluateOnNewDocument((data) => { window.FILM = data; }, film);
await page.goto(pathToFileURL(path.join(here, 'film.html')).href, { waitUntil: 'networkidle2', timeout: 60_000 });
await page.evaluate(() => document.fonts.ready);
const length = await page.evaluate(() => window.FILM_LENGTH);

const encoder = spawn(ffmpeg, [
  '-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  // X requires an audio track on some uploads, so add a silent one.
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-shortest',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '64k', out,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const finished = new Promise((resolve, reject) => {
  encoder.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});

const frames = Math.round(length * FPS);
let last = '';
for (let i = 0; i < frames; i += 1) {
  await page.evaluate((t) => window.seek(t), i / FPS);
  const frame = await page.screenshot({ type: 'jpeg', quality: 90 });
  if (!encoder.stdin.write(frame)) await new Promise((resolve) => encoder.stdin.once('drain', resolve));
  const percent = `${Math.floor((i / frames) * 10) * 10}%`;
  if (percent !== last) {
    console.log(percent);
    last = percent;
  }
}
encoder.stdin.end();
await finished;
await browser.close();
const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`wrote ${out}, ${size} MB, ${length}s at ${FPS} fps`);
