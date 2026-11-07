// Nobody here can listen to the narration, so this checks it another way: a separate speech
// recognition model transcribes each line, and the words it heard are compared with the script.
//   node check-voice.mjs [file.wav]
//
// Each line is cut out using the caption timings, so a good score on the finished video's audio also
// shows that the voice lines up with the captions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from '@huggingface/transformers';

const here = path.dirname(fileURLToPath(import.meta.url));
const timeline = JSON.parse(fs.readFileSync(path.join(here, 'out', 'timeline.json'), 'utf8'));
const wav = fs.readFileSync(process.argv[2] ?? path.join(here, 'out', 'voice.wav'));
const rate = wav.readUInt32LE(24);
const dataAt = wav.indexOf('data', 12) + 8;
const samples = new Float32Array(Math.floor((wav.length - dataAt) / 2));
for (let i = 0; i < samples.length; i += 1) samples[i] = wav.readInt16LE(dataAt + i * 2) / 32768;

function slice16k(start, end) {
  const from = Math.floor(start * rate);
  const to = Math.ceil(end * rate);
  const ratio = rate / 16000;
  const out = new Float32Array(Math.floor((to - from) / ratio));
  for (let i = 0; i < out.length; i += 1) out[i] = samples[from + Math.floor(i * ratio)];
  return out;
}

/** Writes both sides the same way, so "S S H", "SSH" and "ssh" all compare equal. */
const words = (text) => text
  .toLowerCase()
  .replace(/thirty-seven/g, '37')
  .replace(/\ba\.?\s?i\b/g, 'ai')
  .replace(/\b([a-z])\.\s?/g, '$1')
  .replace(/\b(s) (s) (h)\b/g, 'ssh')
  .replace(/[^a-z0-9' ]/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

function similarity(a, b) {
  const table = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) table[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - table[a.length][b.length] / Math.max(a.length, b.length);
}

console.log('loading the speech recognition model...');
const listen = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' });

let total = 0;
const low = [];
for (const line of timeline.lines) {
  const { text } = await listen(slice16k(line.start, line.end + 0.1));
  const score = similarity(words(line.text), words(text));
  total += score;
  if (score < 0.8) low.push({ line, heard: text.trim(), score });
  console.log(`${score >= 0.8 ? 'ok  ' : 'LOOK'} ${(score * 100).toFixed(0).padStart(3)}%  ${text.trim().slice(0, 90)}`);
}
console.log(`\naverage match ${((total / timeline.lines.length) * 100).toFixed(1)}%, ${low.length} of ${timeline.lines.length} lines to look at`);
for (const { line, heard } of low) console.log(`\nscript: ${line.text}\nheard:  ${heard}`);
