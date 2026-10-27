// Social: casual, unranked online play. Never touches ratings (the service only plays the 'social' queue and
// the server never rates a Social match).
import { esc } from '../../util';
import { panel, runMatch } from '../shared/matchFlow';
import { LocalMockMatchService } from '../shared/matchService';
import { message, playOnline } from '../shared/onlineGame';
import { runDraft } from './draftScreen';
import { ensureHuman, humanDeps } from '../shared/human';
import { classify } from '../shared/capacity';
import { SupabaseMatchService, type OnlineMatch } from '../shared/onlineMatchService';
import { ONLINE_CONFIGURED, ensureSignedIn, supabase } from '../shared/supabase';
import { tapGuard } from '../shared/throttle';
import type { ModeContext } from '../shared/types';

const cpuService = new LocalMockMatchService(); // no rating store: social can't change rank
const SOCIAL_NOTE = '<p class="note center">Social match: rank unchanged.</p>';
/** Offer "Play CPU instead" after searching this long. */
const CPU_OFFER_MS = 15_000;

let service: SupabaseMatchService | null = null;

async function online(ctx: ModeContext): Promise<SupabaseMatchService> {
  const sb = supabase();
  const uid = await ensureSignedIn(sb);
  // A cleared or expired session signs in as a new anonymous account: the old service would still think it is the old user.
  if (!service || service.userId !== uid) service = new SupabaseMatchService(sb, uid, ['social'], (force) => ensureHuman(humanDeps(sb), force));
  await service.setName(ctx.settings.teamName || 'Trainer');
  return service;
}

/** The search or room in progress: tapping Quick match or Make a room again meanwhile does nothing (until it is cancelled). */
let searching: AbortController | null = null;
let hosting: AbortController | null = null;
const idle = (c: AbortController | null) => !c || c.signal.aborted;

const playCpu = (ctx: ModeContext) =>
  runMatch({ ...ctx, back: () => openSocial(ctx) }, { queue: 'social', service: cpuService, outcomeHtml: () => SOCIAL_NOTE });

export function openSocial(ctx: ModeContext) {
  const { root } = ctx;
  root.className = 'screen-menu';
  window.scrollTo(0, 0);
  root.innerHTML = panel('SOCIAL', ONLINE_CONFIGURED ? 'Casual and unranked. Play someone online or challenge a friend with a room code.' : 'Casual and unranked. Online play is not set up in this build, so opponents are simulated.', `
    <div class="actions center">
      ${ONLINE_CONFIGURED ? `<button class="btn primary big" data-a="quick">Quick match</button>
      <button class="btn" data-a="friend">Play a friend</button>` : ''}
      <button class="btn${ONLINE_CONFIGURED ? '' : ' primary big'}" data-a="cpu">Play CPU</button>
      <button class="btn ghost" data-a="back">Back</button>
    </div>`);
  root.querySelector('[data-a="back"]')!.addEventListener('click', ctx.back);
  root.querySelector('[data-a="cpu"]')!.addEventListener('click', () => playCpu(ctx));
  root.querySelector('[data-a="quick"]')?.addEventListener('click', () => void quickMatch(ctx));
  root.querySelector('[data-a="friend"]')?.addEventListener('click', () => friendMenu(ctx));
}

const home = (ctx: ModeContext): ModeContext => ({ ...ctx, back: () => openSocial(ctx) });

/**
 * An online step failed. Never a dead end: a busy server or a failed bot check says so plainly (capacity.ts), a bot
 * check or expired session offers "Try again", and solo play (CPU) and Back are always there.
 */
function failed(ctx: ModeContext, e: unknown, retry?: () => void) {
  const p = classify(e);
  const title = p.kind === 'busy' ? 'ONLINE IS BUSY' : p.kind === 'botcheck' ? 'BOT CHECK' : 'OFFLINE';
  const canRetry = !!retry && (p.kind === 'botcheck' || p.kind === 'session');
  ctx.root.className = 'screen-menu';
  ctx.root.innerHTML = panel(title, p.message, `<div class="actions center">
      ${canRetry ? '<button class="btn primary" data-a="retry">Try again</button>' : ''}
      <button class="btn${canRetry ? '' : ' primary'}" data-a="cpu">Play CPU instead</button>
      <button class="btn ghost" data-a="back">Back</button></div>`);
  ctx.root.querySelector('[data-a="retry"]')?.addEventListener('click', tapGuard(() => retry!()));
  ctx.root.querySelector('[data-a="cpu"]')!.addEventListener('click', () => playCpu(ctx));
  ctx.root.querySelector('[data-a="back"]')!.addEventListener('click', () => openSocial(ctx));
}

