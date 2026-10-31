// Ranked: placements, tiers and divisions (rules in rank.ts).
// Online (Supabase configured): two real players are matched by the server, which rates the match; the rating shown
// here is always read back from the server. Not configured: the local mock (CPU opponent, rating in localStorage).
import { SIGNIN_GOOGLE } from '../../config/features';
import { esc } from '../../util';
import { runMatch, panel } from '../shared/matchFlow';
import { LocalMockMatchService, type ReportOutcome } from '../shared/matchService';
import { playOnline } from '../shared/onlineGame';
import { ensureHuman, humanDeps } from '../shared/human';
import { OnlineError, SupabaseMatchService } from '../shared/onlineMatchService';
import { ONLINE_CONFIGURED, ensureSignedIn, supabase } from '../shared/supabase';
import type { ModeContext } from '../shared/types';
import { phantomAction, signInWithPhantom, WalletError } from '../../wallet/phantom';
import { isGuest, signInWithGoogle } from './account';
import { badgeImgForTier } from '../../ranked/badge';
import { TIER_COLORS, view, type MatchOutcome, type RankView } from './rank';
import { LocalRankStore } from './rankStore';
import { rankChipHtml, postMatchHtml, signInPanelHtml } from './view';
import { mountUsernamePicker } from './picker';

// The Skip button on a rank-up / rank-down / placed reveal (view.ts): one listener for every reveal on the page.
if (typeof document !== 'undefined' && !(document as unknown as { __rkSkip?: boolean }).__rkSkip) {
  (document as unknown as { __rkSkip?: boolean }).__rkSkip = true;
  document.addEventListener('click', (e) => (e.target as Element | null)?.closest?.('[data-rk-skip]')?.closest('.rk-anim')?.classList.add('skipped'));
}

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

/** Tier badge art with the division and points as text (the local mock). */
function badge(v: RankView): string {
  const color = v.tier ? TIER_COLORS[v.tier] : '#888';
  return `<div class="rank-badge" style="--rc:${color}">${badgeImgForTier(v.tier, 'rank-badge-img')}<strong>${esc(v.tier ? `${v.tier}${v.division ? ` ${v.division}` : ''}` : 'Unranked')}</strong><span>${esc(v.placed ? `${v.rp} RP` : v.label.replace('Unranked, ', ''))}</span></div>`;
}

const localBadge = () => badge(view(store.get()));

function outcomeHtml(out: ReportOutcome): string {
  if (out.result) return postMatchHtml(out); // Season 1 server
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
    <div class="rk-home">
      <div class="rk-left" data-rank><p class="note">Loading your rank…</p></div>
      <div class="rk-right" data-rk-actions>
        <button class="btn" data-a="cpu">Practice vs CPU (unranked)</button>
        <button class="btn ghost" data-a="back">Back</button>
      </div>
    </div>`);
  root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  root.querySelector('[data-a="cpu"]')!.addEventListener('click', () => playPractice(ctx));
  void renderHome(ctx);
}

/** Who am I? A guest sees the sign-in panel; a signed-in player without a username picks one; then the rank chip and Find match. */
async function renderHome(ctx: ModeContext) {
  const { root } = ctx;
  const slot = root.querySelector<HTMLElement>('[data-rank]')!;
  const actions = root.querySelector<HTMLElement>('[data-rk-actions]')!;
  const sb = supabase();
  try {
    const { data } = await sb.auth.getSession();
    if (!slot.isConnected) return;
    if (isGuest(data.session?.user)) return mountSignIn(slot, { returnTo: 'ranked', onSignedIn: () => openRanked(ctx) });
    const svc = await online(ctx);
    const have = await svc.myUsername().catch(() => null);
    if (!slot.isConnected) return;
    // Ranked needs a username (the server refuses the queue without one): pick it before the first search.
    if (have && !have.username) {
      return mountUsernamePicker(slot, svc, { note: 'Pick a username for Ranked. Other players see it. 3 to 16 letters, numbers or underscores; you can change it once every 30 days.', onDone: () => openRanked(ctx) });
    }
    const me = await svc.rankedMe().catch(() => null);
    if (!slot.isConnected) return;
    slot.innerHTML = rankChipHtml(me);
    actions.insertAdjacentHTML('afterbegin', '<button class="btn primary big" data-a="find">Find ranked match</button>');
    actions.querySelector('[data-a="find"]')!.addEventListener('click', () => void quickMatch(ctx));
  } catch {
    if (slot.isConnected) slot.innerHTML = '<p class="note">Could not load your rank from the server.</p>';
  }
}

/** The signed-in ranked/profile service (shared with the profile screen). */
export async function rankedAccount(): Promise<SupabaseMatchService> {
  const sb = supabase();
  const uid = await ensureSignedIn(sb);
  service ??= new SupabaseMatchService(sb, uid, ['ranked'], (force) => ensureHuman(humanDeps(sb), force));
  return service;
}

/**
 * Ranked is for signed-in accounts: a Phantom wallet, plus Google (links the guest account so stats carry over) when the
 * SIGNIN_GOOGLE build flag is on. Also used by the profile screen.
 */
export function mountSignIn(slot: HTMLElement, o: { returnTo: 'ranked' | 'profile'; onSignedIn(): void; error?: string | null; busy?: boolean }) {
  slot.innerHTML = signInPanelHtml(phantomAction(), { busy: o.busy, error: o.error ?? null });
  const sb = supabase();
  const again = (error: string | null = null, busy = false) => mountSignIn(slot, { ...o, error, busy });
  const fail = (e: unknown) => again(e instanceof Error ? e.message : 'Could not sign in.');
  // Flag off: no Google button is rendered and this branch is dropped from the build, so Google sign-in can't be started.
  if (SIGNIN_GOOGLE) {
    slot.querySelector('[data-a="google"]')?.addEventListener('click', () => {
      again(null, true);
      signInWithGoogle(sb, location, undefined, o.returnTo).catch(fail); // on success the browser leaves for Google and comes back to this page
    });
  }
  slot.querySelector('[data-a="phantom"]')?.addEventListener('click', async () => {
    again(null, true);
    try {
      await signInWithPhantom(sb);
      service = null; // a different account now
      o.onSignedIn();
    } catch (e) {
      if (e instanceof WalletError && e.cancelled) again();
      else fail(e);
    }
  });
}

function failed(ctx: ModeContext, e: unknown) {
  const msg = e instanceof OnlineError || e instanceof Error ? e.message : 'Something went wrong.';
  if (/signed-in account/i.test(msg) || /username:required/.test(msg)) return openRanked(ctx); // a guest session, or no username yet: back to the sign-in / picker
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
