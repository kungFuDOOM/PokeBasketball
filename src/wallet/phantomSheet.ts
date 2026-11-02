// Drives a Phantom deeplink sign-in on screen: the tap that leaves for Phantom, what the page does when Phantom sends the player
// back, and the wait for an answer left in the relay. The rules are in phantomLink.ts.
import { ONLINE_CONFIGURED, supabase } from '../multiplayer/shared/supabase';
import { RETURN_KEY } from '../multiplayer/ranked/account';
import {
  PhantomLinkError, advance, beginConnect, clearPending, isStandalone, loadPending, parseCallback, relayPut, relayTake, routeCallback, savePending, signLink,
  type Pending, type PhantomResponse, type RelayClient, type ReturnTo, type Store,
} from './phantomLink';
import { sheetBodyHtml, sheetHtml, type SheetState } from './phantomView';

const POLL_MS = 2500;
const relay = () => supabase() as unknown as RelayClient;
const sessionStore = (): Store => window.sessionStorage;
const here = () => ({ origin: location.origin, pathname: location.pathname });
const expiredText = 'That sign-in expired. Try again.';

let stop: (() => void) | null = null;

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
  if (t.closest('[data-a="phantom-cancel"]')) { clearPending(sessionStore()); return closeSheet(); }
  if (t.closest('[data-a="phantom-sign"]')) {
    // The link's own navigation is what leaves for Phantom, so don't touch the default action; just redraw after it.
    const { pending } = loadPending(sessionStore(), Date.now());
    if (pending) savePending(sessionStore(), { ...pending, opened: true });
    setTimeout(() => draw({ kind: 'approve', step: 2 }), 0);
  }
}

const fail = (e: unknown) => {
  stop?.();
  stop = null;
  const cancelled = e instanceof PhantomLinkError && e.cancelled;
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
    try { localStorage.setItem(RETURN_KEY, p.returnTo); } catch { /* they land on the menu, signed in */ }
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
 * because universal links need the tap. A home-screen app opens it as a new context so the app's own page, and key, stay alive.
 */
export function startPhantomLink(a: HTMLAnchorElement, returnTo: ReturnTo) {
  const app = isStandalone(window as unknown as Parameters<typeof isStandalone>[0]);
  a.href = beginConnect(sessionStore(), { loc: here(), app, returnTo, now: Date.now() });
  if (app) { a.target = '_blank'; a.rel = 'noopener'; }
  setTimeout(() => {
    draw({ kind: 'opening' });
    setTimeout(() => {
      const { pending } = loadPending(sessionStore(), Date.now());
      if (pending && document.querySelector('[data-phantom-sheet]')) watch(pending);
    }, 1200);
  }, 0);
}

/** On page load: a callback from Phantom (`search`, kept by public/phantom-return.js), and/or a sign-in in progress in this tab. */
export function resumePhantom(search: string | undefined) {
  if (!ONLINE_CONFIGURED) return;
  let store: Store;
  try { store = sessionStore(); } catch { return; }
  const { pending, expired } = loadPending(store, Date.now());
  const cb = search ? parseCallback(search) : null;
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
  if (pending) watch(pending);
  else if (expired) fail(new PhantomLinkError(expiredText));
}
