// Runs the direct-link browser check (src/demo/rtc-check.ts) in Chrome: a full lockstep game over a real WebRTC
// connection, cut over to the Realtime fallback midway. Build first: npx vite build -c vite.checks.config.ts
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const ROOT = 'checks-out';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer((req, res) => {
  const p = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://localhost:${server.address().port}/rtc-check.html`);
await page.waitForFunction(() => window.rtcCheck);
const r = await page.evaluate(() => window.rtcCheck.run(15_000));
console.log(JSON.stringify(r, null, 1));
const ok = r.directAtStart && r.finished && r.same && JSON.stringify(r.score) === JSON.stringify(r.scoreGuest)
  && r.sent.every((s) => s.direct > 0 && s.realtime > 0) && r.paceOnFallback === 100 && r.stats.every((s) => !s.problem);
console.log(ok ? 'RTC CHECK: PASS' : 'RTC CHECK: FAIL');
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
