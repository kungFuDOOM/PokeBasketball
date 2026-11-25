// Screenshots of the Kanto gym rosters (trade panel + starting-five intro). Usage:
//   npx vite --port 5199 --strictPort &   then   node scripts/kanto-gyms-shots.mjs <before|after> <outDir>
// Builds a franchise in-page with all four regions open for the user (the worst case for later-gen gym players),
// drafting the CPU Kanto teams through the same `isKantoCpuMon` rule the app uses once it exists.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const [TAG, OUT] = process.argv.slice(2);
const BASE = 'http://localhost:5199/';
const VIEWS = { phone: { width: 844, height: 390 }, desktop: { width: 1280, height: 800 } };
const TEAMS = [1, 4, 8, 9]; // Pewter, Celadon, Viridian, Indigo Elite

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const tables = {};
for (const [vname, vp] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: vname === 'phone' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const rosters = await page.evaluate(async () => {
    const L = await import('/src/franchise/league.ts');
    const R = await import('/src/franchise/regions.ts');
    const T = await import('/src/season/team.ts');
    const P = await import('/src/data/pokemon.ts');
    const K = await import('/src/kabuto/king.ts');
    localStorage.clear();
    const open = R.openRegionIds(['johto', 'hoenn', 'sinnoh']);
    const teams = [{ name: 'Pallet Pros', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }, ...L.LEAGUE.map((t) => ({ ...t, human: false }))];
    const { rosters, leftovers } = T.autoDraft(teams, 10, undefined, K.withKingKabuto(R.poolMons(open)), R.isKantoCpuMon);
    const used = new Set([...rosters.flat(), ...leftovers]);
    const f = L.createFranchise(teams, rosters, [...leftovers, ...P.POKEMON.filter((m) => !used.has(m))]);
    f.unlockedRegions = ['johto', 'hoenn', 'sinnoh'];
    f.introShown = f.season;
    L.saveFranchise(f);
    return f.teams.slice(1).map((t) => ({ id: t.id, abbr: t.abbr, boost: t.boost, mons: t.roster.map((u) => { const m = L.monOf(f, u); return `${m.name} #${m.dex} ${m.ovr}`; }) }));
  });
  tables[vname] = rosters;
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('[data-go="continue"]');
  await page.waitForSelector('[data-a="trade"]', { timeout: 10000 });
  await page.click('[data-a="trade"]');
  for (const id of TEAMS) {
    await page.click(`[data-tteam="${id}"]`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${TAG}-trade-${rosters[id - 1].abbr.toLowerCase()}-${vname}.png` });
  }
  await ctx.close();
}
writeFileSync(`${OUT}/${TAG}-rosters.json`, JSON.stringify(tables.desktop, null, 1));
await browser.close();
