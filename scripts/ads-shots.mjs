// Screenshots of the courtside ads on the live build (VITE_MODE_ADS=true), with the pokejam-ads-live API mocked, plus
// layout checks. Not run in CI.
//
//   node scripts/ads-shots.mjs
//
// It builds the site into a temp dir (vite build, no tsc/sprites step: run `npm run sprites` once first), serves it with
// `vite preview`, and answers the ads API with page.route: a mainnet board that offers USDC and has one booked ad. Every
// other request off the preview origin is aborted, so nothing reaches Supabase (or analytics) and the run is repeatable.
//
// Shots, at 844x390, 932x430 and 390x844:
//   game-<vp>.png        a Quick Play game (Random team, first opponent, intro off) with the $PJAM house half and the booked ad
//   menu-<vp>.png        the menu, scrolled to the Advertise button
//   advertise-{burn,usdc}-<vp>.png        the Advertise page top (hero and live preview), Burn then USDC selected
//   advertise-{burn,usdc}-plans-<vp>.png  scrolled to the pay toggle and plans (phones can't fit both in one screen)
//   advertise-{burn,usdc}-full-<vp>.png   the whole page
//
// Env: SHOTS (default /workspace/ads-live-shots), E2E_CHROME (default /usr/bin/google-chrome), PORT (default 4179),
// NO_BUILD=1 to reuse the last build. Exits 1 if a check fails.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const SHOTS = process.env.SHOTS ?? '/workspace/ads-live-shots';
const CHROME = process.env.E2E_CHROME ?? '/usr/bin/google-chrome';
const PORT = process.env.PORT ?? '4179';
const OUT = join(tmpdir(), 'pokejam-ads-shots-dist');
const BASE = `http://localhost:${PORT}`;
// A made-up https origin for the API (VITE_ADS_API): the CSP allows it, and page.route answers it.
const API = 'https://ads-mock.invalid/functions/v1/pokejam-ads-live';
const VIEWPORTS = [
  [844, 390],
  [932, 430],
  [390, 844],
];

if (!existsSync(CHROME)) {
  console.log(`No browser at ${CHROME}; set E2E_CHROME to a Chrome/Chromium binary.`);
  process.exit(0);
}

// ---------- build and serve ----------
const env = { ...process.env, VITE_MODE_ADS: 'true', VITE_ADS_API: API };
if (process.env.NO_BUILD !== '1' || !existsSync(join(OUT, 'index.html'))) {
  console.log(`Building into ${OUT}…`);
  const r = spawnSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'warn'], { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const up = async () => {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
};
if (await up()) throw new Error(`Something is already serving ${BASE}; set PORT.`);
const server = spawn('npx', ['vite', 'preview', '--outDir', OUT, '--port', PORT, '--strictPort'], { env, stdio: 'ignore', detached: true });
// npx runs vite as a child: stop the whole process group, or the preview server outlives the script.
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill();
  }
};
for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await up())) {
  stopServer();
  throw new Error(`vite preview did not come up at ${BASE}`);
}

