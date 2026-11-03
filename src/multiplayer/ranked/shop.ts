// Rank Shield shop sheet (behind MODE_SHIELD_SHOP; the card path needs MODE_SHIELD_STRIPE, USDC needs MODE_SHIELD_USDC): loads the packs, sends a sku to the shield-create-checkout Edge Function,
// and hands the player to Stripe's hosted page. It never sees card data or a price it could change, and it never credits
// anything: coming back from Stripe it only waits (polls pokejam_shield_me) for the webhook's credit to show up.
import { base64Encode } from '../../../supabase/functions/_shared/pack/bytes.ts';
import { supabase } from '../shared/supabase';
import type { SupabaseMatchService } from '../shared/onlineMatchService';
import { MODE_SHIELD_STRIPE, MODE_SHIELD_USDC, SHIELD_USDC_CLUSTER } from '../../config/features';
import { armLinkAnchor, linkInjectedWallet } from '../../wallet/linkSheet';
import { getPhantomProvider, type WalletUser } from '../../wallet/phantom';
import { armPay, beginPayConnect, clearSession, loadPay, loadSession, markPayOpened, payCode, payFresh, sessionFor, signAndSendLink, type PhantomSession } from '../../wallet/phantomPay';
import { onPay, onPayError, payAsApp, savedContinue, tripStore, watchPay } from '../../wallet/phantomPayUi';
import { SHOP_NOTICES, USDC_NOTICES, gotShields, pollForRise, shopBodyHtml, shopHtml, usdcOption, type ShopModel, type ShopNotice } from './shopView';
import { UsdcPayError, clearPending, isFinalRefusal, loadPending, parseIntent, pollConfirm, prepareTransfer, savePending, sendAndRemember, type ConfirmAnswer, type PayProvider, type PendingPayment } from './usdcPay';

/** The held count just before leaving for Stripe, so the page that comes back knows what "more" means. */
const BEFORE_KEY = 'pokejam.shop.before';
const CONSENT_KEY = 'pokejam.shop.age';

const store = () => { try { return window.sessionStorage; } catch { return null; } };
/** Sent USDC payments outlive the tab: see savePending. */
const lasting = () => { try { return window.localStorage; } catch { return null; } };

/** A failed Edge Function call: the player-facing text, and the HTTP status when there was one. */
class FnError extends Error {
  constructor(message: string, public status = 0, public code?: string) { super(message); }
}

/** A player-facing reason from a failed Edge Function call. */
async function checkoutError(error: unknown): Promise<FnError> {
  const e = error as { name?: string; context?: unknown };
  if (e?.name === 'FunctionsFetchError' || e?.name === 'FunctionsRelayError') return new FnError('Could not reach the shop. Try again in a moment.');
  if (e?.context instanceof Response) {
    const body = (await e.context.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return new FnError(body.error, e.context.status, typeof body.code === 'string' ? body.code : undefined);
    return new FnError('Could not start checkout. Try again in a moment.', e.context.status);
  }
  return new FnError('Could not start checkout. Try again in a moment.');
}

async function callFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase().functions.invoke(name, { body });
  if (error) throw await checkoutError(error);
  return data as T;
}

/** Creates the Stripe Checkout Session; returns its hosted-page URL. */
async function startCheckout(sku: string): Promise<string> {
  const data = await callFn<{ url?: unknown } | null>('shield-create-checkout', { sku, ageConfirmed: true });
  const url = data?.url;
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Could not start checkout. Try again in a moment.');
  return url;
}

export interface ShopOptions {
  /** Why the page was opened: back from Stripe (success: wait for the credit; cancel: say so). */
  returned?: 'success' | 'cancel' | null;
  /** The sheet was closed (or the held count changed): refresh whatever shows the count. */
  onClose?(): void;
}

