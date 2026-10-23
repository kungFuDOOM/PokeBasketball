// Renders a preview MP3 of each background music track with the game's own synth, in headless Chrome
// (OfflineAudioContext). Needs Playwright (or playwright-core plus CHROME=/path/to/chrome) and ffmpeg.
// The preview is boosted (+8 dB) so it is easy to hear on a phone; in game the music sits under the effects.
// Usage: node scripts/render-music.mjs [outDir] [seconds]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const out = process.argv[2] ?? 'trailer-out/music';
const secs = Number(process.argv[3]) || 26;
mkdirSync(out, { recursive: true });

const entry = `
import { SONGS, loopNotes } from './src/music/songs';
import { makeKit, playNote } from './src/music/synth';
import { stepDur, swingAt } from './src/music/music';
window.renderSong = async (id, secs) => {
  const s = SONGS[id];
  const rate = 44100;
  const ctx = new OfflineAudioContext(1, Math.ceil(rate * (secs + 1)), rate);
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  bus.connect(ctx.destination);
  const g = ctx.createGain();
  g.connect(bus);
  const sd = stepDur(s);
  const kit = makeKit(ctx, g, sd);
  const { steps, notes } = loopNotes(s);
  for (let loop = 0; loop * steps * sd < secs; loop++)
    for (const n of notes) {
      const t = 0.05 + (loop * steps + n.step) * sd + swingAt(s, n.step);
      if (t < secs) playNote(kit, n, t, sd);
    }
  g.gain.setValueAtTime(1, secs - 1.5);
  g.gain.linearRampToValueAtTime(0, secs);
  const buf = await ctx.startRendering();
  return Array.from(buf.getChannelData(0));
};`;
const js = (await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' })).outputFiles[0].text;

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage();
await page.setContent('<html><body></body></html>');
await page.addScriptTag({ content: js });
const ids = ['menu', 'draft', 'season'];
for (const id of ids) {
  const pcm = await page.evaluate(([i, s]) => window.renderSong(i, s), [id, secs]);
  const n = pcm.length;
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  const wavPath = `${out}/${id}.wav`;
  writeFileSync(wavPath, wav);
  const mp3 = `${out}/pokejam-music-${id}.mp3`;
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-af', 'volume=2.5', '-t', String(secs), '-codec:a', 'libmp3lame', '-b:a', '128k', mp3], { stdio: 'inherit' });
  spawnSync('rm', [wavPath]);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  console.log(`${mp3} (peak ${peak.toFixed(2)})`);
}
await browser.close();
