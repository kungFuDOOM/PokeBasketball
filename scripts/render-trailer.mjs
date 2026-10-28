// Renders a trailer cut to trailer-out/<cut>/poke-jam-<cut>.mp4 (the launch trailer: trailer-out/poke-jam-trailer.mp4).
// Needs Playwright (with a Chromium) and ffmpeg (libx264 + aac) on the machine, plus python3 with numpy
// for the soundtrack. Usage: node scripts/render-trailer.mjs [--cut main|vertical|franchise|top5|online|watch] [--frames N] [--silent]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] ?? true;
};
const cut = arg('--cut') || 'main';
const OUT = cut === 'main' ? 'trailer-out' : `trailer-out/${cut}`;
mkdirSync(OUT, { recursive: true });

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://localhost:5199/trailer.html?cut=${cut}`);
await page.waitForFunction(() => !!window.trailer);
const [w, h] = await page.evaluate(() => window.trailer.size);
await page.setViewportSize({ width: w, height: h });
console.log('Scanning seeded games for highlights…');
const info = await page.evaluate(() => window.trailer.prepare());
const frames = Math.min(info.frames, Number(arg('--frames')) || Infinity);
console.log(`Rendering ${frames} frames at ${info.fps} fps (${(frames / info.fps).toFixed(1)}s)`);

const video = `${OUT}/video.mp4`;
const ff = spawn('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(info.fps), '-c:v', 'mjpeg', '-i', '-',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', video,
], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((resolve) => ff.on('close', resolve));

for (let i = 0; i < frames; i++) {
  const b64 = await page.evaluate((n) => {
    window.trailer.renderFrame(n);
    return document.querySelector('#stage').toDataURL('image/jpeg', 0.95).split(',')[1];
  }, i);
  if (!ff.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 150 === 0) console.log(`  frame ${i}/${frames}`);
}
ff.stdin.end();
await done;

const cues = await page.evaluate(() => window.trailer.getCues());
writeFileSync(`${OUT}/cues.json`, JSON.stringify({ duration: frames / info.fps, style: cut, cues }, null, 1));
await browser.close();
await server.close();

const final = cut === 'main' ? `${OUT}/poke-jam-trailer.mp4` : `${OUT}/poke-jam-${cut}.mp4`;
if (arg('--silent')) {
  console.log(`Video only: ${video}`);
} else {
  console.log('Scoring the soundtrack…');
  const audio = spawnSync('python3', ['scripts/trailer-audio.py', `${OUT}/cues.json`, `${OUT}/audio.wav`], { stdio: 'inherit' });
  if (audio.status !== 0) process.exit(audio.status ?? 1);
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', `${OUT}/audio.wav`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], { stdio: 'inherit' });
  console.log(`Done: ${final}`);
}
