// Drives a Phantom deeplink sign-in on screen: the tap that leaves for Phantom, what the page does when Phantom sends the player
// back, and the wait for an answer left in the relay. The rules are in phantomLink.ts.
import { ONLINE_CONFIGURED, supabase } from '../multiplayer/shared/supabase';
import { RETURN_KEY } from '../multiplayer/ranked/account';
import {
  beginHandoff, clearHandoff, clearLanding, finishInSafari, handoffCode, landingStore, landingTrip, loadHandoff, reportFailure, restoreInApp,
} from './phantomHandoff';
import {
  PhantomLinkError, advance, beginConnect, clearPending, isStandalone, loadPending, parseCallback, relayPut, relayTake, routeCallback, savePending, signLink,
  type Callback, type HandoffRef, type Pending, type PhantomResponse, type RelayClient, type ReturnTo, type Store,
} from './phantomLink';
import { sheetBodyHtml, sheetHtml, type SheetState } from './phantomView';

const POLL_MS = 2500;
const relay = () => supabase() as unknown as RelayClient;
const sessionStore = (): Store => window.sessionStorage;
const localStore = (): Store => window.localStorage;
/** Set while this page is Safari finishing a home-screen app's sign-in: the trip state is then in localStorage, not sessionStorage. */
let landingCtx: HandoffRef | null = null;
const tripStore = (): Store => (landingCtx ? landingStore(localStore()) : sessionStore());
const here = () => ({ origin: location.origin, pathname: location.pathname });
const expiredText = 'That sign-in expired. Try again.';

let stop: (() => void) | null = null;

/** Reopens where the player started once the page reloads signed in, through the same path as coming back from Google. */
function markReturn(rt: ReturnTo) {
  try { localStorage.setItem(RETURN_KEY, rt); } catch { /* they land on the menu, signed in */ }
}

function draw(state: SheetState): HTMLElement {
  let sheet = document.querySelector<HTMLElement>('[data-phantom-sheet]');
  if (!sheet) {
    const host = document.createElement('div');
    host.innerHTML = sheetHtml(state);
    sheet = host.firstElementChild as HTMLElement;
    document.body.append(sheet);
    sheet.addEventListener('click', onSheetClick);
  } else {
    sheet.querySelector<HTMLElement>('[data-ph-body]')!.innerHTML = sheetBodyHtml(state);
  }
  return sheet;
}
function closeSheet() {
  stop?.();
  stop = null;
  document.querySelector('[data-phantom-sheet]')?.remove();
}
function onSheetClick(e: Event) {
  const t = e.target as Element;
  if (t.closest('[data-a="phantom-close"]')) return closeSheet();
  if (t.closest('[data-a="phantom-cancel"]')) {
    clearPending(sessionStore());
    clearHandoff(localStore());
    if (landingCtx) { clearLanding(tripStore()); void reportFailure(relay(), landingCtx, true); landingCtx = null; }
    return closeSheet();
  }
  if (t.closest('[data-a="phantom-sign"]')) {
    // The link's own navigation is what leaves for Phantom, so don't touch the default action; just redraw after it.
    const { pending } = loadPending(tripStore(), Date.now());
    if (pending) savePending(tripStore(), { ...pending, opened: true });
    setTimeout(() => draw({ kind: 'approve', step: 2 }), 0);
  }
}

const fail = (e: unknown) => {
  stop?.();
  stop = null;
  const cancelled = e instanceof PhantomLinkError && e.cancelled;
  if (landingCtx) { clearLanding(tripStore()); void reportFailure(relay(), landingCtx, cancelled); landingCtx = null; }
  draw({ kind: 'failed', tone: cancelled ? 'warn' : 'bad', text: e instanceof Error ? e.message : 'Could not sign in with Phantom.' });
};

async function apply(p: Pending, r: PhantomResponse) {
  try {
    const out = advance(sessionStore(), p, r, { host: location.host, uri: `${location.origin}${location.pathname}`, now: Date.now() });
    if (out.kind === 'need-sign') {
      // This stops at a button: a universal link only opens the app reliably from a tap, and this code isn't running in one.
      watch(out.pending);
      return;
    }
    draw({ kind: 'working', text: 'Signing in…' });
    const { error } = await supabase().auth.signInWithWeb3({ chain: 'solana', message: out.message, signature: out.signature });
    if (error) throw new PhantomLinkError('Could not sign in with Phantom. Try again.');
    // Reopen where the player started, through the same path as coming back from Google, with a clean client.
    markReturn(p.returnTo);
    location.reload();
  } catch (e) {
    fail(e);
  }
}

/** Shows the step in progress and watches the relay for its answer. */
function watch(p: Pending) {
  if (p.step === 'sign' && !p.opened) draw({ kind: 'sign-ready', href: signLink(p, here()), newTab: p.app });
  else draw({ kind: 'approve', step: p.step === 'connect' ? 1 : 2 });
  stop?.();
  let busy = false;
  const tick = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    const { pending, expired } = loadPending(sessionStore(), Date.now());
    if (expired) return fail(new PhantomLinkError(expiredText));
    if (!pending?.opened) return;
    busy = true;
    const answer = await relayTake(relay(), pending.id).catch(() => null);
    busy = false;
    // Cancelled, or moved on, during the request: this answer is no longer wanted.
    const now = loadPending(sessionStore(), Date.now()).pending;
    if (answer && now?.id === pending.id) await apply(now, answer);
  };
  const onWake = () => void tick();
  const timer = setInterval(onWake, POLL_MS);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('focus', onWake);
  stop = () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('pageshow', onWake);
    window.removeEventListener('focus', onWake);
  };
  onWake();
}

