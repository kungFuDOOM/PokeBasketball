// The moderation page (admin.html): reported players, suspensions and the moderators' action log, with suspend,
// lift and reset-name actions. Not linked from the game. Moderators sign in with an email link to an existing
// account listed in pokejam_admins (migration 20261031); every call is checked on the server, so the page shows
// nothing to anyone else. Its session is kept apart from the game's anonymous one (its own storage key).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import '../fonts.css';
import '../style.css';
import './admin.css';
import { CAPTCHA_ON, captchaToken } from '../multiplayer/shared/captcha';
import { esc } from '../util';
import { bansHtml, personLabel, reportsHtml, when, type Ban, type Reported } from './reportsView';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const root = document.querySelector<HTMLElement>('#admin')!;

interface LogRow { at: string; action: string; detail: string | null; target: string | null; by: string | null }

interface Stats {
  players_today: number; players_7d: number; players_all: number; profiles_all: number; games_today: number; games_today_finished: number;
  games_all: number; games_all_finished: number; playing_now_matches: number; playing_now_players: number; queue_now: number;
  today_starts: string; generated_at: string;
}

type ModeCounts = Partial<Record<'quick' | 'franchise' | 'season_draft', { started: number; finished: number }>>;
type SeasonCounts = Partial<Record<'franchise' | 'season_draft', { seasons: number; playoffs: number; titles: number }>>;
interface OfflineStats {
  players_today: number; players_7d: number; players_all: number;
  games_today: ModeCounts; games_all: ModeCounts;
  finish_today: { played: number; watched: number; simmed: number }; finish_all: { played: number; watched: number; simmed: number };
  seasons_today: SeasonCounts; seasons_all: SeasonCounts;
  first_event_at: string | null; today_starts: string; generated_at: string;
}
const MODE_LABEL = { quick: 'Quick Play', franchise: 'Franchise', season_draft: 'Season Draft' } as const;


function shell(inner: string) {
  root.innerHTML = `<main class="admin"><header><h1>Poké Jam moderation</h1><span data-who></span></header>${inner}</main>`;
}

async function main() {
  if (!URL || !KEY) {
    shell('<p class="note">Online play isn\'t configured in this build, so there is nothing to moderate here.</p>');
    return;
  }
  const sb = createClient(URL, KEY, { auth: { storageKey: 'pokejam.admin.auth', persistSession: true, detectSessionInUrl: true } });
  const { data } = await sb.auth.getSession();
  const user = data.session?.user;
  if (!user || user.is_anonymous) return signIn(sb);
  const { data: isAdmin } = await sb.rpc('pokejam_is_admin');
  if (isAdmin !== true) {
    shell(`<p class="note">${esc(user.email ?? 'This account')} isn't a moderator.</p><button class="btn" data-out>Sign out</button>`);
    root.querySelector('[data-out]')!.addEventListener('click', () => void sb.auth.signOut().then(() => location.reload()));
    return;
  }
  dashboard(sb, user.email ?? '');
}

function signIn(sb: SupabaseClient) {
  shell(`<form class="card" data-form>
      <p>Moderators only. Enter your email and we'll send you a sign-in link.</p>
      <input type="email" name="email" required autocomplete="email" placeholder="you@example.com" aria-label="Email">
      <button class="btn primary" type="submit">Send link</button>
      <p class="note" data-msg hidden></p>
    </form>`);
  const form = root.querySelector<HTMLFormElement>('[data-form]')!;
  const msg = root.querySelector<HTMLElement>('[data-msg]')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(form).get('email') as string;
    const captcha = CAPTCHA_ON ? await captchaToken('Quick check before we send the link.').catch(() => undefined) : undefined;
    const { error } = await sb.auth.signInWithOtp({
      email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname, captchaToken: captcha },
    });
    msg.hidden = false;
    msg.textContent = error ? `Couldn't send it: ${error.message}` : 'Check your email for the sign-in link.';
  });
}

