// Screenshots the finished-clip modal (showClip) at iPhone portrait/landscape and desktop, using the mp4 from clip-webcodecs-check.mjs.
// Usage: node scripts/clip-modal-shots.mjs [outDir]   (WebKit is tried once; Chromium is the fallback)
import { chromium, webkit } from 'playwright-core';
import { createServer } from 'vite';
import { readFileSync, existsSync } from 'node:fs';

const out = process.argv[2] ?? '/workspace/pj-potg-wc-shots';
const mp4 = readFileSync(`${out}/potg-webcodecs.mp4`).toString('base64');
const png = readFileSync(`${out}/potg-webcodecs-midframe.png`).toString('base64');
const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' });
await server.listen();
let engine = 'chromium', browser;
try { browser = await webkit.launch(); engine = 'webkit'; } catch (e) { console.log('webkit unavailable:', String(e.message).split('\n')[0]); }
if (!browser) browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
console.log('engine', engine);
const sizes = [['iphone-portrait-390x844', 390, 844, true], ['iphone-landscape-932x430', 932, 430, true], ['desktop-1280x800', 1280, 800, false]];
for (const [name, width, height, touch] of sizes) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  if (touch) await page.addInitScript(() => { navigator.share = async () => {}; navigator.canShare = () => true; });
  await page.goto('http://localhost:5198/');
  const info = await page.evaluate(async ({ mp4, png }) => {
    const bin = Uint8Array.from(atob(mp4), (c) => c.charCodeAt(0));
    const file = new File([bin], 'pokejam-play-of-the-game.mp4', { type: 'video/mp4' });
    const { showClip } = await import('/src/ui/shareButton.ts');
    const { clipPosters } = await import('/src/ui/clipFormat.ts');
    clipPosters.set(file, 'data:image/png;base64,' + png);
    showClip(file, 'GENGAR hit a game winner on PokeJam');
    await new Promise((r) => setTimeout(r, 1500));
    const card = document.querySelector('.clip-card').getBoundingClientRect();
    const btns = [...document.querySelectorAll('.clip-actions .btn')].filter((b) => !b.hidden && getComputedStyle(b).display !== 'none');
    return { labels: btns.map((b) => b.textContent.trim()), cardFits: card.top >= 0 && card.bottom <= innerHeight && card.left >= 0 && card.right <= innerWidth,
      btnsInView: btns.every((b) => { const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }), videoErr: !!document.querySelector('video')?.error };
  }, { mp4, png });
  await page.screenshot({ path: `${out}/clip-modal-${name}.png` });
  console.log(name, JSON.stringify(info));
  await ctx.close();
}
await browser.close(); await server.close();
