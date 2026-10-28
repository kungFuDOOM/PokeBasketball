// Ranked: placements, tiers and divisions (rules in rank.ts).
// Online (Supabase configured): two real players are matched by the server, which rates the match; the rating shown
// here is always read back from the server. Not configured: the local mock (CPU opponent, rating in localStorage).
import { esc } from '../../util';
import { runMatch, panel } from '../shared/matchFlow';
import { LocalMockMatchService, type ReportOutcome } from '../shared/matchService';
import { playOnline } from '../shared/onlineGame';
import { ensureHuman, humanDeps } from '../shared/human';
import { OnlineError, SupabaseMatchService } from '../shared/onlineMatchService';
import { ONLINE_CONFIGURED, ensureSignedIn, supabase } from '../shared/supabase';
import type { ModeContext } from '../shared/types';
import { TIER_COLORS, view, type MatchOutcome, type RankView } from './rank';
import { LocalRankStore } from './rankStore';
import { serverView } from './serverRank';

const store = new LocalRankStore();
const localService = new LocalMockMatchService(store);
/** CPU practice: no rating store, so it can never change a rating (local or server). */
const practiceService = new LocalMockMatchService();
/** Offer CPU practice after searching this long. */
const CPU_OFFER_MS = 30_000;

let service: SupabaseMatchService | null = null;

async function online(ctx: ModeContext): Promise<SupabaseMatchService> {
  const sb = supabase();
  const uid = await ensureSignedIn(sb);
  service ??= new SupabaseMatchService(sb, uid, ['ranked'], (force) => ensureHuman(humanDeps(sb), force));
  await service.setName(ctx.settings.teamName || 'Trainer');
  return service;
}

/** Text-and-colour badge. Placeholder: final badge art will come from the image generator. */
function badge(v: RankView): string {
  const color = v.tier ? TIER_COLORS[v.tier] : '#888';
  return `<div class="rank-badge" style="--rc:${color}"><strong>${esc(v.tier ? `${v.tier}${v.division ? ` ${v.division}` : ''}` : 'Unranked')}</strong><span>${esc(v.placed ? `${v.rp} RP` : v.label.replace('Unranked, ', ''))}</span></div>`;
}

const localBadge = () => badge(view(store.get()));

function outcomeHtml(out: ReportOutcome): string {
  const o = out.rank as MatchOutcome | undefined;
  if (!o) {
    if (out.status === 'pending') return '<p class="note center">Waiting for your opponent to confirm the result. Your rank updates when they do.</p>';
    if (out.status === 'void') return '<p class="note center">The two results did not match, so this match was not rated.</p>';
    return '';
  }
  const name = `${o.after.tier}${o.after.division ? ` ${o.after.division}` : ''}`;
  const msg = o.event === 'placed' ? `Placements complete! You placed ${o.after.label}.`
    : o.event === 'promoted' ? `Rank up! ${name}`
    : o.event === 'demoted' ? `Demoted to ${name}`
    : o.event === 'shielded' ? 'Demotion protection saved your division.'
    : o.after.label;
  return `<div class="mp-outcome">${badge(o.after)}<p><strong>${esc(msg)}</strong></p><p class="note">MMR ${o.mmrDelta >= 0 ? '+' : ''}${o.mmrDelta}</p></div>`;
}

const PRACTICE_NOTE = '<p class="note center">Practice match: unranked, your rating is unchanged.</p>';

const playPractice = (ctx: ModeContext) =>
  runMatch({ ...ctx, back: () => openRanked(ctx) }, { queue: 'ranked', service: practiceService, practice: true, outcomeHtml: () => PRACTICE_NOTE });

export function openRanked(ctx: ModeContext) {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  const intro = 'Play 5 placement matches to earn a rank: Bronze, Silver, Gold, Platinum, Diamond, then Pokémon Master.';
  if (!ONLINE_CONFIGURED) {
    root.innerHTML = panel('RANKED', `${intro} Online play is not set up in this build, so opponents are simulated and your rank stays on this device.`, `
      <div class="mp-outcome">${localBadge()}</div>
      <div class="actions center">
        <button class="btn primary big" data-a="find">Find ranked match</button>
        <button class="btn ghost" data-a="back">Back</button>
      </div>`);
    root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
    root.querySelector('[data-a="find"]')!.addEventListener('click', () =>
      runMatch({ ...ctx, back: () => openRanked(ctx) }, { queue: 'ranked', service: localService, outcomeHtml }));
    return;
  }
  root.innerHTML = panel('RANKED', intro, `
    <div class="mp-outcome" data-rank><p class="note">Loading your rank…</p></div>
    <div class="actions center">
      <button class="btn primary big" data-a="find">Find ranked match</button>
      <button class="btn" data-a="cpu">Practice vs CPU (unranked)</button>
      <button class="btn ghost" data-a="back">Back</button>
    </div>`);
  root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  root.querySelector('[data-a="cpu"]')!.addEventListener('click', () => playPractice(ctx));
  root.querySelector('[data-a="find"]')!.addEventListener('click', () => void quickMatch(ctx));
  const slot = root.querySelector<HTMLElement>('[data-rank]')!;
  online(ctx).then((svc) => svc.myRank()).then(
    (r) => { if (slot.isConnected) slot.innerHTML = badge(serverView(r)); },
    () => { if (slot.isConnected) slot.innerHTML = '<p class="note">Could not load your rank from the server.</p>'; },
  );
}

function failed(ctx: ModeContext, e: unknown) {
  const msg = e instanceof OnlineError || e instanceof Error ? e.message : 'Something went wrong.';
  const nice = /anonymous/i.test(msg) ? 'Online sign-in is switched off on the server right now.' : msg;
  ctx.root.className = 'screen-menu';
  ctx.root.innerHTML = panel('OFFLINE', nice, `<div class="actions center">
      <button class="btn primary" data-a="cpu">Practice vs CPU (unranked)</button>
      <button class="btn ghost" data-a="back">Back</button></div>`);
  ctx.root.querySelector('[data-a="cpu"]')!.addEventListener('click', () => playPractice(ctx));
  ctx.root.querySelector('[data-a="back"]')!.addEventListener('click', () => openRanked(ctx));
}

async function quickMatch(ctx: ModeContext) {
  const { root } = ctx;
  const abort = new AbortController();
  root.className = 'screen-menu';
  root.innerHTML = panel('SEARCHING', 'Looking for a ranked opponent near your skill…', `
    <div class="actions center">
      <button class="btn primary" data-a="cpu" hidden>Practice vs CPU (unranked)</button>
      <button class="btn ghost" data-a="cancel">Cancel</button>
    </div>`);
  const cpuBtn = root.querySelector<HTMLButtonElement>('[data-a="cpu"]')!;
  const offer = setTimeout(() => {
    cpuBtn.hidden = false;
    root.querySelector('.tag')!.textContent = 'No one is around yet. Keep waiting, or play the CPU for practice (unranked, no rating change).';
  }, CPU_OFFER_MS);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => { clearTimeout(offer); abort.abort(); openRanked(ctx); });
  cpuBtn.addEventListener('click', () => { abort.abort(); playPractice(ctx); });
  try {
    const svc = await online(ctx);
    const match = await svc.quickMatch('ranked', abort.signal);
    clearTimeout(offer);
    const home: ModeContext = { ...ctx, back: () => openRanked(ctx) };
    void playOnline(home, { sb: supabase(), service: svc, match, playAgain: () => void quickMatch(ctx), outcomeHtml });
  } catch (e) {
    clearTimeout(offer);
    if ((e as Error).name !== 'AbortError') failed(ctx, e);
  }
}
