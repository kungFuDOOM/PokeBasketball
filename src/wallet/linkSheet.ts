// "Link Phantom to buy" on screen. Signing in is phantomSheet.ts and is not called from here.
// This file never signs the player out and never calls signInWithWeb3: the account they already have is the one that gets the wallet.
import { base58Decode, base58Encode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { RETURN_KEY } from '../multiplayer/ranked/account';
import { supabase } from '../multiplayer/shared/supabase';
import { getPhantomProvider, type PhantomProvider } from './phantom';
import {
  LINK_LANDING_KEY, LINK_PENDING_KEY, assertLinkForUser, beginLinkHandoff, beginLinkInBrowser, clearLinkHandoff,
  injectedLinkMessage, loadLinkHandoff, parseLinkCallback, putLinkResult, takeLinkResult, type LinkCallback,
} from './linkFlow';
import { linkBodyHtml, linkCode, linkSheetHtml, type LinkSheet } from './linkView';
import {
  advance, clearPending, isStandalone, loadPending, relayPut, relayTake, routeCallback, signLink, type Pending, type Store,
} from './phantomLink';

const POLL_MS = 2500;
type SignWallet = PhantomProvider & {
  connect?: () => Promise<{ publicKey?: { toBase58(): string } }>;
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<Uint8Array | { signature: Uint8Array }>;
};

const relay = () => supabase() as unknown as Parameters<typeof putLinkResult>[0];
const local = (): Store => window.localStorage;
const here = () => ({ origin: location.origin, pathname: location.pathname });
const env = () => ({ host: location.host, uri: `${location.origin}${location.pathname}`, now: Date.now() });
const hostWindow = () => window as unknown as Parameters<typeof isStandalone>[0];

let stop: (() => void) | null = null;
let landing = false;

function draw(state: LinkSheet): void {
  let sheet = document.querySelector<HTMLElement>('[data-link-sheet]');
  if (!sheet) {
    const host = document.createElement('div');
    host.innerHTML = linkSheetHtml(state);
    sheet = host.firstElementChild as HTMLElement;
    document.body.append(sheet);
    sheet.addEventListener('click', onClick);
    return;
  }
  const body = sheet.querySelector('[data-link-body]');
  if (body) body.innerHTML = linkBodyHtml(state);
}

function closeSheet(): void {
  stop?.();
  stop = null;
  document.querySelector('[data-link-sheet]')?.remove();
}

function onClick(e: Event): void {
  const t = e.target as Element;
  if (t.closest('[data-a="link-close"]')) closeSheet();
  else if (t.closest('[data-a="link-cancel"]')) {
    clearLinkHandoff(local());
    clearPending(local(), landing ? LINK_LANDING_KEY : LINK_PENDING_KEY);
    closeSheet();
  } else if (t.closest('[data-a="link-sign"]')) {
    const store = local();
    const key = landing ? LINK_LANDING_KEY : LINK_PENDING_KEY;
    const { pending } = loadPending(store, Date.now(), key);
    if (pending) store.setItem(key, JSON.stringify({ ...pending, opened: true }));
  }
}

function fail(text: string): void {
  stop?.();
  stop = null;
  draw({ kind: 'failed', text });
}

async function submit(message: string, signature: Uint8Array, userId: string): Promise<void> {
  assertLinkForUser(message, userId, Date.now());
  const { data, error } = await supabase().functions.invoke('pokejam-link-wallet', { body: { message, signature: base58Encode(signature) } });
  if (error) throw new Error('Could not link the wallet. Try again.');
  const body = data as { ok?: boolean; error?: string } | null;
  if (!body?.ok) throw new Error(body?.error || 'Could not link the wallet. Try again.');
}

function reloadRanked(): void {
  try { localStorage.setItem(RETURN_KEY, 'ranked'); } catch { /* they land on the menu, linked */ }
  location.reload();
}

function bytesOf(signed: Uint8Array | { signature: Uint8Array }): Uint8Array {
  return signed instanceof Uint8Array ? signed : signed.signature;
}

/** Injected Phantom (desktop extension or the Phantom in-app browser): sign here, no redirect. */
export async function linkInjectedWallet(userId: string, wallet: SignWallet = getPhantomProvider() as SignWallet): Promise<void> {
  const connected = wallet.publicKey?.toBase58() ? null : await wallet.connect?.();
  const address = wallet.publicKey?.toBase58() ?? connected?.publicKey?.toBase58();
  if (!address || !wallet.signMessage) throw new Error('Phantom was not found in this browser.');
  const { message } = injectedLinkMessage({ host: location.host, uri: `${location.origin}${location.pathname}`, address, userId, now: Date.now() });
  const signed = await wallet.signMessage(new TextEncoder().encode(message), 'utf8');
  if (!signed) throw new Error('Phantom was not found in this browser.');
  const signature = bytesOf(signed);
  await submit(message, signature, userId);
}

/** Sets the anchor's destination during the tap. A home-screen app opens Safari and waits; any other tab keeps the trip in localStorage. */
export function armLinkAnchor(a: HTMLAnchorElement, userId: string): void {
  const app = isStandalone(hostWindow());
  if (app) {
    a.href = beginLinkHandoff(local(), { loc: here(), userId, returnTo: 'ranked', now: Date.now() });
    a.target = '_blank';
    a.rel = 'noopener';
    const h = loadLinkHandoff(local(), Date.now()).handoff;
    setTimeout(() => { if (h) { draw({ kind: 'wait', code: linkCode(h.id) }); watchHandoff(userId); } }, 0);
    return;
  }
  a.href = beginLinkInBrowser(local(), { loc: here(), userId, now: Date.now() });
  a.target = '_blank';
  a.rel = 'noopener';
  setTimeout(() => { draw({ kind: 'approve' }); watchPending(userId); }, 0);
}

function watch(tick: () => Promise<void>): void {
  stop?.();
  let busy = false;
  const onWake = () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    void tick().finally(() => { busy = false; });
  };
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

function watchHandoff(userId: string): void {
  watch(async () => {
    const h = loadLinkHandoff(local(), Date.now());
    if (h.expired) return fail('This link expired. Try again.');
    if (!h.handoff) return;
    try {
      const got = await takeLinkResult(relay(), h.handoff);
      if (!got) return;
      clearLinkHandoff(local());
      stop?.();
      await submit(got.message, base58Decode(got.signature), userId);
      reloadRanked();
    } catch (e) {
      clearLinkHandoff(local());
      fail(e instanceof Error ? e.message : 'Could not link the wallet.');
    }
  });
}

function watchPending(userId: string): void {
  watch(async () => {
    const { pending, expired } = loadPending(local(), Date.now(), LINK_PENDING_KEY);
    if (expired) return fail('This link expired. Try again.');
    if (!pending?.opened) return;
    const answer = await relayTake(relay(), pending.id).catch(() => null);
    if (!answer) return;
    const now = loadPending(local(), Date.now(), LINK_PENDING_KEY).pending;
    if (now?.id !== pending.id) return;
    await applyPending(now, answer, userId, LINK_PENDING_KEY);
  });
}

async function applyPending(p: Pending, response: LinkCallback['response'], userId: string, key: string): Promise<void> {
  try {
    const out = advance(local(), p, response, { ...env(), storageKey: key });
    if (out.kind === 'need-sign') {
      draw({ kind: 'sign', href: signLink(out.pending, here()), code: out.pending.handoff ? linkCode(out.pending.handoff.id) : undefined });
      return;
    }
    if (p.handoff && p.app && !isStandalone(hostWindow())) {
      await putLinkResult(relay(), p.handoff.id, out.message, out.signature, p.handoff.pub);
      clearPending(local(), key);
      draw({ kind: 'done', code: linkCode(p.handoff.id) });
      return;
    }
    await submit(out.message, out.signature, p.userId ?? userId);
    clearPending(local(), key);
    reloadRanked();
  } catch (e) {
    fail(e instanceof Error ? e.message : 'Could not link the wallet.');
  }
}

/** Safari (or a new tab) landing on a link callback, and a home-screen app reopened while it was waiting. */
export function resumeLink(search: string | undefined): void {
  const w = window as Window & { __linkCb?: string };
  const stashed = w.__linkCb;
  w.__linkCb = undefined;
  let store: Store;
  try { store = local(); } catch { return; }
  const cb = parseLinkCallback(stashed || search || '');
  if (cb?.handoff && !isStandalone(hostWindow())) {
    landing = true;
    void resumeLanding(cb);
    return;
  }
  const pending = loadPending(store, Date.now(), LINK_PENDING_KEY);
  if (cb && routeCallback(cb, pending.pending) === 'direct' && pending.pending) {
    void applyPending(pending.pending, cb.response, pending.pending.userId ?? '', LINK_PENDING_KEY);
    return;
  }
  if (cb) {
    void relayPut(relay(), cb).then((ok) => draw(ok ? { kind: 'approve' } : { kind: 'failed', text: 'Could not pass that back. Go back to the PokeJam tab.' }));
    return;
  }
  if (pending.pending) {
    if (pending.pending.step === 'sign' && !pending.pending.opened) draw({ kind: 'sign', href: signLink(pending.pending, here()) });
    else draw({ kind: 'approve' });
    if (pending.pending.userId) watchPending(pending.pending.userId);
    return;
  }
  const h = loadLinkHandoff(store, Date.now());
  if (h.handoff) {
    draw({ kind: 'wait', code: linkCode(h.handoff.id) });
    watchHandoff(h.handoff.userId);
  } else if (h.expired) fail('This link expired. Try again.');
}

async function resumeLanding(cb: LinkCallback): Promise<void> {
  const userId = cb.userId;
  if (!cb.handoff || !userId) return fail('This link could not be continued.');
  const loaded = loadPending(local(), Date.now(), LINK_LANDING_KEY).pending;
  const trip: Pending = loaded && loaded.step === 'sign' && loaded.id === cb.id
    ? loaded
    : { v: 1, id: cb.id, step: 'connect', app: true, opened: true, returnTo: 'ranked', expiresAt: Date.now() + 10 * 60_000, secret: cb.handoff.secret, handoff: cb.handoff, purpose: 'link', userId };
  await applyPending(trip, cb.response, userId, LINK_LANDING_KEY);
}