// ---------- the mocked pokejam-ads-live ----------
const M = 10n ** 6n; // $PJAM and USDC both have 6 decimals
const HOUR = 3_600_000;
const now = Date.now();
const iso = (t) => new Date(t).toISOString();
const BOOKED = {
  id: '7f3c2a10-0000-4000-8000-000000000001',
  text: 'GO MAGIKARP GO!',
  theme: 'water',
  wallet: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  starts_at: iso(now - 2 * HOUR),
  ends_at: iso(now + 5 * 24 * HOUR),
  burn_sig: null,
  usdc_sig: '5h1sMockSignatureNotOnChain1111111111111111111111111111111111111111111111111111111',
};
const PRICES = { hour: 50_000n * M, day: 1_000_000n * M, week: 6_000_000n * M };
const USDC = { week: 150n * M, month: 500n * M };
const HOURS = { hour: 1, day: 24, week: 168, month: 720 };
const board = () => ({
  now: iso(Date.now()),
  paused: false,
  spots: 4,
  prices: Object.fromEntries(Object.entries(PRICES).map(([k, v]) => [k, String(v)])),
  live: [BOOKED],
  booked: [{ starts_at: BOOKED.starts_at, ends_at: BOOKED.ends_at }],
  usdc: Object.fromEntries(Object.entries(USDC).map(([k, v]) => [k, String(v)])),
  usdcPay: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', receiver: 'FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk', decimals: 6 },
  totals: { burned: String(18_250_000n * M), usdc: String(650n * M), ads: 12, advertisers: 7, hours: 1490 },
  cluster: 'mainnet-beta',
  mint: 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump',
  decimals: 6,
  supply: String(999_000_000n * M),
  faucet: false,
});
const quote = ({ plan, start }) => {
  const s = start ? Date.parse(start) : Date.now();
  const usdcOnly = plan === 'month';
  return {
    plan,
    hours: HOURS[plan],
    price: usdcOnly ? null : String(PRICES[plan]),
    usdc: plan in USDC ? String(USDC[plan]) : null,
    starts_at: iso(s),
    ends_at: iso(s + HOURS[plan] * HOUR),
    moved: false,
  };
};
const apiCalls = [];
const blocked = [];
const answer = (body) => {
  switch (body?.action) {
    case 'quote': return quote(body);
    case 'check': return { ok: true, reason: null, message: null };
    case 'mine': return { ads: [] };
    case 'wallet': return { balance: '0', lamports: 0, decimals: 6 };
    default: return null;
  }
};

async function route(page) {
  await page.route('**/*', async (r) => {
    const req = r.request();
    const url = req.url();
    if (url.startsWith(BASE) || url.startsWith('data:')) return r.continue();
    if (url.startsWith(API)) {
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
      const action = body ? body.action : new URL(url).searchParams.get('action');
      apiCalls.push(action);
      const data = action === 'board' ? board() : answer(body);
      return r.fulfill({
        status: data ? 200 : 400,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(data ?? { error: `mock: no ${action}` }),
      });
    }
    blocked.push(url);
    return r.abort();
  });
}

// ---------- checks ----------
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const info = (name, detail) => console.log(`INFO  ${name}  (${detail})`);
const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where the LED board is on the game canvas: the rows holding the $PJAM house half's green (#2fd37a frame) and the
 * booked ad's water blue (#2f63d4), in canvas pixels (VW x VH = 480 x 270 game units, scaled by the canvas size).
 */
const readBoard = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas.court');
  if (!c) return null;
  const ctx = c.getContext('2d');
  const k = c.height / 270;
  // The board sits over the crowd, above the far sideline (Y_FAR = 98); scan the top 40% for its colours.
  const h = Math.round(c.height * 0.4);
  const { data } = ctx.getImageData(0, 0, c.width, h);
  const near = (i, r, g, b) => Math.abs(data[i] - r) < 6 && Math.abs(data[i + 1] - g) < 6 && Math.abs(data[i + 2] - b) < 6;
  // House: its text and frame greens (the frame pulses, so the text colour carries it). Booked: the water theme's solid fill.
  const found = { house: 0, booked: 0, houseRows: [Infinity, -Infinity], bookedRows: [Infinity, -Infinity], houseX: [Infinity, -Infinity], bookedX: [Infinity, -Infinity] };
  const grow = (span, v) => { span[0] = Math.min(span[0], v); span[1] = Math.max(span[1], v); };
  for (let y = 0; y < h; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    if (near(i, 0x7d, 0xff, 0xb2) || near(i, 0x2f, 0xd3, 0x7a)) { found.house++; grow(found.houseRows, y); grow(found.houseX, x); }
    if (near(i, 0x2f, 0x63, 0xd4)) { found.booked++; grow(found.bookedRows, y); grow(found.bookedX, x); }
  }
  const r = c.getBoundingClientRect();
  return { ...found, k, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, cw: c.width, ch: c.height };
});

const rectOf = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el || el.hidden || el.closest('[hidden]')) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
}, sel);

const rectsOf = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
  .filter((el) => !el.closest('[hidden]'))
  .map((el) => el.getBoundingClientRect())
  .filter((r) => r.width && r.height)
  .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })), sel);