function dashboard(sb: SupabaseClient, email: string) {
  shell(`<section class="stats"><div class="stats-head"><h2>Stats</h2><button class="btn small" data-refresh>Refresh</button></div>
      <h3>Online</h3><div data-stats-body><p class="note">Loading…</p></div>
      <h3>Offline (Quick Play / CPU / Franchise)</h3>
      <p class="note">Offline counting started with this update (Oct 2026); earlier offline games aren't counted.</p>
      <div data-offline-body><p class="note">Loading…</p></div></section>
    <nav class="tabs">
      <button class="on" data-tab="reports">Reported</button><button data-tab="bans">Suspended</button><button data-tab="log">History</button>
      <label>Last <select data-days><option>1</option><option selected>7</option><option>30</option></select> days</label>
    </nav><section data-body><p class="note">Loading…</p></section>`);
  root.querySelector('[data-who]')!.innerHTML = `${esc(email)} · <button class="link" data-out>Sign out</button>`;
  root.querySelector('[data-out]')!.addEventListener('click', () => void sb.auth.signOut().then(() => location.reload()));
  const body = root.querySelector<HTMLElement>('[data-body]')!;
  const days = root.querySelector<HTMLSelectElement>('[data-days]')!;
  let tab = 'reports';
  let judged = false;
  const call = async <T>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  };

  const show = async () => {
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    days.parentElement!.hidden = tab !== 'reports';
    try {
      if (tab === 'reports') {
        const rows = await call<Reported[]>('pokejam_admin_reports', { p_days: Number(days.value) });
        body.innerHTML = reportsHtml(rows);
        // Judge reported matches that have uploads but no verdict, then reload. At most once per page load, so a
        // match the judge skips (too large, say) cannot loop; if it fails the rows simply stay "No check".
        const match_ids = [...new Set(rows.flatMap((r) => (r.checks ?? []).filter((c) => c.has_evidence && c.status === null).map((c) => c.match_id)))];
        if (match_ids.length && !judged) {
          judged = true;
          const { error } = await sb.functions.invoke('pokejam-judge', { body: { match_ids } }).catch((x: Error) => ({ error: x }));
          if (!error && tab === 'reports') body.innerHTML = reportsHtml(await call<Reported[]>('pokejam_admin_reports', { p_days: Number(days.value) }));
        }
      }
      else if (tab === 'bans') body.innerHTML = bansHtml(await call<Ban[]>('pokejam_admin_bans'));
      else body.innerHTML = logHtml(await call<LogRow[]>('pokejam_admin_history', { p_limit: 100 }));
    } catch (e) {
      body.innerHTML = `<p class="note">Couldn't load: ${esc((e as Error).message)}</p>`;
    }
  };
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab!; void show(); }));
  days.addEventListener('change', () => void show());
  body.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    const user = b.dataset.user!;
    const name = personLabel(b.dataset.name ?? 'this player', b.dataset.role);
    const act = b.dataset.act!;
    const n = Number(b.dataset.reports ?? 0);
    const ask = act === 'unban' ? `Lift the suspension on ${name}?` : act === 'name' ? `Reset ${name}'s name to "Trainer"?`
      : act === 'dismiss' ? `Clear ${n} open report${n === 1 ? '' : 's'} on ${name}?`
      : `Suspend ${name} ${act === '0' ? 'permanently' : `for ${Number(act) >= 168 ? `${Number(act) / 24} days` : `${act} hours`}`}?`;
    if (!confirm(ask)) return;
    b.disabled = true;
    try {
      if (act === 'unban') await call('pokejam_admin_unban', { p_user: user });
      else if (act === 'name') await call('pokejam_admin_reset_name', { p_user: user });
      else if (act === 'dismiss') await call('pokejam_admin_dismiss', { p_user: user });
      else await call('pokejam_admin_ban', { p_user: user, p_hours: Number(act), p_reason: prompt('Reason (kept in the log):', 'reports reviewed') ?? 'reports reviewed' });
      await show();
    } catch (x) {
      alert(`Didn't work: ${(x as Error).message}`);
      b.disabled = false;
    }
  });
  const statsBody = root.querySelector<HTMLElement>('[data-stats-body]')!;
  const refresh = root.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const offlineBody = root.querySelector<HTMLElement>('[data-offline-body]')!;
  const loadStats = async () => {
    refresh.disabled = true;
    await Promise.all([
      (async () => {
        try {
          statsBody.innerHTML = statsHtml(await call<Stats>('pokejam_admin_stats'));
        } catch (e) {
          statsBody.innerHTML = `<p class="note">Couldn't load stats: ${esc((e as Error).message)}</p>`;
        }
      })(),
      (async () => {
        try {
          offlineBody.innerHTML = offlineHtml(await call<OfflineStats>('pokejam_admin_offline_stats'));
        } catch {
          offlineBody.innerHTML = '<p class="note">Offline stats unavailable.</p>';
        }
      })(),
    ]);
    refresh.disabled = false;
  };
  refresh.addEventListener('click', () => void loadStats());
  void loadStats();
  void show();
}

