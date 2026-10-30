// Screenshots of the moderation page's Reported tab (cheat-check tags) with MOCK data (no real Supabase calls).
//   node scripts/admin-reports-shot.mjs [outDir]
// Builds admin.html against a fake Supabase URL into a temp dir, serves it, fakes a signed-in moderator session and
// answers every Supabase request in the browser, including functions/v1/pokejam-judge: one reported match starts with
// uploads but no verdict, the page asks the judge, and the reload shows it judged. Needs playwright-core and a Chrome:
// set CHROME=/path/to/chrome when `npx playwright-core install chromium` hasn't put one in ~/.cache/ms-playwright
// (else it tries /usr/bin/google-chrome and /usr/bin/chromium).
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] || '/workspace/pj-cheattag-shots';
mkdirSync(out, { recursive: true });
const SB = 'https://mock-project.supabase.co';
const dist = mkdtempSync(join(tmpdir(), 'pj-admin-'));
execFileSync('npx', ['vite', 'build', '-c', 'vite.admin.config.ts', '--outDir', dist, '--logLevel', 'warn'], {
  stdio: 'inherit', env: { ...process.env, VITE_SUPABASE_URL: SB, VITE_SUPABASE_ANON_KEY: 'mock-anon-key' },
});

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const f = join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(dist) || !existsSync(f) || extname(f) === '') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f));
}).listen(0);
const site = `http://localhost:${server.address().port}/admin.html`;

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const check = (m, o) => ({ match_id: id(m), queue: 'ranked', has_evidence: true, status: null, agrees: null, cheater_is_reported: null, ...o });
const report = (reason, note, h, from, n) => ({ reason, note, at: ago(h), from, from_id: id(n) });
const UNJUDGED = id(904);
/** The Reported rows; `judged` is whether the mock judge has run, which turns UNJUDGED's check into an agreeing final. */
const reports = (judged) => [
  { user_id: id(101), name: 'QuickSilver', reporters: 1, reports: 1, reasons: { cheating: 1 }, last_at: ago(1), banned_until: null,
    latest: [report('cheating', 'won with 2 HP left every time', 1, 'BlazeRunner', 201)],
    checks: [check(901, { status: 'final', agrees: false, notes: 'replay says the host won 3–1, recorded guest win' })] },
  { user_id: id(102), name: 'MistyLake', reporters: 3, reports: 3, reasons: { cheating: 2, abuse: 1 }, last_at: ago(3), banned_until: null,
    latest: [report('cheating', null, 3, 'Kanto Kid', 202), report('abuse', 'rude chat', 9, 'Pallet Pro', 203), report('cheating', 'too fast', 20, 'Ash K', 204)],
    checks: [check(902, { status: 'final', agrees: true }), check(903, { status: 'incomplete' })] },
  { user_id: id(103), name: 'RocketGrunt', reporters: 2, reports: 2, reasons: { cheating: 2 }, last_at: ago(5), banned_until: null,
    latest: [report('cheating', 'left right before losing', 5, 'Brock Solid', 205), report('cheating', null, 30, 'Gym Leader', 206)],
    checks: [check(905, { status: 'forfeit', cheater_is_reported: true })] },
  { user_id: id(104), name: 'ThunderPaw', reporters: 1, reports: 1, reasons: { cheating: 1 }, last_at: ago(2), banned_until: null,
    latest: [report('cheating', 'suspicious comeback', 2, 'Sabrina M', 207)],
    checks: [judged ? check(904, { status: 'final', agrees: true }) : check(904, {})] },
  { user_id: id(105), name: 'SocialButterfly', reporters: 2, reports: 2, reasons: { name: 1, abuse: 1 }, last_at: ago(7), banned_until: null,
    latest: [report('name', null, 7, 'Erika G', 208), report('abuse', 'spam emotes', 12, 'Koga N', 209)],
    checks: [check(906, { queue: 'social', has_evidence: false })] },
  { user_id: id(106), name: 'OldTimer', reporters: 1, reports: 1, reasons: { cheating: 1 }, last_at: ago(40), banned_until: ago(-48),
    latest: [report('cheating', null, 40, 'Blaine F', 210)], checks: [check(907, { has_evidence: false })] },
];

