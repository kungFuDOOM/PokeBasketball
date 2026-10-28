// Two-client end-to-end test for Social online play, against a running dev server and the real Supabase project.
//
//   VITE_MODE_SOCIAL=true VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npx vite --port 5173 &
//   VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… node scripts/e2e-social.mjs
//
// Env: E2E_BASE (default http://localhost:5173), E2E_CHROME (Chrome/Chromium binary), E2E_SHOTS (screenshot dir),
// E2E_CREDS (optional JSON {password, users:[{email},{email}]} to sign in two test accounts by password instead of
// anonymously; only for projects where anonymous sign-in is off). Never prints keys or tokens.
import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL_ = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_ANON_KEY;
const BASE = process.env.E2E_BASE ?? 'http://localhost:5173';
const SHOTS = process.env.E2E_SHOTS ?? 'e2e-shots';
const CHROME = process.env.E2E_CHROME ?? '/usr/bin/google-chrome';
if (!URL_ || !KEY) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
// The script itself only uses REST; Realtime (not available in Node 20 without ws) is never opened.
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: class {} } });

// ---------- accounts ----------
async function signIn(i) {
  const sb = client();
  if (process.env.E2E_CREDS) {
    const c = JSON.parse(readFileSync(process.env.E2E_CREDS, 'utf8'));
    const { data, error } = await sb.auth.signInWithPassword({ email: c.users[i].email, password: c.password });
    if (error) throw new Error(`password sign-in failed: ${error.message}`);
    return { sb, session: data.session };
  }
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`);
  return { sb, session: data.session };
}
const players = [await signIn(0), await signIn(1)];
const names = ['Host Town', 'Guest City'];
for (const [i, p] of players.entries()) await p.sb.rpc('pokejam_ensure_profile', { p_name: names[i] });

const profile = async (p) => (await p.sb.from('pokejam_profiles').select('mmr,ladder,placements,wins,losses,shield,rp,tier').eq('id', p.session.user.id).single()).data;
const before = [await profile(players[0]), await profile(players[1])];

// ---------- server security checks ----------
{
  const a = players[0].sb;
  const upd = await a.from('pokejam_profiles').update({ mmr: 3000 }).eq('id', players[0].session.user.id).select();
  check('client cannot write its own rating (direct UPDATE rejected)', upd.error || (upd.data ?? []).length === 0, upd.error?.code ?? 'no rows');
  const ins = await a.from('pokejam_matches').insert({ queue: 'ranked', host: players[0].session.user.id, host_mmr: 1000 }).select();
  check('client cannot create matches directly (INSERT rejected)', !!ins.error, ins.error?.code);
  const rank = await a.rpc('pokejam_apply_rank', { p_user: players[0].session.user.id, p_opp: 1000, p_won: true });
  check('client cannot call the internal rating function', !!rank.error, rank.error?.code);
  const anon = await client().rpc('pokejam_find_match', { p_queue: 'social' });
  check('signed-out callers cannot use the matchmaking RPCs', !!anon.error, anon.error?.code);
  const other = await players[1].sb.from('pokejam_queue').select('*');
  check('a player only sees their own queue row', !other.error && (other.data ?? []).every((r) => r.user_id === players[1].session.user.id));
}

// ---------- browsers ----------
const browsers = [await chromium.launch({ executablePath: CHROME }), await chromium.launch({ executablePath: CHROME })];
const pages = [];
for (const [i, b] of browsers.entries()) {
  const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
  const session = players[i].session;
  await ctx.addInitScript(([s, name, inject]) => {
    if (inject) localStorage.setItem('pokejam.auth', s);
    localStorage.setItem('pokejam.settings', JSON.stringify({ difficulty: 'pro', quarterLen: 60, teamName: name }));
  }, [JSON.stringify(session), names[i], !!process.env.E2E_CREDS]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[page ${i}] error: ${e.message}`));
  pages.push(page);
}

const QL = 6; // seconds per quarter
const openSocial = async (p) => {
  await p.goto(`${BASE}/?ql=${QL}`);
  await p.click('[data-go="multiplayer"]');
  await p.click('[data-m="social"]');
};