/**
 * The tap on "Sign in with Phantom": points the link at Phantom and lets the tap follow it. Runs synchronously inside the click,
 * because universal links need the tap. A home-screen app opens it as a new context so the app's own page stays alive, and hands the
 * rest of the sign-in to Safari (phantomHandoff.ts); anywhere else the trip is kept in this tab's sessionStorage.
 */
export function startPhantomLink(a: HTMLAnchorElement, returnTo: ReturnTo) {
  const app = isStandalone(window as unknown as Parameters<typeof isStandalone>[0]);
  if (app) {
    a.href = beginHandoff(localStore(), { loc: here(), returnTo, now: Date.now() });
    a.target = '_blank';
    a.rel = 'noopener';
  } else {
    a.href = beginConnect(sessionStore(), { loc: here(), app, returnTo, now: Date.now() });
  }
  setTimeout(() => {
    draw({ kind: 'opening' });
    setTimeout(() => {
      if (!document.querySelector('[data-phantom-sheet]')) return;
      if (app) watchHandoff();
      else {
        const { pending } = loadPending(sessionStore(), Date.now());
        if (pending) watch(pending);
      }
    }, 1200);
  }, 0);
}

/** The home-screen app, waiting for Safari to leave the sealed session in the relay. Survives an iOS reload: the handoff is in localStorage. */
function watchHandoff() {
  const { handoff } = loadHandoff(localStore(), Date.now());
  if (!handoff) return;
  draw({ kind: 'wait-safari', code: handoffCode(handoff.id) });
  stop?.();
  let busy = false;
  const tick = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const r = await restoreInApp(localStore(), relay(), supabase().auth, Date.now());
      if (r.kind === 'done') {
        stop?.();
        draw({ kind: 'working', text: 'Signed in…' });
        // Reopen where the player started, through the same path as coming back from Google, with a clean client.
        markReturn(r.returnTo);
        location.reload();
      } else if (r.kind === 'none') {
        stop?.();
        stop = null;
      }
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
    }
  };
  const onWake = () => void tick();
  const timer = setInterval(onWake, POLL_MS);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('focus', onWake);
  stop = () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('pageshow', onWake);
    window.removeEventListener('focus', onWake);
  };
  onWake();
}

/** Safari, back from Phantom with a home-screen app's sign-in: reads the answer itself and carries on. Needs a tap before each trip. */
async function resumeLanding(cb: Callback) {
  const h = cb.handoff!;
  landingCtx = h;
  const landing = tripStore();
  const now = Date.now();
  // This very page is the app that started it (a redirect that did open in the app): keep the session here instead of passing it on.
  const sameApp = loadHandoff(localStore(), now).handoff?.id === h.id;
  try {
    const trip = landingTrip(cb, loadPending(landing, now).pending, now);
    if (!trip) return;
    draw({ kind: 'working', text: 'Checking with Phantom…' });
    const out = advance(landing, trip, cb.response, { host: location.host, uri: `${location.origin}${location.pathname}`, now });
    if (out.kind === 'need-sign') {
      // A button, not a redirect: a universal link only opens the app reliably from a tap.
      draw({ kind: 'sign-ready', href: signLink(out.pending, here()), newTab: false, code: handoffCode(h.id) });
      return;
    }
    draw({ kind: 'working', text: 'Signing in…' });
    await finishInSafari(supabase().auth, relay(), { message: out.message, signature: out.signature, handoff: h, keepSession: sameApp });
    landingCtx = null;
    if (sameApp) {
      const rec = loadHandoff(localStore(), Date.now()).handoff;
      clearHandoff(localStore());
      markReturn(rec?.returnTo ?? 'ranked');
      location.reload();
      return;
    }
    draw({ kind: 'safari-done', code: handoffCode(h.id) });
  } catch (e) {
    fail(e);
  }
}

/** On page load: a callback from Phantom (`search`, kept by public/phantom-return.js), and/or a sign-in in progress here. */
export function resumePhantom(search: string | undefined) {
  (window as unknown as { __phantomCb?: string }).__phantomCb = undefined; // it holds a trip's keys: don't leave them on window
  if (!ONLINE_CONFIGURED) return;
  let store: Store;
  let local: Store;
  try { store = sessionStore(); local = localStore(); } catch { return; }
  const cb = search ? parseCallback(search) : null;
  if (cb?.handoff) { void resumeLanding(cb); return; }
  const { pending, expired } = loadPending(store, Date.now());
  if (cb && routeCallback(cb, pending) === 'direct') {
    draw({ kind: 'working', text: 'Checking with Phantom…' });
    void apply(pending!, cb.response);
    return;
  }
  if (cb) {
    draw({ kind: 'working', text: 'Passing this back…' });
    relayPut(relay(), cb).catch(() => false).then((ok) => {
      draw(ok ? { kind: 'go-back', app: cb.app } : { kind: 'failed', tone: 'bad', text: 'Could not pass that back. Go back to PokeJam and try again.' });
    });
    return;
  }
  if (pending) { watch(pending); return; }
  if (expired) { fail(new PhantomLinkError(expiredText)); return; }
  // The home-screen app was reloaded while Safari was finishing the sign-in.
  const h = loadHandoff(local, Date.now());
  if (h.handoff) { watchHandoff(); return; }
  if (h.expired) { fail(new PhantomLinkError(expiredText)); return; }
  // Safari, reopened between the two Phantom trips: the button is still there.
  const ls = landingStore(local);
  const l = loadPending(ls, Date.now());
  if (l.pending?.handoff) {
    landingCtx = l.pending.handoff;
    if (l.pending.opened) draw({ kind: 'approve', step: 2 });
    else draw({ kind: 'sign-ready', href: signLink(l.pending, here()), newTab: false, code: handoffCode(l.pending.handoff.id) });
  } else if (l.expired) fail(new PhantomLinkError(expiredText));
}
