// Rank Shield screenshots: the ranked hub with the shield chip and weekly card, and the post-match "saved" line, at the
// three phone sizes we support. VIEWPORT shots (not full page): what you see is what a player sees without scrolling.
// No backend: the dev demo screens (src/multiplayer/ranked/devDemo.ts, ?rankeddemo=<name>) render made-up server answers.
//
//   node scripts/shield-shots.mjs                      (starts its own vite dev server on :5199)
//   SHIELD_BASE=http://localhost:5173 node scripts/shield-shots.mjs   (use a server that is already running)
//
// Env: SHIELD_SHOTS (output dir, default /workspace/pj-shield-shots), CHROME (Chrome/Chromium binary).
// Prints, per shot, whether the page scrolls sideways or vertically (a landscape menu should do neither).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const OUT = process.env.SHIELD_SHOTS ?? '/workspace/pj-shield-shots';
const CHROME = process.env.CHROME ?? '/opt/google/chrome/chrome';
const SIZES = [[844, 390], [932, 430], [390, 844]];
// name -> demo screen. Add 'shop' here in PR B.
const SHOTS = {
  hub: 'shield-hub',
  'hub-armed': 'shield-hub-armed',
  'hub-locked': 'shield-hub-locked',
  'hub-used': 'shield-hub-used',
  'hub-placing': 'shield-hub-placing',
  'hub-done': 'shield-hub-done',
  queue: 'shield-queue',
  postmatch: 'post-saved',
  'postmatch-kept': 'post-kept',
};
mkdirSync(OUT, { recursive: true });

let server = null;
let base = process.env.SHIELD_BASE;
if (!base) {
  base = 'http://localhost:5199';
  server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { env: { ...process.env, VITE_MODE_RANKED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { bad++; console.log(`  page error: ${e.message}`); });
    for (const [name, screen] of Object.entries(SHOTS)) {
      await page.goto(`${base}/?ranked=1&rankeddemo=${screen}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.card, .menu', { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      const m = await page.evaluate(() => {
        const d = document.documentElement;
        const off = [...document.querySelectorAll('.rk-item, .rk-weekly, .rk-chip, .rk-post, .rk-queue-tag, .rk-right .btn')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; }).length;
        return { sx: d.scrollWidth - innerWidth, sy: d.scrollHeight - innerHeight, off };
      });
      const flag = m.sx > 0 || m.off > 0 ? 'OVERFLOW-X' : m.sy > 0 ? `scrolls ${m.sy}px` : 'fits';
      if (m.sx > 0 || m.off > 0) bad++;
      console.log(`${w}x${h} ${name}: ${flag}`);
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