// The Stats panel above the tabs (same numbers as admin-stats-shot.mjs) so it doesn't render "undefined".
const STATS = {
  pokejam_admin_stats: {
    players_today: 42, players_7d: 187, players_all: 1234, profiles_all: 1502, games_today: 63, games_today_finished: 51,
    games_all: 4821, games_all_finished: 4377, playing_now_matches: 3, playing_now_players: 6, queue_now: 2,
    today_starts: '2026-10-28T07:00:00Z', generated_at: '2026-10-28T23:41:00Z',
  },
  pokejam_admin_offline_stats: {
    players_today: 318, players_7d: 1406, players_all: 2210,
    games_today: { quick: { started: 402, finished: 297 }, franchise: { started: 251, finished: 236 } },
    games_all: { quick: { started: 3120, finished: 2288 }, franchise: { started: 1874, finished: 1760 } },
    finish_today: { played: 471, watched: 0, simmed: 62 }, finish_all: { played: 3612, watched: 0, simmed: 436 },
    seasons_today: { franchise: { seasons: 9, playoffs: 6, titles: 2 } },
    seasons_all: { franchise: { seasons: 71, playoffs: 44, titles: 17 }, season_draft: { seasons: 512, playoffs: 301, titles: 88 } },
    first_event_at: '2026-10-28T20:00:00Z', today_starts: '2026-10-28T07:00:00Z', generated_at: '2026-10-28T23:41:00Z',
  },
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const user = { id: id(1), aud: 'authenticated', role: 'authenticated', email: 'mock-moderator@example.com', is_anonymous: false };
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.mock`,
  refresh_token: 'mock', token_type: 'bearer', expires_in: 3600, expires_at: exp, user,
};
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

const chrome = process.env.CHROME || (() => {
  const dir = join(homedir(), '.cache/ms-playwright');
  const c = existsSync(dir) && readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().pop();
  return c ? join(dir, c, 'chrome-linux64/chrome') : ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
})();
const browser = await chromium.launch({ executablePath: chrome });
try {
  for (const viewport of [{ width: 844, height: 390 }, { width: 932, height: 430 }, { width: 390, height: 844 }]) {
    const name = `admin-reports-${viewport.width}x${viewport.height}`;
    const page = await browser.newPage({ viewport });
    await page.addInitScript((s) => {
      localStorage.setItem('pokejam.admin.auth', s);
      addEventListener('DOMContentLoaded', () => {
        const tag = document.createElement('div');
        tag.textContent = 'MOCK DATA — screenshot only';
        // A banner at the top (not floating) so full-page shots don't cover any rows.
        tag.style.cssText = 'padding:6px 10px;text-align:center;background:#c0262d;color:#fff;font:700 14px sans-serif';
        document.body.prepend(tag);
      });
    }, JSON.stringify(session));
    let judged = false;
    let judgeCalls = 0;
    await page.route(`${SB}/**`, (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const path = new URL(req.url()).pathname;
      const reply = (body) => route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/functions/v1/pokejam-judge') {
        judgeCalls++;
        const ids = req.postDataJSON()?.match_ids ?? [];
        judged = ids.includes(UNJUDGED);
        return reply({ ok: true, results: ids.map((m) => ({ match_id: m, status: 'final' })) });
      }
      const fn = path.match(/\/rest\/v1\/rpc\/(\w+)/)?.[1];
      if (fn === 'pokejam_is_admin') return reply(true);
      if (fn === 'pokejam_admin_reports') return reply(reports(judged));
      if (fn in STATS) return reply(STATS[fn]);
      return reply(fn ? [] : {});
    });
    await page.goto(site);
    await page.waitForSelector('[data-act="dismiss"]');
    // The reload after the judge ran: ThunderPaw's match turns Clean.
    await page.waitForFunction(() => [...document.querySelectorAll('tr')].some((tr) => tr.textContent.includes('ThunderPaw') && tr.textContent.includes('Clean')));
    if (judgeCalls !== 1) throw new Error(`expected one judge call, saw ${judgeCalls}`);
    const tags = await page.$$eval('tbody td:nth-child(2) .tag', (els) => els.map((e) => e.textContent));
    for (const t of ['Clean', 'Flagged', 'No check']) if (!tags.includes(t)) throw new Error(`no "${t}" tag in ${tags.join(', ')}`);
    // Every row's tag, report count and Dismiss button must sit inside the viewport width (no sideways scrolling).
    const offscreen = await page.$$eval('tbody tr', (trs, w) => trs.flatMap((tr) => ['td:nth-child(2) .tag', 'td.num', '[data-act="dismiss"]']
      .map((s) => [s, tr.querySelector(s)?.getBoundingClientRect()]).filter(([, r]) => !r || r.left < 0 || r.right > w)
      .map(([s]) => `${tr.querySelector('strong')?.textContent}: ${s}`)), viewport.width);
    if (offscreen.length) throw new Error(`${name}: off-screen ${offscreen.join(', ')}`);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    console.log(join(out, `${name}.png`), tags.join(' / '));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