/** The Social draft (#28): both players take the first Pokemon they can, until the match starts. Both must see the same teams. */
async function draft(tag) {
  await Promise.all(pages.map((p) => p.waitForSelector('.sdraft', { timeout: 30_000 })));
  const teams = (p) => p.$$eval('.sd-team', (ts) => ts.map((t) => [...t.querySelectorAll('.sd-slot span')].map((s) => s.textContent)));
  let seen = [];
  for (let i = 0; i < 400; i++) {
    if ((await Promise.all(pages.map((p) => p.$('canvas.court')))).every(Boolean)) break;
    for (const p of pages) await p.click('.sd-card.ok', { timeout: 200 }).catch(() => {});
    if ((await Promise.all(pages.map((p) => p.$('.sd-turn')))).every(Boolean)) {
      const t = await Promise.all(pages.map((p) => teams(p).catch(() => null)));
      if (t.every(Boolean) && t.every((x) => x.flat().every((n) => n !== '—'))) seen = t;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (seen.length === 2) {
    await pages[0].screenshot({ path: `${SHOTS}/social-${tag}-draft.png` });
    // Each page lists its own team first, so host's [me, them] is guest's [them, me].
    check(`${tag}: both players drafted the same two teams`, JSON.stringify(seen[0]) === JSON.stringify([seen[1][1], seen[1][0]]));
  }
}

/** Mash keys on both pages until both reach the results screen. */
async function playToEnd(tag) {
  await draft(tag);
  const keys = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyK', 'ShiftLeft'];
  let done = false;
  const masher = (async () => {
    let n = 0;
    while (!done) {
      for (const p of pages) {
        const k = keys[(n + pages.indexOf(p) * 3) % keys.length];
        await p.keyboard.down(k).catch(() => {});
        setTimeout(() => p.keyboard.up(k).catch(() => {}), 120 + (n % 5) * 60);
      }
      n++;
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  await Promise.all(pages.map((p) => p.waitForSelector('canvas.court', { timeout: 60_000 })));
  await new Promise((r) => setTimeout(r, 4000));
  await pages[0].screenshot({ path: `${SHOTS}/social-${tag}-host-ingame.png` });
  await pages[1].screenshot({ path: `${SHOTS}/social-${tag}-guest-ingame.png` });
  await Promise.all(pages.map((p) => p.waitForSelector('.results', { timeout: 240_000 })));
  done = true;
  await masher;
  await new Promise((r) => setTimeout(r, 2500)); // let both reports land
  await pages[0].screenshot({ path: `${SHOTS}/social-${tag}-host-results.png` });
  await pages[1].screenshot({ path: `${SHOTS}/social-${tag}-guest-results.png` });
  const info = await Promise.all(pages.map((p) => p.evaluate(() => window.__pokejamOnline)));
  check(`${tag}: both clients finished with the identical game state`, info[0]?.hash === info[1]?.hash, `hash ${info[0]?.hash} / ${info[1]?.hash}`);
  check(`${tag}: same final score on both screens`, JSON.stringify(info[0]?.score) === JSON.stringify(info[1]?.score), JSON.stringify(info[0]?.score));
  check(`${tag}: one host and one guest`, info[0]?.side !== info[1]?.side);
  console.log(`      ${tag} netcode: delay ${info.map((x) => x?.delay).join('/')} ticks, stalls ${info.map((x) => x?.stats?.stalls).join('/')}, desyncs ${info.map((x) => x?.stats?.desyncs).join('/')}, resyncs ${info.map((x) => x?.stats?.resyncs).join('/')}`);
  const st = await players[0].sb.rpc('pokejam_match_status', { p_match: info[0]?.matchId });
  check(`${tag}: server recorded the result (both reports agree)`, st.data?.status === 'done', JSON.stringify(st.data));
  const host = info[0].side === 0 ? 0 : 1;
  const hostWon = info[host].score[0] > info[host].score[1];
  const winnerId = players[hostWon ? host : 1 - host].session.user.id;
  check(`${tag}: server winner matches the game`, st.data?.winner === winnerId);
  return info;
}

// Round 1: Play a friend with a room code.
await Promise.all(pages.map(openSocial));
await pages[0].click('[data-a="friend"]');
await pages[0].click('[data-a="create"]');
const code = (await (await pages[0].waitForSelector('[data-code]')).textContent()).trim();
check('room code is 6 characters', /^[A-Z0-9]{6}$/.test(code));
await pages[0].screenshot({ path: `${SHOTS}/social-room-code.png` });
await pages[1].click('[data-a="friend"]');
await pages[1].fill('input[name="code"]', code);
await pages[1].click('form.room-join button');
await playToEnd('room');

// Round 2: Quick match.
await Promise.all(pages.map(openSocial));
await pages[0].click('[data-a="quick"]');
await new Promise((r) => setTimeout(r, 1500));
await pages[0].screenshot({ path: `${SHOTS}/social-quick-searching.png` });
await pages[1].click('[data-a="quick"]');
await playToEnd('quick');

// Ratings: Social never touches them.
const after = [await profile(players[0]), await profile(players[1])];
check('social matches left both ratings untouched', JSON.stringify(after) === JSON.stringify(before), JSON.stringify(after.map((p) => p?.mmr)));

// CPU fallback appears when no one else is searching.
await openSocial(pages[0]);
await pages[0].click('[data-a="quick"]');
await pages[0].waitForSelector('[data-a="cpu"]:not([hidden])', { timeout: 25_000 });
check('"Play CPU instead" is offered when no match is found', true);
await pages[0].screenshot({ path: `${SHOTS}/social-cpu-fallback.png` });
await pages[0].click('[data-a="cpu"]');
await pages[0].waitForSelector('[data-a="play"]', { timeout: 10_000 });
check('CPU fallback starts a game against the CPU', true);
await players[0].sb.rpc('pokejam_leave_queue');

for (const b of browsers) await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