function statsHtml(s: Stats): string {
  const tile = (label: string, n: number, sub = '') => `<div class="stat"><b>${n}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  const pt = (iso: string) => new Date(iso).toLocaleString([], { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
  return `<div class="stat-grid">
    ${tile('Players today (PT)', s.players_today)}${tile('Players, last 7 days', s.players_7d)}${tile('Players, all time', s.players_all)}
    ${tile('Accounts gone online', s.profiles_all)}
    ${tile('Games today (PT)', s.games_today, `${s.games_today_finished} finished`)}${tile('Games, all time', s.games_all, `${s.games_all_finished} finished`)}
    ${tile('Playing now', s.playing_now_matches, `${s.playing_now_players} players`)}${tile('Searching now', s.queue_now)}
  </div><p class="note">“Today” = Pacific time, since ${esc(pt(s.today_starts))} PT. Updated ${esc(pt(s.generated_at))} PT.</p>`;
}

function offlineHtml(s: OfflineStats): string {
  const tile = (label: string, n: number, sub = '') => `<div class="stat"><b>${n}</b><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  const pt = (iso: string) => new Date(iso).toLocaleString([], { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' });
  const sum = (g: OfflineStats['games_all'], k: 'started' | 'finished') => Object.values(g).reduce((n, m) => n + m[k], 0);
  const games = (label: string, g: OfflineStats['games_all']) => tile(label, sum(g, 'started'), `${sum(g, 'finished')} finished · ${
    (['quick', 'franchise'] as const).map((m) => `${MODE_LABEL[m]} ${g[m]?.started ?? 0}/${g[m]?.finished ?? 0}`).join(' · ')}`);
  const split = (f: OfflineStats['finish_all']) => `${f.played} played · ${f.watched} watched · ${f.simmed} simmed`;
  const seasons = (label: string, mode: 'franchise' | 'season_draft', when: OfflineStats['seasons_all']) => {
    const x = when[mode] ?? { seasons: 0, playoffs: 0, titles: 0 };
    return tile(label, x.seasons, `${x.playoffs} playoff runs · ${x.titles} titles`);
  };
  return `<div class="stat-grid">
    ${tile('Players today (PT)', s.players_today)}${tile('Players, last 7 days', s.players_7d)}${tile('Players, all time', s.players_all)}
    ${games('Games today (PT)', s.games_today)}${games('Games, all time', s.games_all)}
    ${tile('Finished today (PT)', s.finish_today.played + s.finish_today.watched + s.finish_today.simmed, split(s.finish_today))}
    ${tile('Finished, all time', s.finish_all.played + s.finish_all.watched + s.finish_all.simmed, split(s.finish_all))}
    ${seasons('Franchise seasons today', 'franchise', s.seasons_today)}${seasons('Franchise seasons, all time', 'franchise', s.seasons_all)}
    ${seasons('Season Drafts, all time', 'season_draft', s.seasons_all)}
  </div><p class="note">Players = distinct browsers (random id per device). Games: started/finished by mode. ${
    s.first_event_at ? `First offline event ${esc(pt(s.first_event_at))} PT.` : 'No offline events yet.'} Updated ${esc(pt(s.generated_at))} PT.</p>`;
}

function logHtml(rows: LogRow[]): string {
  if (!rows.length) return '<p class="note">No moderator actions yet.</p>';
  return `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>Did</th><th>To</th><th>Detail</th></tr></thead><tbody>
    ${rows.map((l) => `<tr><td>${esc(when(l.at))}</td><td>${esc(l.by ?? '')}</td><td>${esc(l.action)}</td><td>${esc(l.target ?? '')}</td><td>${esc(l.detail ?? '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

void main();
