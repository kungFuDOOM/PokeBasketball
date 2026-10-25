// Screenshots of the championship cutscene and the new-season preview, from a real simulated franchise season.
//   npx vite --port 5199 &        (dev server, so the script can import the game's own modules)
//   node scripts/screenshot-moments.mjs [outDir]
// Needs playwright (or playwright-core) and a Chrome: set PLAYWRIGHT_CORE=/path/to/playwright-core and
// CHROME=/path/to/chrome when they are not installed in the repo.
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const CORE_FALLBACK = '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core';
const CHROME_FALLBACK = '/opt/google/chrome/chrome';
let pw;
try { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright'); } catch {
  try { pw = require('playwright-core'); } catch { pw = require(CORE_FALLBACK); }
}
const SITE = process.env.SITE ||'http://localhost:5199/';
const out = process.argv[2] || '/workspace/championship-cutscene';
mkdirSync(out, { recursive: true });

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || CHROME_FALLBACK });

/** Builds a franchise in the page, plays a whole season with the real engine, and returns the save states as JSON. */
async function makeSaves(page) {
  return page.evaluate(async () => {
    const L = await import('/src/franchise/league.ts');
    const { POKEMON } = await import('/src/data/pokemon.ts');
    const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
    const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: L.USER_STYLE.color, color2: L.USER_STYLE.color2, human: true }, ...L.LEAGUE.map((t) => ({
      name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, leader: t.leader, types: t.types, boost: t.boost, gym: t.gym, badge: t.badge, elite: t.elite,
    }))];
    const rosters = teams.map(() => []);
    let i = 0;
    for (let r = 0; r < 10; r++) for (let j = 0; j < teams.length; j++) rosters[r % 2 ? teams.length - 1 - j : j].push(pool[i++]);
    const f = L.createFranchise(teams, rosters, pool.slice(i));
    for (let guard = 0; guard < 40 && f.phase !== 'done'; guard++) {
      for (const g of L.weekGames(f).filter((x) => !x.score)) {
        const { cfg, sides, uidOf } = L.gameConfig(f, g, false, 60, 'pro');
        L.recordGame(f, g, await L.simulate(cfg), sides, uidOf);
      }
      L.advance(f);
    }
    const base = JSON.parse(JSON.stringify(f));

    // The user's team takes the title: put them in the final and make them the winner.
    const mine = JSON.parse(JSON.stringify(f));
    const fin = mine.games.find((g) => g.round === 'final');
    const other = fin.home === 0 ? fin.away : fin.home === mine.champion ? fin.away : fin.home;
    fin.home = 0;
    fin.away = other === 0 ? 1 : other;
    fin.score = [71, 64];
    fin.pog = mine.teams[0].roster[0];
    mine.champion = 0;

    // Someone else wins, and the user is not in the final (rig it if the sim crowned the user).
    const other2 = JSON.parse(JSON.stringify(f));
    if (other2.champion === 0) {
      const fin2 = other2.games.find((g) => g.round === 'final');
      fin2.home = 1;
      fin2.away = 2;
      fin2.score = [68, 66];
      other2.champion = 1;
      fin2.pog = other2.teams[1].roster[0];
    }

    // The offseason: rookie draft, then the new season starts.
    const next = JSON.parse(JSON.stringify(mine));
    next.titleShown = next.season;
    L.startRookieDraft(next);
    while (L.rookieOnClock(next)) L.rookiePick(next);
    const me = next.teams[0];
    const pick = next.rookies.picks[next.rookies.order.indexOf(0)];
    L.finishRookieDraft(next, me.roster.filter((u) => u !== pick).reduce((a, b) => (L.tradeValue(next, b, me) < L.tradeValue(next, a, me) ? b : a)));
    return { mine, other: other2, next, baseChampion: base.champion };
  });
}

async function shot(save, size, name, wait = 1800) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, hasTouch: size.width < 900, isMobile: size.width < 900 });
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    localStorage.setItem('pokejam.franchise.v1', JSON.stringify(s));
    localStorage.setItem('pokejam.settings', JSON.stringify({ difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' }));
  }, save);
  await page.goto(SITE);
  await page.waitForSelector('[data-a="continue"], .menu-grid, #app button', { timeout: 15000 });
  // The menu offers "Continue" for the saved franchise.
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForSelector('.moment', { timeout: 10000 });
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `${out}/${name}.png` });
  const overflow = await page.evaluate(() => {
    const m = document.querySelector('.moment');
    return { scrollH: m.scrollHeight, clientH: m.clientHeight, scrollW: m.scrollWidth, clientW: m.clientWidth };
  });
  console.log(name, JSON.stringify(overflow));
  await ctx.close();
}

const boot = await browser.newPage();
await boot.goto(SITE);
const saves = await makeSaves(boot);
await boot.close();
console.log('natural champion was', saves.baseChampion === 0 ? 'the user (rigged variants used)' : `team ${saves.baseChampion}`);

const iphone = { width: 844, height: 390 };
await shot(saves.mine, iphone, 'user-champion-844x390');
await shot(saves.other, iphone, 'other-champion-844x390');
await shot(saves.next, iphone, 'new-season-844x390', 800);
await shot(saves.mine, { width: 932, height: 430 }, 'user-champion-932x430');
await shot(saves.mine, { width: 1440, height: 900 }, 'user-champion-desktop');
await browser.close();

// The three main shots also live in the repo so they render in the PR.
const docs = new URL('../docs/screenshots/championship-cutscene/', import.meta.url).pathname;
mkdirSync(docs, { recursive: true });
for (const n of ['user-champion-844x390', 'other-champion-844x390', 'new-season-844x390']) copyFileSync(`${out}/${n}.png`, `${docs}${n}.png`);
