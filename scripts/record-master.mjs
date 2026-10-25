// PokeJam Master cutscene media: screenshots mid-scene (badges lit, title visible) at 844x390 and 932x430, and a clip
// with the game's real synthesized audio at 844x390 (the announcer's speech is not captured: it is the browser's
// speechSynthesis, outside the Web Audio graph, and headless Chrome has no voices).
//   npx vite --port 5199 &        (dev server, so the script can import the game's own modules)
//   node scripts/record-master.mjs [outDir]       (default /workspace/championship-cutscene)
// Needs playwright (or playwright-core), a Chrome and ffmpeg; see screenshot-moments.mjs for PLAYWRIGHT_CORE / CHROME.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CORE_FALLBACK = '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core';
const CHROME_FALLBACK = '/opt/google/chrome/chrome';
let pw;
try { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright'); } catch {
  try { pw = require('playwright-core'); } catch { pw = require(CORE_FALLBACK); }
}
const SITE = process.env.SITE || 'http://localhost:5199/';
const outDir = process.argv[2] || '/workspace/championship-cutscene';
/** Seconds of the cutscene to keep: the scene is about 14 s. */
const KEEP = Number(process.env.KEEP || 15);
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'master-'));
const browser = await pw.chromium.launch({
  executablePath: process.env.CHROME || CHROME_FALLBACK,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const settings = { difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' };

/** A franchise save where the user's team wins the title with every badge (a season simulated with the real engine). */
async function makeSave(page) {
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
    const fin = f.games.find((g) => g.round === 'final');
    const other = fin.home === 0 ? fin.away : fin.home === f.champion ? fin.away : fin.home;
    fin.home = 0;
    fin.away = other === 0 ? 1 : other;
    fin.score = [71, 64];
    fin.pog = f.teams[0].roster[0];
    f.champion = 0;
    // The user beats every gym and the Elite Four this season (a win is added for any the sim did not give them).
    for (const t of f.teams.filter((x) => x.gym || x.elite)) {
      if (!L.badgesEarned(f).has(t.id)) f.games.push({ week: 1, home: 0, away: t.id, score: [60, 50] });
    }
    // Skip the championship court scene: go straight to the PokeJam Master one.
    f.titleShown = f.season;
    return f;
  });
}

/** Screenshot at one size, mid-scene: every badge has lit and the title has slammed in. */
async function shot(save, size, name, at = 7000) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript(([s, st]) => {
    localStorage.setItem('pokejam.franchise.v1', JSON.stringify(s));
    localStorage.setItem('pokejam.settings', JSON.stringify(st));
  }, [save, settings]);
  await page.goto(SITE);
  await page.waitForSelector('#app button', { timeout: 15000 });
  await page.getByRole('button', { name: /continue/i }).first().click();
  await page.waitForSelector('.moment.master', { timeout: 10000 });
  await page.waitForTimeout(at);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  const fit = await page.evaluate(() => {
    const m = document.querySelector('.moment');
    return { scrollH: m.scrollHeight, clientH: m.clientHeight, scrollW: m.scrollWidth, clientW: m.clientWidth };
  });
  console.log(name, JSON.stringify(fit));
  await ctx.close();
}

const boot = await browser.newPage();
await boot.goto(SITE);
const save = await makeSave(boot);
await boot.close();
await shot(save, { width: 844, height: 390 }, 'master-844x390');
await shot(save, { width: 932, height: 430 }, 'master-932x430');

// The clip, with the game's audio tapped inside the page.
const SIZE = { width: 844, height: 390 };
const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, hasTouch: true, isMobile: true, recordVideo: { dir: work, size: SIZE } });
const page = await ctx.newPage();
const pageOpened = Date.now();
page.on('console', (m) => { if (m.text().startsWith('[rec]')) console.log(m.text()); });
await page.addInitScript(([s, st]) => {
  localStorage.setItem('pokejam.franchise.v1', JSON.stringify(s));
  localStorage.setItem('pokejam.settings', JSON.stringify(st));
  const taps = new WeakMap();
  const chunks = [];
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const c = dest.context;
      if (!taps.has(c)) {
        const tap = c.createMediaStreamDestination();
        const rec = new MediaRecorder(tap.stream, { mimeType: 'audio/webm;codecs=opus' });
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.start(250);
        window.__recStart = Date.now();
        taps.set(c, tap);
        console.log('[rec] recording started');
      }
      origConnect.call(this, taps.get(c));
    }
    return origConnect.call(this, dest, ...rest);
  };
  window.__recChunks = chunks;
  new MutationObserver(() => {
    if (!window.__momentAt && document.querySelector('.moment')) window.__momentAt = Date.now();
  }).observe(document, { childList: true, subtree: true });
}, [save, settings]);
await page.goto(SITE);
await page.waitForSelector('#app button', { timeout: 15000 });
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForSelector('.moment.master', { timeout: 10000 });
await page.waitForTimeout(KEEP * 1000);
const info = await page.evaluate(async () => {
  const chunks = window.__recChunks;
  await new Promise((r) => setTimeout(r, 600)); // let the recorder flush its last slice
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { recStart: window.__recStart, momentAt: window.__momentAt, b64: btoa(s) };
});
const video = page.video();
await ctx.close();
const vpath = join(work, 'video.webm');
await video.saveAs(vpath);
await browser.close();
const apath = join(work, 'audio.webm');
writeFileSync(apath, Buffer.from(info.b64, 'base64'));

// Align: the scene (and its sound) begins when the .moment overlay is mounted; the audio file starts at recStart.
const momentVideoT = (info.momentAt - pageOpened) / 1000;
const audioDelay = Math.max(0, (info.recStart - pageOpened) / 1000);
console.log(`moment at video t=${momentVideoT.toFixed(2)}s, audio file starts at video t=${audioDelay.toFixed(2)}s`);
const from = Math.max(0, momentVideoT - 0.3);
const clip = `${outDir}/master-cutscene-844x390.mp4`;
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-i', vpath, '-i', apath,
  '-filter_complex', `[1:a]adelay=${Math.round(audioDelay * 1000)}:all=1,apad[a]`,
  '-map', '0:v', '-map', '[a]',
  '-ss', String(from), '-t', String(KEEP), '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  clip,
]);
console.log('wrote', clip);
