// Screenshots of the eight Kanto gym matchup cards (desktop), plus Brock's on a portrait phone. Usage:
//   npx vite --port 5199 --strictPort &   then   PORT=5199 node scripts/kanto-gyms-shots.mjs [outDir]
// Each shot builds a new franchise in-page (all four regions open for the user, gyms and Elite drafted the way the app
// does it), moves the schedule to the week the user plays that gym, and captures the hub's next-game card.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'docs/screenshots/kanto-gyms';
const BASE = `http://localhost:${process.env.PORT ?? 5199}/`;
const NAMES = ['brock', 'misty', 'surge', 'erika', 'koga', 'sabrina', 'blaine', 'giovanni'];
const SHOTS = [
  ...NAMES.map((n, i) => ({ gym: i + 1, file: `gym${i + 1}-${n}-desktop`, vp: { width: 1280, height: 900 }, phone: false })),
  { gym: 1, file: 'gym1-brock-phone', vp: { width: 390, height: 844 }, phone: true },
];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
for (const shot of SHOTS) {
  const ctx = await browser.newContext({ viewport: shot.vp, deviceScaleFactor: 2, hasTouch: shot.phone, isMobile: shot.phone });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(async (gym) => {
    const L = await import('/src/franchise/league.ts');
    const R = await import('/src/franchise/regions.ts');
    const T = await import('/src/season/team.ts');
    const P = await import('/src/data/pokemon.ts');
    localStorage.clear();
    const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }, ...L.LEAGUE.map((t) => ({ ...t, human: false }))];
    const { rosters, leftovers } = T.autoDraft(teams, 10, undefined, R.poolMons(R.openRegionIds(['johto', 'hoenn', 'sinnoh'])), R.isKantoCpuMon);
    const used = new Set([...rosters.flat(), ...leftovers]);
    const f = L.createFranchise(teams, rosters, [...leftovers, ...P.POKEMON.filter((m) => !used.has(m))]);
    f.unlockedRegions = ['johto', 'hoenn', 'sinnoh'];
    f.introShown = f.season;
    const id = f.teams.find((t) => t.gym === gym).id;
    f.week = f.games.find((g) => (g.home === 0 && g.away === id) || (g.away === 0 && g.home === id)).week;
    L.saveFranchise(f);
  }, shot.gym);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('[data-go="continue"]');
  const card = page.locator('.card.next');
  await card.waitFor({ timeout: 10000 });
  // Every sprite on the card must have loaded, and the strength line must be there, before the shot.
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.card.next .lineup img')];
    return imgs.length === 10 && imgs.every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll('.card.next .nx-plays').length === 2;
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  // On the phone, the shot is the first screen scrolled to the gym's side of the card.
  if (shot.phone) {
    await page.locator('.card.next .nx-team').nth(0).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${shot.file}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) throw new Error(`phone page is ${overflow}px too wide`);
  } else await card.screenshot({ path: `${OUT}/${shot.file}.png` });
  console.log(shot.file, (await card.locator('.nx-team').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join('  ||  '));
  await ctx.close();
}
await browser.close();
