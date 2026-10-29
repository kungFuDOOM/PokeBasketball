// Screenshots of the moderation page's Stats panel with MOCK data (no real Supabase calls).
//   node scripts/admin-stats-shot.mjs [outDir]
// Builds admin.html against a fake Supabase URL into a temp dir, serves it, fakes a signed-in moderator session and
// answers every Supabase request in the browser. Needs playwright-core and a Chrome: set CHROME=/path/to/chrome
// when `npx playwright-core install chromium` hasn't put one in ~/.cache/ms-playwright.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const out = process.argv[2] || '/workspace/pj-stats-shots';
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

const MOCK = {
  pokejam_is_admin: true,
  pokejam_admin_reports: [],
  pokejam_admin_stats: {
    players_today: 42, players_7d: 187, players_all: 1234, profiles_all: 1502, games_today: 63, games_today_finished: 51,
    games_all: 4821, games_all_finished: 4377, playing_now_matches: 3, playing_now_players: 6, queue_now: 2,
    today_starts: '2026-10-28T07:00:00Z', generated_at: '2026-10-28T23:41:00Z', // midnight PDT, 4:41 PM PT
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
const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'mock-moderator@example.com', is_anonymous: false };
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated' })}.mock`,
  refresh_token: 'mock', token_type: 'bearer', expires_in: 3600, expires_at: exp, user,
};

const chrome = process.env.CHROME || (() => {
  const dir = join(homedir(), '.cache/ms-playwright');
  const c = existsSync(dir) && readdirSync(dir).filter((d) => d.startsWith('chromium-')).sort().pop();
  return c ? join(dir, c, 'chrome-linux64/chrome') : undefined;
})();
const browser = await chromium.launch({ executablePath: chrome });
try {
  for (const [name, viewport] of [['admin-desktop', { width: 1280, height: 900 }], ['admin-390x844', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.addInitScript((s) => {
      localStorage.setItem('pokejam.admin.auth', s);
      addEventListener('DOMContentLoaded', () => {
        const tag = document.createElement('div');
        tag.textContent = 'MOCK DATA — screenshot only';
        // A banner at the top (not floating) so full-page shots don't cover any numbers.
        tag.style.cssText = 'padding:6px 10px;text-align:center;background:#c0262d;color:#fff;font:700 14px sans-serif';
        document.body.prepend(tag);
      });
    }, JSON.stringify(session));
    await page.route(`${SB}/**`, (route) => {
      const fn = new URL(route.request().url()).pathname.match(/\/rest\/v1\/rpc\/(\w+)/)?.[1];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fn && fn in MOCK ? MOCK[fn] : fn ? [] : {}) });
    });
    await page.goto(site);
    await page.waitForSelector('[data-offline-body] .stat-grid');
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    console.log(join(out, `${name}.png`));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
