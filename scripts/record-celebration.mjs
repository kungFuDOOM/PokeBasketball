// Records the championship celebration WITH the game's real WebAudio output, as an mp4 (844x390 by default).
//   npx vite --port 5199 &        (dev server, so the script can import the game's own modules)
//   node scripts/record-celebration.mjs [out.mp4]
// The picture is Playwright's page video. The sound is tapped inside the page: every connection to an
// AudioContext destination is also wired to a MediaStreamDestination that a MediaRecorder captures, so the clip
// carries the actual synthesized fanfare, crowd, pops and title-card loop, then ffmpeg muxes the two.
// Not captured: the announcer's spoken line. It uses the browser's speechSynthesis, which is not part of the Web Audio graph
// (and headless Chrome has no voices), so the clip has no speech.
// Needs playwright (or playwright-core), a Chrome and ffmpeg; see screenshot-moments.mjs for PLAYWRIGHT_CORE / CHROME.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const CORE_FALLBACK = '/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core';
const CHROME_FALLBACK = '/opt/google/chrome/chrome';
let pw;
try { pw = require(process.env.PLAYWRIGHT_CORE || 'playwright'); } catch {
  try { pw = require('playwright-core'); } catch { pw = require(CORE_FALLBACK); }
}
const SITE = process.env.SITE || 'http://localhost:5199/';
const out = process.argv[2] || '/workspace/championship-cutscene/celebration-audio-844x390.mp4';
const SIZE = { width: 844, height: 390 };
/** Seconds of the cutscene to keep: the scene (6.2 s), the title card and a few seconds of its loop. */
const KEEP = Number(process.env.KEEP || 13);
mkdirSync(dirname(out), { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'celebration-'));

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROME || CHROME_FALLBACK,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

/** A franchise save where the user's team wins the title (a season simulated with the real engine). */
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
    return f;
  });
}

const boot = await browser.newPage();
await boot.goto(SITE);
const save = await makeSave(boot);
await boot.close();

const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, hasTouch: true, isMobile: true, recordVideo: { dir: work, size: SIZE } });
const page = await ctx.newPage();
const pageOpened = Date.now();
page.on('console', (m) => { if (m.text().startsWith('[rec]')) console.log(m.text()); });
await page.addInitScript((s) => {
  localStorage.setItem('pokejam.franchise.v1', JSON.stringify(s));
  localStorage.setItem('pokejam.settings', JSON.stringify({ difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' }));
  // Tap the audio: whatever the game connects to a destination is also recorded.
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
}, save);
await page.goto(SITE);
await page.waitForSelector('#app button', { timeout: 15000 });
await page.getByRole('button', { name: /continue/i }).first().click();
await page.waitForSelector('.moment', { timeout: 10000 });
await page.waitForTimeout(KEEP * 1000);
const info = await page.evaluate(async () => {
  const chunks = window.__recChunks;
  await new Promise((r) => setTimeout(r, 600)); // let the recorder flush its last slice
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { recStart: window.__recStart, momentAt: window.__momentAt, b64: btoa(s), speech: typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : -1 };
});
const video = page.video();
await ctx.close();
const vpath = join(work, 'video.webm');
await video.saveAs(vpath);
await browser.close();
const apath = join(work, 'audio.webm');
writeFileSync(apath, Buffer.from(info.b64, 'base64'));

// Align: the scene (and its sound) begins when the .moment overlay is mounted. The audio file starts at recStart.
// Video time zero is when the page opened (+ a small lag Playwright adds before its first frame).
const momentVideoT = (info.momentAt - pageOpened) / 1000;
const audioDelay = Math.max(0, (info.recStart - pageOpened) / 1000);
console.log(`moment at video t=${momentVideoT.toFixed(2)}s, audio file starts at video t=${audioDelay.toFixed(2)}s, speech voices in browser: ${info.speech}`);
const from = Math.max(0, momentVideoT - 0.3);
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-i', vpath, '-i', apath,
  '-filter_complex', `[1:a]adelay=${Math.round(audioDelay * 1000)}:all=1,apad[a]`,
  '-map', '0:v', '-map', '[a]',
  '-ss', String(from), '-t', String(KEEP), '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  out,
]);
console.log('wrote', out);