/** A Social match: the quick draft between the two players first (#28), then the game with the drafted teams. */
async function start(ctx: ModeContext, svc: SupabaseMatchService, match: OnlineMatch, again: () => void) {
  const drafted = await runDraft(home(ctx), svc, match);
  if ('failed' in drafted) return failed(ctx, drafted.failed);
  if ('left' in drafted) {
    message(home(ctx), drafted.left === 'them' ? 'OPPONENT LEFT' : 'LEFT THE DRAFT',
      drafted.left === 'them' ? `${match.opponent.name} left during the draft. No result was recorded.` : 'You left the draft. No result was recorded.');
    return;
  }
  void playOnline(home(ctx), { sb: supabase(), service: svc, match: drafted.match, outcomeHtml: SOCIAL_NOTE, playAgain: again });
}

async function quickMatch(ctx: ModeContext) {
  if (!idle(searching)) return; // a double-tap
  const { root } = ctx;
  const abort = searching = new AbortController();
  root.className = 'screen-menu';
  root.innerHTML = panel('SEARCHING', 'Looking for a social opponent…', `
    <div class="actions center">
      <button class="btn primary" data-a="cpu" hidden>Play CPU instead</button>
      <button class="btn ghost" data-a="cancel">Cancel</button>
    </div>`);
  const cpuBtn = root.querySelector<HTMLButtonElement>('[data-a="cpu"]')!;
  const offer = setTimeout(() => {
    cpuBtn.hidden = false;
    root.querySelector('.tag')!.textContent = 'No one is around yet. Keep waiting or play the CPU.';
  }, CPU_OFFER_MS);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => { abort.abort(); openSocial(ctx); });
  cpuBtn.addEventListener('click', () => { abort.abort(); playCpu(ctx); });
  try {
    const svc = await online(ctx);
    const match = await svc.quickMatch('social', abort.signal);
    clearTimeout(offer);
    start(ctx, svc, match, () => void quickMatch(ctx));
  } catch (e) {
    clearTimeout(offer);
    if ((e as Error).name !== 'AbortError') failed(ctx, e, () => void quickMatch(ctx));
  } finally {
    if (searching === abort) searching = null;
  }
}

function friendMenu(ctx: ModeContext) {
  const { root } = ctx;
  root.className = 'screen-menu';
  root.innerHTML = panel('PLAY A FRIEND', 'Make a room and send your friend the code, or join theirs.', `
    <div class="actions center"><button class="btn primary big" data-a="create">Make a room</button></div>
    <form class="room-join" data-a="join">
      <input name="code" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" aria-label="Room code">
      <button class="btn" type="submit">Join</button>
    </form>
    <p class="note center" data-a="err" hidden></p>
    <div class="actions center"><button class="btn ghost" data-a="back">Back</button></div>`);
  const err = root.querySelector<HTMLElement>('[data-a="err"]')!;
  const input = root.querySelector<HTMLInputElement>('input[name="code"]')!;
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
  root.querySelector('[data-a="back"]')!.addEventListener('click', () => openSocial(ctx));
  root.querySelector('[data-a="create"]')!.addEventListener('click', () => void hostRoom(ctx));
  // One join at a time: the button is off while a try is running, so a double-tap is one request.
  const joinBtn = root.querySelector<HTMLButtonElement>('form button')!;
  let joining = false;
  root.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (joining) return;
    joining = true;
    joinBtn.disabled = true;
    err.hidden = true;
    try {
      const svc = await online(ctx);
      const match = await svc.joinRoom(input.value);
      start(ctx, svc, match, () => friendMenu(ctx));
    } catch (x) {
      const p = classify(x);
      if (p.kind === 'busy') return failed(ctx, x);
      err.hidden = false;
      err.textContent = /room not found/i.test(p.message) ? 'No open room with that code.' : p.message;
    } finally {
      joining = false;
      joinBtn.disabled = false;
    }
  });
}

async function hostRoom(ctx: ModeContext) {
  if (!idle(hosting)) return; // a double-tap
  const abort = hosting = new AbortController();
  try {
    await hostRoomOnce(ctx, abort);
  } finally {
    if (hosting === abort) hosting = null;
  }
}

async function hostRoomOnce(ctx: ModeContext, abort: AbortController) {
  const { root } = ctx;
  let svc: SupabaseMatchService;
  let code: string;
  try {
    svc = await online(ctx);
    code = await svc.createRoom(ctx.settings.quarterLen);
  } catch (e) {
    return failed(ctx, e, () => void hostRoom(ctx));
  }
  root.className = 'screen-menu';
  root.innerHTML = panel('YOUR ROOM', 'Send this code to your friend. The game starts when they join.', `
    <div class="room-code" data-code>${esc(code)}</div>
    <div class="actions center"><button class="btn ghost" data-a="cancel">Cancel</button></div>`);
  root.querySelector('[data-a="cancel"]')!.addEventListener('click', () => {
    abort.abort();
    void svc.closeRoom(code);
    friendMenu(ctx);
  });
  try {
    const match = await svc.waitForFriend(code, abort.signal);
    start(ctx, svc, match, () => friendMenu(ctx));
  } catch (e) {
    if ((e as Error).name !== 'AbortError') failed(ctx, e);
  }
}

