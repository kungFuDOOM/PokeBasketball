// The on-screen half of a Phantom deeplink payment: which storage this context uses, the relay poll, and writing the
// signature where the ads page and the Rank Shield shop already confirm it. The rules are in phantomPay.ts.
import { adsApi } from '../ads/api';
import { ONLINE_CONFIGURED, supabase } from '../multiplayer/shared/supabase';
import { clearPending, savePending } from '../multiplayer/ranked/usdcPay';
import { isStandalone, parseCallback, type Store } from './phantomLink';
import {
  loadPay, pullPay, saveContinue, takeContinue, takePayDirect,
  type PayKind, type PayOutcome,
} from './phantomPay';

const POLL_MS = 2500;
const AD_PENDING = 'pokejam.adPending';
const AD_USDC_PENDING = 'pokejam.adUsdcPending';

const host = () => window as unknown as Parameters<typeof isStandalone>[0];
const local = (): Store => window.localStorage;
export const payAsApp = (): boolean => isStandalone(host());
export function tripStore(): Store {
  return payAsApp() ? window.localStorage : window.sessionStorage;
}

type Listener = (o: PayOutcome) => void;
type ErrListener = (e: unknown) => void;
const listeners = new Set<Listener>();
const errListeners = new Set<ErrListener>();
export function onPay(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onPayError(fn: ErrListener): () => void {
  errListeners.add(fn);
  return () => errListeners.delete(fn);
}
function fail(e: unknown): void {
  for (const fn of errListeners) {
    try { fn(e); } catch { /* one page failing doesn't hide the error */ }
  }
}

let stopWatch: (() => void) | null = null;

function rememberAd(kind: 'ad-burn' | 'ad-usdc', id: string, signature: string, wallet: string): void {
  const key = kind === 'ad-usdc' ? AD_USDC_PENDING : AD_PENDING;
  let list: unknown = [];
  try { list = JSON.parse(local().getItem(key) || '[]'); } catch { list = []; }
  const rows = Array.isArray(list) ? list : [];
  if (rows.some((p) => p && typeof p === 'object' && (p as { id?: string; signature?: string }).id === id && (p as { signature?: string }).signature === signature)) return;
  rows.push({ id, at: Date.now(), wallet, signature });
  try { local().setItem(key, JSON.stringify(rows.slice(-10))); } catch { /* the page keeps it in memory if it is open */ }
}

/** Writes the signature where the existing confirm path will find it, then asks the server once. */
async function settleSigned(o: Extract<PayOutcome, { kind: 'signed' }>): Promise<void> {
  if (o.payKind === 'shield') {
    savePending(window.localStorage, { intentId: o.intentId, signature: o.signature, wallet: o.wallet, at: Date.now() });
  } else {
    rememberAd(o.payKind, o.intentId, o.signature, o.wallet);
  }
  if (!ONLINE_CONFIGURED) return;
  try {
    if (o.payKind === 'shield') {
      const { data } = await supabase().functions.invoke('shield-usdc-confirm', { body: { intentId: o.intentId, signature: o.signature } });
      if ((data as { status?: string } | null)?.status === 'credited') clearPending(window.localStorage, o.intentId);
    } else if (o.payKind === 'ad-usdc') {
      await adsApi.usdcConfirm(o.intentId, { signature: o.signature });
    } else {
      await adsApi.confirm(o.intentId, { signature: o.signature });
    }
  } catch { /* the page asks again from the saved signature */ }
}

function deliver(o: PayOutcome): void {
  if (o.kind === 'connected') {
    // Always leave the flag. A page that is already open clears it in its listener; a page that opens next reads it.
    saveContinue(local(), { payKind: o.payKind, ...(o.sku ? { sku: o.sku } : {}) });
    if (listeners.size === 0 && (o.payKind === 'ad-burn' || o.payKind === 'ad-usdc') && location.hash !== '#advertise') {
      location.hash = '#advertise';
    }
  }
  for (const fn of listeners) {
    try { fn(o); } catch { /* one page failing doesn't drop the result */ }
  }
  if (o.kind === 'signed') void settleSigned(o);
}

function watch(): void {
  if (stopWatch) return;
  let busy = false;
  let stop = (): void => {};
  const tick = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const r = await pullPay(tripStore(), local(), supabase() as unknown as Parameters<typeof pullPay>[2], Date.now());
      if (r === 'waiting') return;
      stop();
      if (r !== 'none') deliver(r);
    } catch (e) {
      stop();
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
    if (stopWatch === stop) stopWatch = null;
  };
  stopWatch = stop;
  onWake();
}

export function watchPay(): void {
  if (!ONLINE_CONFIGURED) return;
  watch();
}

/**
 * On load: a callback this context started, or a trip still waiting on the relay. Returns true when the callback or
 * the trip belongs to a payment, so sign-in resume leaves it alone. A callback this context did not start returns
 * false and the sign-in path relays the ciphertext.
 */
export function resumePay(search: string | undefined): boolean {
  if (!ONLINE_CONFIGURED) return false;
  let store: Store;
  let sessions: Store;
  try { store = tripStore(); sessions = local(); } catch { return false; }
  const cb = search ? parseCallback(search) : null;
  if (cb && !cb.handoff) {
    try {
      const direct = takePayDirect(store, sessions, cb, Date.now());
      if (direct) { deliver(direct); return true; }
    } catch (e) {
      fail(e);
      return true;
    }
  }
  const loaded = loadPay(store, Date.now());
  if (loaded.trip?.opened) { watchPay(); return true; }
  return false;
}

export function savedContinue(): ReturnType<typeof takeContinue> {
  try { return takeContinue(local()); } catch { return null; }
}

export type { PayKind, PayOutcome };
