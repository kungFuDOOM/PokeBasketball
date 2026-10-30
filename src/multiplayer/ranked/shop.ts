// Rank Shield shop sheet (behind MODE_SHIELD_SHOP): loads the packs, sends a sku to the shield-create-checkout Edge Function,
// and hands the player to Stripe's hosted page. It never sees card data or a price it could change, and it never credits
// anything: coming back from Stripe it only waits (polls pokejam_shield_me) for the webhook's credit to show up.
import { supabase } from '../shared/supabase';
import type { SupabaseMatchService } from '../shared/onlineMatchService';
import { MODE_SHIELD_USDC, SHIELD_USDC_CLUSTER } from '../../config/features';
import { getPhantomProvider, type WalletUser } from '../../wallet/phantom';
import { SHOP_NOTICES, USDC_NOTICES, gotShields, pollForRise, shopBodyHtml, shopHtml, usdcOption, type ShopModel, type ShopNotice } from './shopView';
import { UsdcPayError, parseIntent, pollConfirm, prepareTransfer, rpcFor, signAndSend, type ConfirmAnswer, type PayProvider } from './usdcPay';

/** The held count just before leaving for Stripe, so the page that comes back knows what "more" means. */
const BEFORE_KEY = 'pokejam.shop.before';
const CONSENT_KEY = 'pokejam.shop.age';
/** A USDC payment that was sent but not yet confirmed by the server: {intentId, signature}. Lets the shop finish it after a reload. */
const USDC_KEY = 'pokejam.shop.usdc';

const store = () => { try { return window.sessionStorage; } catch { return null; } };

/** A failed Edge Function call: the player-facing text, and the HTTP status when there was one. */
class FnError extends Error {
  constructor(message: string, public status = 0) { super(message); }
}

/** A player-facing reason from a failed Edge Function call. */
async function checkoutError(error: unknown): Promise<FnError> {
  const e = error as { name?: string; context?: unknown };
  if (e?.name === 'FunctionsFetchError' || e?.name === 'FunctionsRelayError') return new FnError('Could not reach the shop. Try again in a moment.');
  if (e?.context instanceof Response) {
    const body = (await e.context.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return new FnError(body.error, e.context.status);
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
  const m: ShopModel = { info: null, signedIn: true, agreed: store()?.getItem(CONSENT_KEY) === '1', busy: null, notice: null };
  const host = document.createElement('div');
  host.innerHTML = shopHtml(m);
  const sheet = host.firstElementChild as HTMLElement;
  document.body.append(sheet);
  const body = sheet.querySelector<HTMLElement>('[data-shop-body]')!;
  const open = () => sheet.isConnected;
  const render = () => { body.innerHTML = shopBodyHtml(m); };
  const say = (n: ShopNotice | null) => { m.notice = n; render(); };
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); o.onClose?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  sheet.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t === sheet || t.closest('[data-a="shop-close"]')) return close();
    const buy = t.closest<HTMLButtonElement>('[data-a="buy"]');
    if (buy && !buy.disabled) void buyPack(buy.dataset.sku ?? '');
    const usdc = t.closest<HTMLButtonElement>('[data-a="buy-usdc"]');
    if (usdc && !usdc.disabled) void buyUsdc(usdc.dataset.sku ?? '');
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
    if (!sku || !m.agreed || m.busy) return;
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

  /** Pay in USDC: server intent -> Phantom signs and sends -> the server reads the payment back from Solana and credits. */
  async function buyUsdc(sku: string) {
    if (!sku || !m.agreed || m.busy || !wallet) return;
    m.busy = sku;
    m.rail = 'usdc';
    m.usdcStep = 'approve';
    say(null);
    try {
      const intent = parseIntent(await callFn('shield-usdc-intent', { sku, ageConfirmed: true }));
      // The badge says which network this build is for: never send money on another one.
      if (intent.cluster !== SHIELD_USDC_CLUSTER) throw new UsdcPayError('The shop is on a different Solana network than this page. Reload and try again.');
      const provider = getPhantomProvider() as PayProvider | null;
      if (!provider) throw new UsdcPayError(USDC_NOTICES.noPhantom.text, 'no-phantom');
      const built = await prepareTransfer(intent, wallet, rpcFor(intent.cluster));
      say(USDC_NOTICES.approve);
      const signature = await signAndSend(provider, built, wallet);
      try { store()?.setItem(USDC_KEY, JSON.stringify({ intentId: intent.intentId, signature })); } catch { /* the payment still confirms below */ }
      await finishUsdc(intent.intentId, signature);
    } catch (e) {
      if (open()) say(e instanceof UsdcPayError && e.kind === 'rejected' ? USDC_NOTICES.rejected : { tone: 'bad', text: e instanceof Error ? e.message : 'The payment did not go through.' });
    } finally {
      m.busy = null;
      m.rail = 'card';
      m.usdcStep = null;
      if (open()) render();
    }
  }

  /** Waits for the server to confirm a sent payment (it credits only after reading it from Solana), then refreshes the shop. */
  async function finishUsdc(intentId: string, signature: string) {
    m.usdcStep = 'confirm';
    say(USDC_NOTICES.confirming);
    let r: ConfirmAnswer | 'timeout';
    try {
      r = await pollConfirm(() => callFn<ConfirmAnswer>('shield-usdc-confirm', { intentId, signature }), { stop: () => !open() });
    } catch (e) {
      // A refusal (4xx other than rate limiting) is final: don't retry it on the next open.
      if (e instanceof FnError && e.status >= 400 && e.status < 500 && e.status !== 429) try { store()?.removeItem(USDC_KEY); } catch { /* ignore */ }
      throw e;
    }
    if (!open()) return;
    if (r === 'timeout') return say(USDC_NOTICES.timeout);
    try { store()?.removeItem(USDC_KEY); } catch { /* ignore */ }
    const short = r.short ?? 0;
    say(short > 0 ? { tone: 'warn', text: `Payment confirmed: +${r.credited ?? 0}. ${short} were over your limit of ${m.info?.cap ?? 14}: email kungfudoom@mail.grokbot.com for a refund.` } : gotShields(r.credited ?? 0));
    await refresh();
  }

  async function resumeUsdc() {
    let saved: { intentId?: unknown; signature?: unknown } | null = null;
    try { saved = JSON.parse(store()?.getItem(USDC_KEY) ?? 'null'); } catch { /* none */ }
    if (typeof saved?.intentId !== 'string' || typeof saved.signature !== 'string' || m.busy) return;
    m.busy = '-';
    m.rail = 'usdc';
    try { await finishUsdc(saved.intentId, saved.signature); } catch (e) { if (open()) say({ tone: 'bad', text: e instanceof Error ? e.message : 'The payment did not go through.' }); } finally {
      m.busy = null;
      m.rail = 'card';
      m.usdcStep = null;
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

  // USDC is for players signed in with Phantom only: the wallet comes from the Supabase user (the server re-reads it from the JWT).
  let wallet = '';
  void (async () => {
    if (MODE_SHIELD_USDC) {
      const { data } = await supabase().auth.getSession().catch(() => ({ data: { session: null } }));
      const opt = usdcOption(data.session?.user as WalletUser | undefined, true, SHIELD_USDC_CLUSTER);
      wallet = opt?.wallet ?? '';
      if (opt) m.usdc = { cluster: opt.cluster };
    }
    await refresh();
    if (!open()) return;
    if (wallet) void resumeUsdc();
    if (o.returned === 'cancel') say(SHOP_NOTICES.cancelled);
    else if (o.returned === 'success') void waitForPayment();
  })();
}