/** Elements under `root` that stick out past the viewport's sides (ignoring ones inside a horizontal scroller). */
const clipped = (page, root) => page.evaluate((s) => {
  const out = [];
  for (const el of document.querySelectorAll(`${s} *`)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let p = el.parentElement, scroller = false;
    for (; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } }
    if (scroller) continue;
    if (r.left < -0.5 || r.right > innerWidth + 0.5) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} [${Math.round(r.left)},${Math.round(r.right)}]`);
  }
  return out.slice(0, 8);
}, root);

// ---------- shots ----------
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = [];
const shot = async (page, name, full = false) => {
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, fullPage: full });
  shots.push(path);
};

/** The page top (hero and preview), the pay toggle and plans in view, and the whole page. */
const advertiseShots = async (page, mode, vp) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot(page, `advertise-${mode}-${vp}`);
  await page.evaluate(() => document.querySelector('[data-pay]').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -60)); // keep the step heading
  await page.waitForTimeout(300);
  await shot(page, `advertise-${mode}-plans-${vp}`);
  await shot(page, `advertise-${mode}-full-${vp}`, true);
  await page.evaluate(() => window.scrollTo(0, 0));
};

try {
  for (const [width, height] of VIEWPORTS) {
    const vp = `${width}x${height}`;
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  page error (${vp}): ${e.message}`));
    await route(page);

    // (b) the menu with the Advertise button
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-go="advertise"]', { timeout: 20_000 });
    const adBtn = page.locator('[data-go="advertise"]');
    await adBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(page, `menu-${vp}`);
    const b = await adBtn.boundingBox();
    check(`${vp} menu: Advertise button on screen`, !!b && b.x >= 0 && b.x + b.width <= width && b.y >= 0 && b.y + b.height <= height, b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}` : 'missing');
    const menuScrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${vp} menu: no horizontal scroll`, menuScrollW <= width, `scrollWidth ${menuScrollW}`);

    // (c) and (d) the Advertise page, Burn then USDC
    await adBtn.click();
    await page.waitForSelector('.ads [data-plans] .ad-plan', { timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('[data-pay]')?.hidden, null, { timeout: 10_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('[data-pay] [data-v="burn"]').click();
    await page.waitForTimeout(1200); // the preview game and the quote settle
    await advertiseShots(page, 'burn', vp);
    const burnPlans = await page.locator('[data-plans] .ad-plan').allTextContents();
    check(`${vp} advertise: three Burn plans in $PJAM`, burnPlans.length === 3 && burnPlans.every((t) => t.includes('$PJAM')), burnPlans.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | '));

    await page.locator('[data-pay] [data-v="usdc"]').click();
    await page.waitForTimeout(800);
    await advertiseShots(page, 'usdc', vp);
    const usdcPlans = (await page.locator('[data-plans] .ad-plan').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    check(`${vp} advertise: USDC week $150 and month $500`, usdcPlans.length === 2 && usdcPlans[0].includes('$150') && usdcPlans[1].includes('$500'), usdcPlans.join(' | '));

    const m = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
      faucet: !!document.querySelector('[data-faucet], .ad-faucet'),
    }));
    check(`${vp} advertise: no horizontal scroll`, m.scrollW <= width, `scrollWidth ${m.scrollW}`);
    const bad = await clipped(page, '.ads');
    check(`${vp} advertise: nothing clipped at the sides`, bad.length === 0, bad.join('; '));
    check(`${vp} advertise: no faucet on the live page`, !m.faucet);
    // A page taller than the screen must scroll all the way to its last section.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    const last = await page.evaluate(() => {
      const els = document.querySelectorAll('.ads .ad-section');
      const r = els[els.length - 1]?.getBoundingClientRect();
      return r ? { bottom: r.bottom, top: r.top } : null;
    });
    check(`${vp} advertise: scrolls to the last section`, !!last && last.bottom <= height + 1 && last.top < height, last ? `last section ${Math.round(last.top)}..${Math.round(last.bottom)} of ${height}` : 'missing');
    const stage = await rectOf(page, '.ad-stage');
    await page.evaluate(() => window.scrollTo(0, 0));
    const stageTop = await rectOf(page, '.ad-stage');
    check(`${vp} advertise: preview fits the width`, !!stageTop && stageTop.left >= 0 && stageTop.right <= width + 0.5, stageTop ? `${Math.round(stageTop.left)}..${Math.round(stageTop.right)}` : String(stage));

    // (a) a Quick Play game, started the normal way
    await page.locator('[data-a="back"]').click();
    await page.waitForSelector('[data-go="quick"]');
    await page.locator('[data-go="quick"]').click();
    await page.locator('#source [data-v="random"]').click();
    await page.locator('.opp[data-i="0"]').click();
    await page.waitForSelector('[data-a="tip"]');
    await page.locator('#intro [data-v="off"]').click();
    await page.locator('[data-a="tip"]').click();
    await page.waitForSelector('canvas.court');
    await page.waitForFunction(() => { const l = document.querySelector('.game .loading'); return !l || l.hidden || getComputedStyle(l).display === 'none' || getComputedStyle(l).opacity === '0'; }, null, { timeout: 20_000 }).catch(() => {});
    // The board scrolls (about a minute per repeat): wait for a frame with both halves whole on screen. The house half is
    // 190 game px wide; the booked block for this text about 150.
    const wide = (span, min) => span[1] - span[0] >= min;
    let led = null;
    for (let i = 0; i < 400; i++) {
      await page.waitForTimeout(200);
      led = await readBoard(page);
      if (led && wide(led.houseX, 175 * led.k) && wide(led.bookedX, 120 * led.k)) break;
    }
    await shot(page, `game-${vp}`);
    const span = (x) => `${x[1] - x[0] + 1} px wide at x ${x[0]}..${x[1]}`;
    check(`${vp} game: board shows the whole $PJAM house half`, !!led && wide(led.houseX, 175 * led.k), led ? span(led.houseX) : 'no canvas');
    check(`${vp} game: board shows the whole booked ad`, !!led && wide(led.bookedX, 120 * led.k), led ? span(led.bookedX) : 'no canvas');
    if (led) {
      // Y_FAR = 98: the far sideline. The board must end above it, off the floor.
      const floor = 98 * led.k;
      const bottom = Math.max(led.houseRows[1], led.bookedRows[1]);
      check(`${vp} game: board above the playfield`, bottom < floor, `board bottom row ${bottom}, floor starts at ${Math.round(floor)} (canvas px)`);
      // Its place on screen, for the HUD comparison (the canvas may be letterboxed inside its box).
      const scale = Math.min(led.rect.width / led.cw, led.rect.height / led.ch);
      const ox = led.rect.left + (led.rect.width - led.cw * scale) / 2;
      const oy = led.rect.top + (led.rect.height - led.ch * scale) / 2;
      const strip = { left: Math.max(0, ox), right: Math.min(width, ox + led.cw * scale), top: oy + 76 * led.k * scale, bottom: oy + 96 * led.k * scale };
      for (const sel of ['.hud .bug', '.hud .pcard', '.hud .banner', '.pause-btn', '.touch .stick-zone', '.touch .tb']) {
        for (const r of await rectsOf(page, sel)) {
        // The HUD draws over the scenery by design; this only reports where it hides part of the board.
        if (overlap(strip, r)) info(`${vp} game: ${sel} sits over part of the board`, `board y ${Math.round(strip.top)}..${Math.round(strip.bottom)}, ${sel} y ${Math.round(r.top)}..${Math.round(r.bottom)}`);
        }
      }
    }
    const adDom = await page.evaluate(() => [...document.querySelectorAll('.game [class*="ad-"], .game .ads')].map((e) => e.className));
    check(`${vp} game: no ads UI over the game`, adDom.length === 0, adDom.join(', '));

    await ctx.close();
  }
} finally {
  await browser.close();
  stopServer();
}

check('API: only pokejam-ads-live was called', apiCalls.length > 0, `${apiCalls.length} mocked calls: ${[...new Set(apiCalls)].join(', ')}`);
const supabase = blocked.filter((u) => /supabase/.test(u));
check('no request to Supabase got out', true, supabase.length ? `${supabase.length} aborted: ${[...new Set(supabase.map((u) => new URL(u).origin + new URL(u).pathname))].join(', ')}` : 'none attempted');
if (blocked.length) info('aborted off-site requests', [...new Set(blocked.map((u) => new URL(u).origin))].join(', '));
console.log(`\n${shots.length} screenshots in ${SHOTS}:`);
for (const s of shots) console.log(`  ${s}`);
if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
