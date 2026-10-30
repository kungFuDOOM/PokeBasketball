// Screenshots of the pre-game intro (dev hook ?introshot=offline|online) on phone-sized viewports, with layout checks.
//
//   npm run dev &            (or let this script start vite itself)
//   node scripts/screenshot-intro.mjs
//
// Env: BASE (default http://localhost:5173), E2E_CHROME (Chrome/Chromium binary, default /usr/bin/google-chrome),
// SHOTS (default /workspace/pj-intro-shots). Exits 1 if a page scrolls or the Skip button is off screen.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const CHROME = process.env.E2E_CHROME ?? '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS ?? '/workspace/pj-intro-shots';
const VIEWPORTS = [
  [844, 390],
  [932, 430],
  [390, 844],
];
const MODES = ['offline', 'online'];

if (!existsSync(CHROME)) {
  console.log(`No browser at ${CHROME}; skipping intro screenshots.`);
  console.log('Manual steps: run `npm run dev`, open', `${BASE}/?introshot=offline and ${BASE}/?introshot=online`);
  console.log('in devtools device mode at 844x390, 932x430 and 390x844; check there is no scrollbar and the Skip');
  console.log('button sits fully on screen at the bottom. Or set E2E_CHROME to a Chrome/Chromium binary and re-run.');
  process.exit(0);
}

const up = async () => {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
};

let vite = null;
if (!(await up())) {
  const port = new URL(BASE).port || '5173';
  console.log(`Starting vite on port ${port}…`);
  vite = spawn('npx', ['vite', '--port', port, '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up())) {
    vite.kill();
    throw new Error(`vite did not come up at ${BASE}`);
  }
}

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

try {
  for (const [width, height] of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    for (const mode of MODES) {
      const tag = `${mode}-${width}x${height}`;
      await page.goto(`${BASE}/?introshot=${mode}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.intro-skip');
      await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      await page.screenshot({ path: `${SHOTS}/${tag}.png` });
      const m = await page.evaluate(() => {
        const r = document.querySelector('.intro-skip').getBoundingClientRect();
        return {
          scrollH: document.documentElement.scrollHeight,
          scrollW: document.documentElement.scrollWidth,
          innerH: innerHeight,
          innerW: innerWidth,
          skip: { top: r.top, left: r.left, bottom: r.bottom, right: r.right },
        };
      });
      check(`${tag} no vertical scroll`, m.scrollH <= m.innerH, `scrollHeight ${m.scrollH} vs ${m.innerH}`);
      check(`${tag} no horizontal scroll`, m.scrollW <= m.innerW, `scrollWidth ${m.scrollW} vs ${m.innerW}`);
      const s = m.skip;
      check(
        `${tag} skip button in viewport`,
        s.top >= 0 && s.left >= 0 && s.bottom <= m.innerH && s.right <= m.innerW,
        `${Math.round(s.left)},${Math.round(s.top)} → ${Math.round(s.right)},${Math.round(s.bottom)}`,
      );
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  vite?.kill();
}

console.log(failed ? `${failed} check(s) failed. Shots in ${SHOTS}` : `All checks passed. Shots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
