// Records a synthetic animated canvas in headless Chromium two ways and measures frame PTS gaps with ffprobe:
//   unpaced: paint every rAF, captureStream(30)   paced: paint at 30fps via the same gate, captureStream(0)+requestFrame
// Usage: node scripts/clip-pacing-check.mjs   (needs /usr/bin/google-chrome, ffprobe, playwright-core)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'clip-'));
const gate = `
const INT = 1000 / 30, SL = 1.5; let next = null;
const accept = (n) => { if (next !== null && n < next - SL) return false; next = next === null || n - next >= INT ? n + INT : next + INT; return true; };`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu', '--disable-frame-rate-limit'] });
const page = await browser.newPage();
await page.goto('about:blank');
const record = (mode) => page.evaluate(async ({ mode, gate }) => {
  eval(gate.replace(/const /g, 'var ')); // eslint-disable-line no-eval
  const c = document.createElement('canvas'); c.width = 960; c.height = 540; document.body.appendChild(c);
  const x = c.getContext('2d');
  const paced = mode === 'paced';
  const stream = c.captureStream(paced ? 0 : 30);
  const track = stream.getVideoTracks()[0];
  const manual = paced && typeof track.requestFrame === 'function';
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 7e6 });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();
  const t0 = performance.now(); let paints = 0;
  await new Promise((res) => {
    const tick = (now) => {
      if (!paced || accept(now)) {
        paints++;
        x.fillStyle = '#123'; x.fillRect(0, 0, 960, 540);
        for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${i * 9},80%,60%)`; x.fillRect((now / 3 + i * 23) % 900, 20 + i * 12, 40, 10); }
        if (manual) track.requestFrame();
      }
      if (now - t0 > 6000) return res(); requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop(); await done;
  const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return { b64: btoa(Array.from(buf, (b) => String.fromCharCode(b)).join('')), paints, manual };
}, { mode, gate });

for (const mode of ['unpaced', 'paced']) {
  const r = await record(mode);
  const f = join(dir, `${mode}.webm`);
  writeFileSync(f, Buffer.from(r.b64, 'base64'));
  const fixed = f + '.mkv';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', f, '-c', 'copy', fixed]);
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', fixed]).toString();
  const t = out.split('\n').filter(Boolean).map((l) => Number(l.split(',')[0])).sort((a, b) => a - b);
  const gaps = t.slice(1).map((v, i) => (v - t[i]) * 1000);
  const tiny = gaps.filter((g) => g < 10).length;
  console.log(`${mode}: paints=${r.paints} manualRequestFrame=${r.manual} frames=${t.length} avgFps=${(t.length / (t.at(-1) - t[0])).toFixed(1)} gaps<10ms=${tiny} maxGap=${Math.max(...gaps).toFixed(1)}ms`);
}
await browser.close();
