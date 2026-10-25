// Keys a trophy picture shot on a solid magenta background into a trimmed transparent PNG.
//   node scripts/key-trophy.mjs <input.jpg> [output.png] [height]
// Uses a headless Chrome canvas for decoding/encoding (no image dependency in the repo): set PLAYWRIGHT_CORE and
// CHROME when playwright and Chrome are not where this script expects them.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const CORE_FALLBACK = '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core';
let pw;
try { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright'); } catch {
  try { pw = require('playwright-core'); } catch { pw = require(CORE_FALLBACK); }
}
const [input, output = new URL('../public/sprites/trophy.png', import.meta.url).pathname, height = '256'] = process.argv.slice(2);
if (!input) throw new Error('usage: node scripts/key-trophy.mjs <input.jpg> [output.png] [height]');

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/opt/google/chrome/chrome' });
const page = await browser.newPage();
const dataUrl = `data:image/jpeg;base64,${readFileSync(input).toString('base64')}`;
const png = await page.evaluate(async ({ dataUrl, outH }) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const im = ctx.getImageData(0, 0, W, H);
  const d = im.data;

  // Background colour = median of a thin border (the JPEG is noisy, so no single pixel is trusted).
  const med = (ch) => {
    const v = [];
    for (let x = 0; x < W; x += 3) { v.push(d[(x) * 4 + ch], d[((H - 1) * W + x) * 4 + ch]); }
    for (let y = 0; y < H; y += 3) { v.push(d[(y * W) * 4 + ch], d[(y * W + W - 1) * 4 + ch]); }
    v.sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const bg = [med(0), med(1), med(2)];

  // Tolerant colour-distance key with a soft ramp: <T0 is background, >T1 is solid trophy.
  const T0 = 100, T1 = 170;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
    let a = (dist - T0) / (T1 - T0);
    a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
    if (a > 0 && a < 1) {
      // Edge pixel: remove the background's share of the colour (un-premultiply against the key colour).
      for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - (1 - a) * bg[k]) / a));
    }
    if (a > 0) {
      // Despill: gold and brown never have more blue than green; magenta does. Cap blue, and pull red toward green on edges.
      if (d[i + 2] > d[i + 1]) d[i + 2] = d[i + 1];
      if (a < 1) {
        const lim = d[i + 1] * 1.3 + 12;
        if (d[i] > lim) d[i] = lim;
      }
    }
    d[i + 3] = Math.round(a * 255);
  }
  // Drop specks of low alpha (JPEG noise) that are not part of anything.
  const al = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) al[p] = d[p * 4 + 3];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    if (al[p] === 0 || al[p] > 200) continue;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (al[(y + dy) * W + x + dx] > 128 && y + dy >= 0) n++;
    if (n < 3) d[p * 4 + 3] = 0;
  }
  ctx.putImageData(im, 0, 0);

  // Trim to the visible bounds (ignoring faint alpha).
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;
  const oh = Number(outH), ow = Math.round((tw * oh) / th);
  // Step down in halves so the pixel art stays crisp-ish and the alpha edge stays smooth.
  let cur = document.createElement('canvas');
  cur.width = tw; cur.height = th;
  cur.getContext('2d').drawImage(c, x0, y0, tw, th, 0, 0, tw, th);
  while (cur.height / 2 > oh) {
    const n = document.createElement('canvas');
    n.width = Math.round(cur.width / 2); n.height = Math.round(cur.height / 2);
    const g = n.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, n.width, n.height);
    cur = n;
  }
  const out = document.createElement('canvas');
  out.width = ow; out.height = oh;
  const og = out.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(cur, 0, 0, ow, oh);
  return { url: out.toDataURL('image/png'), bg, size: [ow, oh] };
}, { dataUrl, outH: height });
await browser.close();
writeFileSync(output, Buffer.from(png.url.split(',')[1], 'base64'));
console.log('keyed against', JSON.stringify(png.bg), '→', output, png.size.join('x'));