/** Opens the shop sheet over the Ranked home. Removes itself on close. */
export function openShop(svc: SupabaseMatchService, o: ShopOptions = {}) {
  const prev = document.activeElement as HTMLElement | null;
  const m: ShopModel = { info: null, signedIn: true, agreed: store()?.getItem(CONSENT_KEY) === '1', busy: null, notice: null, card: MODE_SHIELD_STRIPE };
  const host = document.createElement('div');
  host.innerHTML = shopHtml(m);
  const sheet = host.firstElementChild as HTMLElement;
  document.body.append(sheet);
  const body = sheet.querySelector<HTMLElement>('[data-shop-body]')!;
  const open = () => sheet.isConnected;
  const render = () => { body.innerHTML = shopBodyHtml(m); };
  const say = (n: ShopNotice | null) => { m.notice = n; render(); };
  let stopListen = () => {};
  const close = () => { stopListen(); sheet.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); o.onClose?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t === sheet || t.closest('[data-a="shop-close"]')) return close();
    const buy = t.closest<HTMLButtonElement>('[data-a="buy"]');
    if (buy && !buy.disabled) void buyPack(buy.dataset.sku ?? '');
    const usdc = t.closest<HTMLElement>('[data-a="buy-usdc"]');
    if (usdc && usdc.getAttribute('aria-disabled') !== 'true' && !(usdc as HTMLButtonElement).disabled) {
      const sku = usdc.dataset.sku ?? '';
      if (!getPhantomProvider() && usdc instanceof HTMLAnchorElement) {
        const session = sessionFor(localStorage, SHIELD_USDC_CLUSTER, wallet);
        if (!session) {
          if (!sku || !m.agreed || m.busy || !wallet) { e.preventDefault(); return; }
          usdc.href = beginPayConnect(tripStore(), {
            loc: { origin: location.origin, pathname: location.pathname }, app: payAsApp(),
            cluster: SHIELD_USDC_CLUSTER, kind: 'shield', now: Date.now(), hash: location.hash, sku,
          });
          if (payAsApp()) { usdc.target = '_blank'; usdc.rel = 'noopener'; }
          watchPay();
          return;
        }
      }
      e.preventDefault();
      void buyUsdc(sku);
    }
    const approve = t.closest<HTMLAnchorElement>('[data-a="phantom-approve"]');
    if (approve) {
      const trip = loadPay(tripStore(), Date.now()).trip;
      if (!trip || !payFresh(trip, Date.now())) {
        e.preventDefault();
        const session = sessionFor(localStorage, SHIELD_USDC_CLUSTER, wallet);
        if (session && trip?.sku) void buyUsdcDeeplink(trip.sku, session);
        return;
      }
      markPayOpened(tripStore(), Date.now());
      if (payAsApp()) { approve.target = '_blank'; approve.rel = 'noopener'; }
      watchPay();
    }
    if (t.closest<HTMLButtonElement>('[data-a="retry-usdc"]')) void settleUsdc();
    const link = t.closest<HTMLAnchorElement>('[data-a="link-wallet"]');
    if (link) {
      if (!userId) { e.preventDefault(); return; }
      const provider = getPhantomProvider();
      if (provider) {
        e.preventDefault();
        void linkInjectedWallet(userId).then(() => { m.linkWallet = false; m.usdc = { cluster: SHIELD_USDC_CLUSTER }; say({ tone: 'ok', text: 'Phantom linked. You can pay with USDC.' }); }).catch((err: unknown) => say({ tone: 'bad', text: err instanceof Error ? err.message : 'Could not link the wallet.' }));
        return;
      }
      armLinkAnchor(link, userId);
    }
  });
  sheet.addEventListener('change', (e) => {
    const box = (e.target as Element).closest<HTMLInputElement>('[data-a="age"]');
    if (!box) return;
    m.agreed = box.checked;
    try { store()?.setItem(CONSENT_KEY, box.checked ? '1' : '0'); } catch { /* storage unavailable: the box just starts unchecked next time */ }
    render();
  });
  sheet.querySelector<HTMLElement>('[data-a="shop-close"]')?.focus();

  async function buyPack(sku: string) {
    if (!MODE_SHIELD_STRIPE || !sku || !m.agreed || m.busy) return;
    m.busy = sku;
    say(null);
    try {
      try { store()?.setItem(BEFORE_KEY, String(m.info?.held ?? 0)); } catch { /* the return page falls back to its first read */ }
      location.assign(await startCheckout(sku));
    } catch (e) {
      m.busy = null;
      if (open()) say({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not start checkout.' });
    }
  }

  /** Pay in USDC through an injected Phantom. */
  async function buyUsdcInjected(sku: string, provider: PayProvider) {
    if (!sku || !m.agreed || m.busy || !wallet) return;
    if (unsettled().length) return settleUsdc();
    m.busy = sku;
    m.rail = 'usdc';
    m.usdcStep = 'approve';
    say(null);
    try {
      const intent = parseIntent(await callFn('shield-usdc-intent', { sku, ageConfirmed: true }));
      // The badge says which network this build is for: never send money on another one.
      if (intent.cluster !== SHIELD_USDC_CLUSTER) throw new UsdcPayError('The shop is on a different Solana network than this page. Reload and try again.');
      const built = await prepareTransfer(intent, wallet);
      say(USDC_NOTICES.approve);
      await finishUsdc(await sendAndRemember(provider, built, wallet, intent.intentId, (p) => { if (!savePending(lasting(), p)) unsaved.set(p.intentId, p); }));
    } catch (e) {
      if (open()) say(e instanceof UsdcPayError && e.kind === 'rejected' ? USDC_NOTICES.rejected : { tone: 'bad', text: e instanceof Error ? e.message : 'The payment did not go through.' });
    } finally {
      m.busy = null;
      m.rail = 'card';
      m.usdcStep = null;
      m.usdcUnconfirmed = unsettled().length > 0;
      if (open()) render();
    }
  }

  const payLoc = () => ({ origin: location.origin, pathname: location.pathname });

  /** No injected wallet: the server builds the transfer, then a tap opens Phantom's signAndSendTransaction deeplink. */
  async function buyUsdcDeeplink(sku: string, session: PhantomSession) {
    if (!sku || !m.agreed || m.busy || !wallet) return;
    if (session.wallet !== wallet) {
      try { clearSession(localStorage); } catch { /* storage unavailable */ }
      if (open()) say(USDC_NOTICES.wrongWallet);
      return;
    }
    if (unsettled().length) return settleUsdc();
    m.busy = sku;
    m.rail = 'usdc';
    m.usdcStep = 'approve';
    m.phantomApprove = null;
    say(null);
    try {
      const intent = parseIntent(await callFn('shield-usdc-intent', { sku, ageConfirmed: true }));
      if (intent.cluster !== SHIELD_USDC_CLUSTER) throw new UsdcPayError('The shop is on a different Solana network than this page. Reload and try again.');
      const built = await prepareTransfer(intent, wallet);
      const trip = armPay(tripStore(), {
        session, kind: 'shield', intentId: intent.intentId, txBase64: base64Encode(built.transaction),
        app: payAsApp(), now: Date.now(), sku,
      });
      m.phantomApprove = { href: signAndSendLink(trip, payLoc(), location.hash), code: payCode(trip), blank: payAsApp() };
      if (open()) say(USDC_NOTICES.approve);
    } catch (e) {
      m.phantomApprove = null;
      if (open()) say(e instanceof UsdcPayError && e.kind === 'rejected' ? USDC_NOTICES.rejected : { tone: 'bad', text: e instanceof Error ? e.message : 'The payment did not go through.' });
    } finally {
      m.busy = null;
      m.rail = 'card';
      m.usdcStep = m.phantomApprove ? 'approve' : null;
      m.usdcUnconfirmed = unsettled().length > 0;
      if (open()) render();
    }
  }

  /** Injected Phantom when this browser has one; otherwise the deeplink, using a saved session when there is one. */
  async function buyUsdc(sku: string) {
    const provider = getPhantomProvider() as PayProvider | null;
    if (provider) return buyUsdcInjected(sku, provider);
    const session = sessionFor(localStorage, SHIELD_USDC_CLUSTER, wallet);
    if (!session) {
      const other = loadSession(localStorage, SHIELD_USDC_CLUSTER);
      if (open()) say(other && other.wallet !== wallet ? USDC_NOTICES.wrongWallet : { tone: 'bad', text: 'Tap Pay again to open Phantom and connect the wallet you signed in with.' });
      return;
    }
    return buyUsdcDeeplink(sku, session);
  }

  /** Payments with a signature that the server has not settled: saved ones, plus any that storage refused. */
  function unsettled(): PendingPayment[] {
    const saved = wallet ? loadPending(lasting(), wallet) : [];
    return [...saved, ...[...unsaved.values()].filter((u) => !saved.some((p) => p.intentId === u.intentId))];
  }
  const forget = (p: PendingPayment) => { clearPending(lasting(), p.intentId); unsaved.delete(p.intentId); };

  /**
   * Waits for the server to settle a sent payment (it credits only after reading it from Solana), then refreshes the shop. The
   * record goes only on an answer that retrying cannot change; otherwise it stays for a retry. Returns whether it was settled.
   */
  async function finishUsdc(p: PendingPayment): Promise<boolean> {
    m.usdcStep = 'confirm';
    say(USDC_NOTICES.confirming);
    let r: ConfirmAnswer | 'timeout';
    try {
      r = await pollConfirm(() => callFn<ConfirmAnswer>('shield-usdc-confirm', { intentId: p.intentId, signature: p.signature }), { stop: () => !open(), isFinal: isFinalRefusal });
    } catch (e) {
      forget(p);
      const text = e instanceof Error ? e.message : 'The payment did not go through.';
      if (open()) say({ tone: 'bad', text: (e as FnError).code === 'tx_failed' ? text : `${text.replace(/\.$/, '')}. If USDC left your wallet, email kungfudoom@mail.grokbot.com.` });
      return true;
    }
    if (r === 'timeout') {
      if (open()) say(USDC_NOTICES.timeout);
      return false;
    }
    forget(p);
    if (!open()) return true;
    const short = r.short ?? 0;
    say(short > 0 ? { tone: 'warn', text: `Payment confirmed: +${r.credited ?? 0}. ${short} were over your limit of ${m.info?.cap ?? 14}: email kungfudoom@mail.grokbot.com for a refund.` } : typeof r.credited === 'number' ? gotShields(r.credited) : USDC_NOTICES.confirmed);
    await refresh();
    return true;
  }

  /** Finishes every unsettled payment, on opening the shop and from the retry button. Stops at the first still unconfirmed. */
  async function settleUsdc() {
    const list = unsettled();
    if (!list.length || m.busy) return;
    m.busy = '-';
    m.rail = 'usdc';
    m.usdcUnconfirmed = true;
    try {
      for (const p of list) if (!(await finishUsdc(p))) break;
    } catch (e) {
      if (open()) say({ tone: 'bad', text: e instanceof Error ? e.message : 'The payment did not go through.' });
    } finally {
      m.busy = null;
      m.rail = 'card';
      m.usdcStep = null;
      m.usdcUnconfirmed = unsettled().length > 0;
      if (open()) render();
    }
  }

  async function waitForPayment() {
    const st = store();
    const raw = st?.getItem(BEFORE_KEY);
    try { st?.removeItem(BEFORE_KEY); } catch { /* ignore */ }
    const read = async () => (await svc.shieldStatus())?.count ?? null;
    const first = (await read().catch(() => null)) ?? 0;
    // The count from just before checkout (the webhook may already have credited by the time we are back); else what we see now.
    const saved = raw == null ? NaN : Number(raw);
    const before = Number.isFinite(saved) ? Math.min(saved, first) : first;
    say(SHOP_NOTICES.waiting);
    const now = await pollForRise(read, before, { stop: () => !open() });
    if (!open()) return;
    if (now === null) return say(SHOP_NOTICES.timeout);
    say(gotShields(now - before));
    await refresh();
  }

  async function refresh() {
    try {
      m.info = await svc.shieldShop();
      if (!m.info) m.notice = { tone: 'warn', text: 'The shop is not available right now.' };
    } catch {
      m.notice = { tone: 'warn', text: 'Could not load the shop. Try again in a moment.' };
    }
    if (open()) render();
  }

  // USDC needs a wallet on this account: the Phantom they signed in with, or one linked afterwards. The server re-reads it.
  let wallet = '';
  let userId = '';
  m.usdcHandOff = !getPhantomProvider();
  const offPay = onPay((ev) => {
    if (!open() || !wallet) return;
    if (ev.kind === 'connected' && ev.payKind === 'shield') {
      savedContinue();
      if (ev.session.wallet !== wallet) {
        try { clearSession(localStorage); } catch { /* storage unavailable */ }
        say(USDC_NOTICES.wrongWallet);
        return;
      }
      if (ev.sku) void buyUsdcDeeplink(ev.sku, ev.session);
      return;
    }
    if (ev.kind === 'signed' && ev.payKind === 'shield') {
      void finishUsdc({ intentId: ev.intentId, signature: ev.signature, wallet: ev.wallet, at: Date.now() });
    }
  });
  const offErr = onPayError((err) => {
    if (!open()) return;
    m.busy = null;
    m.phantomApprove = null;
    say({ tone: 'bad', text: err instanceof Error ? err.message : 'The payment did not go through.' });
  });
  stopListen = () => { offPay(); offErr(); };
  /** Payments that could not be written to storage (private mode, full): they only last while this sheet is open. */
  const unsaved = new Map<string, PendingPayment>();
  void (async () => {
    if (MODE_SHIELD_USDC) {
      const { data } = await supabase().auth.getSession().catch(() => ({ data: { session: null } }));
      userId = data.session?.user?.id ?? '';
      let linked: string | null = null;
      if (userId) {
        try {
          const read = await supabase().rpc('pokejam_my_wallet');
          linked = typeof read.data === 'string' ? read.data : null;
        } catch { linked = null; }
      }
      const opt = usdcOption(data.session?.user as WalletUser | undefined, true, SHIELD_USDC_CLUSTER, linked);
      wallet = opt?.wallet ?? '';
      if (opt) m.usdc = { cluster: opt.cluster };
      else if (userId) m.linkWallet = true;
    }
    await refresh();
    if (!open()) return;
    if (wallet) {
      const cont = savedContinue();
      const session = sessionFor(localStorage, SHIELD_USDC_CLUSTER, wallet);
      if (unsettled().length) void settleUsdc();
      else if (cont?.payKind === 'shield' && cont.sku && session) void buyUsdcDeeplink(cont.sku, session);
      else {
        try {
          const trip = loadPay(tripStore(), Date.now()).trip;
          if (trip && trip.kind === 'shield' && !trip.opened && payFresh(trip, Date.now())) {
            m.phantomApprove = { href: signAndSendLink(trip, { origin: location.origin, pathname: location.pathname }, location.hash), code: payCode(trip), blank: trip.app };
            m.usdcStep = 'approve';
            if (open()) render();
          }
        } catch { /* storage unavailable */ }
      }
    }
    if (!MODE_SHIELD_STRIPE) { /* no card payments: a Stripe return means nothing here */ } else if (o.returned === 'cancel') say(SHOP_NOTICES.cancelled);
    else if (o.returned === 'success') void waitForPayment();
  })();
}
