// Rank Shield shop sheet (behind MODE_SHIELD_SHOP): loads the packs, sends a sku to the shield-create-checkout Edge Function,
// and hands the player to Stripe's hosted page. It never sees card data or a price it could change, and it never credits
// anything: coming back from Stripe it only waits (polls pokejam_shield_me) for the webhook's credit to show up.
import { supabase } from '../shared/supabase';
import type { SupabaseMatchService } from '../shared/onlineMatchService';
import { SHOP_NOTICES, gotShields, pollForRise, shopBodyHtml, shopHtml, type ShopModel, type ShopNotice } from './shopView';

/** The held count just before leaving for Stripe, so the page that comes back knows what "more" means. */
const BEFORE_KEY = 'pokejam.shop.before';
const CONSENT_KEY = 'pokejam.shop.age';

const store = () => { try { return window.sessionStorage; } catch { return null; } };

/** A player-facing reason from a failed shield-create-checkout call. */
async function checkoutError(error: unknown): Promise<string> {
  const e = error as { name?: string; context?: unknown };
  if (e?.name === 'FunctionsFetchError' || e?.name === 'FunctionsRelayError') return 'Could not reach the shop. Try again in a moment.';
  if (e?.context instanceof Response) {
    const body = (await e.context.clone().json().catch(() => null)) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return body.error;
  }
  return 'Could not start checkout. Try again in a moment.';
}

/** Creates the Stripe Checkout Session; returns its hosted-page URL. */
async function startCheckout(sku: string): Promise<string> {
  const { data, error } = await supabase().functions.invoke('shield-create-checkout', { body: { sku, ageConfirmed: true } });
  if (error) throw new Error(await checkoutError(error));
  const url = (data as { url?: unknown } | null)?.url;
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

  void (async () => {
    await refresh();
    if (!open()) return;
    if (o.returned === 'cancel') say(SHOP_NOTICES.cancelled);
    else if (o.returned === 'success') void waitForPayment();
  })();
}
