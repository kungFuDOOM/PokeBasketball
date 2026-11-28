// Screenshots of the gym 1, gym 8 and Elite matchup cards (desktop) of Johto, Hoenn and Sinnoh. Usage:
//   npx vite --port 5199 --strictPort &   then   PORT=5199 node scripts/region-gyms-shots.mjs [outDir]
// Each shot builds a new franchise in-page against the fixed 91 OVR test team, puts it at the start of a season in the
// region before the target with the target unlocked, enters the target with the app's own `enterRegion` (so the nine
// draft around the user's team), moves the schedule to the week the user plays that team, and captures the hub's
// next-game card. Kanto has its own script (kanto-gyms-shots.mjs).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'docs/screenshots/region-gyms';
// Alakazam, Lucario, Charizard, Garchomp, Snorlax.
const TEAM = [65, 448, 6, 445, 143];
const BASE = `http://localhost:${process.env.PORT ?? 5199}/`;
const SHOTS = ['johto', 'hoenn', 'sinnoh'].flatMap((region) => [
  { region, gym: 1, file: `${region}-gym1` },
  { region, gym: 8, file: `${region}-gym8` },
  { region, elite: true, file: `${region}-elite` },
]);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
for (const shot of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(async ({ region, gym, elite, team }) => {
    const L = await import('/src/franchise/league.ts');
    const R = await import('/src/franchise/regions.ts');
    const K = await import('/src/franchise/kantoDraft.ts');
    const P = await import('/src/data/pokemon.ts');
    localStorage.clear();
    const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }, ...L.LEAGUE.map((t) => ({ ...t, human: false }))];
    const mine = team.map(P.monByDex);
    const rosters = [mine, ...K.kantoRosters(team)];
    const used = new Set(rosters.flat().map((m) => m.dex));
    const f = L.createFranchise(teams, rosters, P.POKEMON.filter((m) => !used.has(m.dex)));
    const target = R.regionById(region);
    f.unlockedRegions = R.REGIONS.slice(1, target.index + 1).map((r) => r.id);
    f.region = R.REGIONS[target.index - 1].id;
    if (!L.enterRegion(f, region)) throw new Error(`could not enter ${region}`);
    f.introShown = f.season;
    const id = f.teams.find((t) => (elite ? t.elite : t.gym === gym)).id;
    f.week = f.games.find((g) => (g.home === 0 && g.away === id) || (g.away === 0 && g.home === id)).week;
    L.saveFranchise(f);
  }, { region: shot.region, gym: shot.gym, elite: shot.elite, team: TEAM });
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
  await card.screenshot({ path: `${OUT}/${shot.file}.png` });
  console.log(shot.file, (await card.locator('.nx-team').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join('  ||  '));
  await ctx.close();
}
await browser.close();
