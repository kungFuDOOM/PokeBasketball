// Ranked preset team pick screenshots: nothing chosen, a card tapped, and locked in waiting on the opponent, at the
// three phone sizes we support. VIEWPORT shots (not full page): what you see is what a player sees without scrolling.
// No backend: the dev demo screens (src/multiplayer/ranked/devDemo.ts, ?rankeddemo=<name>) render made-up data.
//
//   node scripts/preset-shots.mjs                      (starts its own vite dev server on a free port)
//   PRESET_BASE=http://localhost:5173 node scripts/preset-shots.mjs   (use a server that is already running)
//
// Env: PRESET_SHOTS (output dir, default /workspace/pj-preset-shots), CHROME (Chrome/Chromium binary).
// Prints, per shot, whether the page scrolls sideways or vertically (a landscape menu should do neither).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const OUT = process.env.PRESET_SHOTS ?? '/workspace/pj-preset-shots';
const CHROME = process.env.CHROME ?? '/usr/bin/google-chrome';
const SIZES = [[844, 390], [932, 430], [390, 844]];
const SHOTS = ['pick', 'pick-selected', 'pick-locked'];
mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let server = null;
let base = process.env.PRESET_BASE;
if (!base) {
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { env: { ...process.env, VITE_MODE_RANKED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('vite did not start')), 60_000);
    server.stdout.on('data', (d) => { if (String(d).includes('Local:')) { clearTimeout(t); resolve(); } });
    server.on('exit', (c) => reject(new Error(`vite exited (${c})`)));
  });
}

const browser = await chromium.launch({ executablePath: CHROME });
let bad = 0;
try {
  for (const [w, h] of SIZES) {
    const landscape = w > h;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { bad++; console.log(`  page error: ${e.message}`); });
    for (const name of SHOTS) {
      await page.goto(`${base}/?ranked=1&rankeddemo=${name}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.pp-card', { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      const m = await page.evaluate(() => {
        const d = document.documentElement;
        const outside = (el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.top < -0.5; };
        const cards = document.querySelectorAll('.pp-card').length;
        const off = [...document.querySelectorAll('.pp-card, .pp-bar, .pp-bar .btn, .pp-top, .pp-clock')].filter(outside).length;
        return { sx: d.scrollWidth - innerWidth, sy: d.scrollHeight - innerHeight, off, cards };
      });
      const over = m.sx > 0 || m.off > 0 || (landscape && m.sy > 0);
      const flag = m.sx > 0 ? `OVERFLOW-X ${m.sx}px` : m.sy > 0 ? `scrolls ${m.sy}px` : m.off > 0 ? `CLIPPED ${m.off} el` : 'fits';
      if (over || m.cards !== 6) bad++;
      console.log(`${w}x${h} ${name}: ${flag} (cards ${m.cards})`);
      await page.screenshot({ path: `${OUT}/${name}-${w}x${h}.png` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server?.kill();
}
console.log(`screenshots in ${OUT}`);
process.exit(bad ? 1 : 0);
