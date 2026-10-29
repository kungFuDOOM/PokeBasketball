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
  for (const [name, viewport] of [['admin-desktop', { width: 1280, height: 800 }], ['admin-390x844', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.addInitScript((s) => {
      localStorage.setItem('pokejam.admin.auth', s);
      addEventListener('DOMContentLoaded', () => {
        const tag = document.createElement('div');
        tag.textContent = 'MOCK DATA — screenshot only';
        tag.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9;padding:4px 10px;border-radius:6px;background:#c0262d;color:#fff;font:700 13px sans-serif';
        document.body.append(tag);
      });
    }, JSON.stringify(session));
    await page.route(`${SB}/**`, (route) => {
      const fn = new URL(route.request().url()).pathname.match(/\/rest\/v1\/rpc\/(\w+)/)?.[1];
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fn && fn in MOCK ? MOCK[fn] : fn ? [] : {}) });
    });
    await page.goto(site);
    await page.waitForSelector('.stat-grid');
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(join(out, `${name}.png`));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
