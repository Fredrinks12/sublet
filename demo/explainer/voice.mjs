// Turns script.json into one narration track and a timeline the film follows, so pictures and voice
// stay in step. The voice is Kokoro, an Apache 2.0 model that runs on this machine.
//   node voice.mjs [voice] [dtype]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KokoroTTS } from 'kokoro-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const voice = process.argv[2] ?? 'af_heart';
const dtype = process.argv[3] ?? 'fp32';
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

const script = JSON.parse(fs.readFileSync(path.join(here, 'script.json'), 'utf8'));

const LEAD_IN = 0.7;
const BETWEEN_LINES = 0.3;
const BETWEEN_SCENES = 0.8;
const TAIL = 1.6;
const SPEED = 1.04;

/**
 * Written forms the voice would misread. Captions keep the written form. AWS and AI are left out on
 * purpose: a speech recogniser heard them perfectly as written, and worse when spaced out.
 */
const SPOKEN = [
  [/OpenSSH/g, 'open S S H'],
  [/\bSSH\b/g, 'S S H'],
  [/\bMPC\b/g, 'M P C'],
  [/\bMCP\b/g, 'M C P'],
  [/\bUSDC\b/g, 'U S D C'],
  [/NEAR's/g, "Near's"],
  [/\bNEAR\b/g, 'Near'],
];
const spoken = (text) => SPOKEN.reduce((line, [pattern, replacement]) => line.replace(pattern, replacement), text);

console.log(`loading Kokoro (${dtype}), voice ${voice}...`);
const t0 = Date.now();
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype, device: 'cpu' });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const chunks = [];
const timeline = [];
let rate = 24000;
let clock = LEAD_IN;
const silence = (seconds) => new Float32Array(Math.round(seconds * rate));
chunks.push(silence(LEAD_IN));

let index = 0;
for (let s = 0; s < script.length; s += 1) {
  const { scene, lines } = script[s];
  for (let l = 0; l < lines.length; l += 1) {
    const text = lines[l];
    const started = Date.now();
    const result = await tts.generate(spoken(text), { voice, speed: SPEED });
    rate = result.sampling_rate;
    const audio = result.audio;
    const seconds = audio.length / rate;
    timeline.push({ i: index, scene, text, start: Number(clock.toFixed(3)), end: Number((clock + seconds).toFixed(3)) });
    chunks.push(audio);
    clock += seconds;
    const gap = l === lines.length - 1 ? BETWEEN_SCENES : BETWEEN_LINES;
    chunks.push(silence(gap));
    clock += gap;
    index += 1;
    console.log(`${String(index).padStart(2)} ${seconds.toFixed(1)}s (made in ${((Date.now() - started) / 1000).toFixed(0)}s) ${text.slice(0, 60)}`);
  }
}
chunks.push(silence(TAIL));
const total = clock + TAIL;

const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + samples * 2, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
let at = 44;
for (const chunk of chunks) {
  for (const sample of chunk) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), at);
    at += 2;
  }
}
fs.writeFileSync(path.join(out, 'voice.wav'), wav);
fs.writeFileSync(path.join(out, 'timeline.json'), `${JSON.stringify({ voice, total: Number(total.toFixed(3)), lines: timeline }, null, 2)}\n`);
console.log(`total ${total.toFixed(1)}s, ${timeline.length} lines`);
