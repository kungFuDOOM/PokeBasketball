// Screenshots for the retired Kabuto special removal: Quick Play picker, 3-Point picker, franchise draft, and a franchise roster.
//   npx vite --port 5201 --strictPort &
//   node scripts/remove-king-kabuto-shots.mjs before|after [outDir]
// Both runs pin the clock to Nov 15 2026 (the old event window), so "before" shows him and "after" proves he is gone.
// "before" (only meaningful on the pre-removal commit) also writes legacy-save.json; "after" loads that same save.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const pw = require('playwright-core');
const SITE = process.env.SITE || 'http://localhost:5201/';
const phase = process.argv[2] || 'before';
const out = process.argv[3] || '/workspace/pj-no-king-kabuto-shots';
mkdirSync(out, { recursive: true });
const SAVE_FILE = `${out}/legacy-save.json`;
const SIZES = { phone: { width: 844, height: 390 }, desktop: { width: 1280, height: 800 } };
const MID_EVENT = Date.parse('2026-11-15T12:00:00-08:00');

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

async function fresh(size) {
  const ctx = await browser.newContext({ viewport: SIZES[size], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.clock.install({ time: MID_EVENT });
  await page.clock.resume();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(() => { localStorage.setItem('pokejam.tutorial.done.v1', '1'); });
  return page;
}
const shot = (page, name, size) => page.screenshot({ path: `${out}/${phase}-${name}-${size}.png` });
const goMenu = async (page) => { await page.goto(SITE); await page.waitForSelector('[data-go="quick"]', { timeout: 15000 }); };

// Dismiss the draft-order overlay and filter to shooting guards, where Kabuto sits (SG).
async function sgBoard(page) {
  await page.mouse.click(10, 200);
  await page.waitForTimeout(500);
  const sg = page.locator('button', { hasText: /^SG/ }).first();
  if (await sg.count()) await sg.click();
  await page.waitForTimeout(1500);
}

// A legacy franchise: the user's Kabuto carries the legacy `king: true` flag (as saves from the event did); it must still load as King Kabuto.
async function buildLegacySave(page) {
  await goMenu(page);
  const json = await page.evaluate(async () => {
    const L = await import('/src/franchise/league.ts');
    const { POKEMON } = await import('/src/data/pokemon.ts');
    const pool = POKEMON;
    const pick = (ds) => ds.map((d) => pool.find((m) => m.dex === d));
    const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: L.USER_STYLE.color, color2: L.USER_STYLE.color2, human: true }, ...L.LEAGUE.slice(0, 1).map((t) => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false }))];
    const rosters = [pick([140, 25, 6, 9, 143, 94, 130, 149, 65, 68]), pick([74, 95, 111, 76, 142, 112, 80, 103, 59, 131])];
    const used = new Set(rosters.flat().map((m) => m.dex));
    const f = L.createFranchise(teams, rosters, pool.filter((m) => !used.has(m.dex)));
    const u = Object.values(f.players).find((p) => p.dex === 140);
    Object.assign(u, { king: true, level: 4, xp: 3, bonus: { pas: 2, spd: 1 }, ovrStart: 87 });
    return JSON.stringify(f);
  });
  writeFileSync(SAVE_FILE, json);
}

for (const size of ['phone', 'desktop']) {
  let page = await fresh(size);
  if (phase === 'before' && size === 'phone') { await buildLegacySave(page); await page.context().close(); page = await fresh(size); }

  // Quick Play picker
  await goMenu(page);
  await page.click('[data-go="quick"]');
  await page.click('.opp[data-i="0"]');
  await page.waitForTimeout(1200);
  await sgBoard(page);
  await shot(page, 'quickplay-picker', size);

  // 3-Point Contest picker
  await goMenu(page);
  await page.click('[data-go="threept"]');
  await page.waitForSelector('.tp-row');
  await page.waitForTimeout(1500);
  await shot(page, 'threepoint-picker', size);

  // Franchise draft board
  await goMenu(page);
  await page.click('[data-go="new"]');
  await page.waitForTimeout(1200);
  await sgBoard(page);
  await shot(page, 'franchise-draft', size);

  // Franchise roster with the legacy save
  const ctxPage = await fresh(size);
  await ctxPage.addInitScript((s) => { localStorage.setItem('pokejam.franchise.v1', s); }, readFileSync(SAVE_FILE, 'utf8'));
  await goMenu(ctxPage);
  await ctxPage.click('[data-go="continue"]');
  await ctxPage.waitForTimeout(1500);
  await shot(ctxPage, 'franchise-hub', size);
  await ctxPage.getByRole('button', { name: 'Trade' }).first().click();
  await ctxPage.waitForTimeout(1500);
  await shot(ctxPage, 'franchise-trade', size);
  await page.context().close();
  await ctxPage.context().close();
}
await browser.close();
