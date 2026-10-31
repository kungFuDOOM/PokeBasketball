import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubEnv('VITE_MODE_RANKED', 'true'));
import { parseShopInfo } from './serverRank';
import { gotShields, packBlock, perShield, pollForRise, shopBodyHtml, shopHtml, shopReturnOf, usd, type ShopModel } from './shopView';
import { shieldItemHtml } from './view';

const info = (o: Record<string, unknown> = {}) => parseShopInfo({
  held: 3, cap: 14, purchases_left: 39, blocked: false,
  products: [{ sku: 'shield_14', units: 14, price_cents: 699 }, { sku: 'shield_3', units: 3, price_cents: 199 }, { sku: 'shield_7', units: 7, price_cents: 399 }], ...o })!;
const model = (o: Partial<ShopModel> = {}): ShopModel => ({ info: info(), signedIn: true, agreed: false, busy: null, notice: null, ...o });
const buyButtons = (html: string) => [...html.matchAll(/<button class="btn primary shop-buy"[^>]*?( disabled)?>/g)].map((m) => !m[1]);

describe('parseShopInfo', () => {
  it('sorts the packs by size and reads held, cap and what is left to buy', () => {
    expect(info()).toMatchObject({ held: 3, cap: 14, purchasesLeft: 39, blocked: false });
    expect(info().products.map((p) => [p.sku, p.units, p.priceCents])).toEqual([['shield_3', 3, 199], ['shield_7', 7, 399], ['shield_14', 14, 699]]);
  });
  it('drops unusable products and returns null for nonsense', () => {
    expect(info({ products: [{ sku: 'x', units: 0, price_cents: 5 }, { units: 3, price_cents: 5 }, null, { sku: 'ok', units: '3', price_cents: '199' }] }).products).toEqual([{ sku: 'ok', units: 3, priceCents: 199 }]);
    expect(parseShopInfo(null)).toBeNull();
    expect(parseShopInfo([])).toBeNull();
    expect(parseShopInfo({ products: [] })).toBeNull();
    expect(parseShopInfo({ held: 1 })).toMatchObject({ products: [], cap: 14, purchasesLeft: 0 });
  });
});

describe('shop sheet', () => {
  it('shows three packs with price and per-shield cost, Held 3 / 14, Stripe, the age box and the three links', () => {
    const html = shopBodyHtml(model());
    expect(html).toContain('$1.99');
    expect(html).toContain('$3.99');
    expect(html).toContain('$6.99');
    expect(html).toContain('$0.66 each');
    expect(html).toContain('$0.57 each');
    expect(html).toContain('$0.50 each');
    expect(html).toContain('Held <strong>3 / 14</strong>');
    expect(html).toContain('Secure checkout by Stripe');
    expect(html).toContain("I'm 18+ or have a parent's permission");
    expect(html).toMatch(/terms\.html#sale[^>]*>Terms of sale/);
    expect(html).toMatch(/terms\.html#refunds[^>]*>Refunds/);
    expect(html).toMatch(/privacy\.html[^>]*>Privacy/);
    expect(shopHtml(model())).toContain('aria-modal="true"');
  });
  it('keeps Buy off until the box is ticked, and off for a pack that would pass 14 held or the season cap', () => {
    expect(buyButtons(shopBodyHtml(model()))).toEqual([false, false, false]);
    expect(buyButtons(shopBodyHtml(model({ agreed: true, info: info({ held: 0 }) })))).toEqual([true, true, true]);
    expect(buyButtons(shopBodyHtml(model({ agreed: true })))).toEqual([true, true, false]); // 3 held + 14 would pass the cap
    expect(buyButtons(shopBodyHtml(model({ agreed: true, info: info({ held: 8 }) })))).toEqual([true, false, false]);
    expect(buyButtons(shopBodyHtml(model({ agreed: true, info: info({ purchases_left: 5 }) })))).toEqual([true, false, false]);
    expect(buyButtons(shopBodyHtml(model({ agreed: true, info: info({ blocked: true }) })))).toEqual([false, false, false]);
    expect(buyButtons(shopBodyHtml(model({ agreed: true, busy: 'shield_3' })))).toEqual([false, false, false]);
    expect(shopBodyHtml(model({ agreed: true, busy: 'shield_3' }))).toContain('Opening…');
  });
  it('shows Sign in to buy to a guest, Shop coming soon with no active packs, and the notice text escaped', () => {
    const g = shopBodyHtml(model({ signedIn: false, info: null }));
    expect(g).toContain('Sign in to buy');
    expect(g).not.toContain('data-a="buy"');
    const guest = model({ signedIn: false, info: null });
    expect(shopBodyHtml(guest, { google: false })).toContain('Sign in with Phantom from the Ranked screen.');
    expect(shopBodyHtml(guest, { google: true })).toContain('Sign in with Google or Phantom from the Ranked screen.');
    expect(shopHtml(guest, { google: false })).not.toContain('Google');
    expect(shopBodyHtml(model({ info: info({ products: [] }) }))).toContain('Shop coming soon');
    expect(shopBodyHtml(model({ info: null }))).toContain('Loading the shop');
    expect(shopBodyHtml(model({ notice: { tone: 'bad', text: '<img src=x>' } }))).not.toContain('<img');
  });
  it('formats prices, per-shield costs and block reasons', () => {
    expect(usd(199)).toBe('$1.99');
    expect(perShield({ sku: 's', units: 14, priceCents: 699 })).toBe('$0.50 each');
    expect(packBlock({ sku: 's', units: 3, priceCents: 199 }, info({ held: 12 }))).toBe('Max 14 held');
    expect(packBlock({ sku: 's', units: 3, priceCents: 199 }, info())).toBeNull();
    expect(gotShields(1).text).toBe('Payment confirmed: +1 Rank Shield.');
    expect(gotShields(7).text).toBe('Payment confirmed: +7 Rank Shields.');
  });
  it('the hub chip has a Shop button only when the shop is on', () => {
    const st = { count: 3, armed: false, locked: false, nextUseAt: null, block: null };
    expect(shieldItemHtml(st)).not.toContain('data-a="shop"');
    expect(shieldItemHtml(st, Date.now(), true)).toContain('data-a="shop"');
  });
  it('reads the Stripe return parameter', () => {
    expect(shopReturnOf('?shop=success')).toBe('success');
    expect(shopReturnOf('?a=1&shop=cancel')).toBe('cancel');
    expect(shopReturnOf('?shop=1')).toBeNull();
    expect(shopReturnOf('')).toBeNull();
  });
});

describe('pollForRise', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  it('resolves with the new count as soon as it rises above the old one', async () => {
    const c = clock();
    const reads = [3, 3, 3, 10];
    const read = vi.fn(async () => reads.shift() ?? 10);
    expect(await pollForRise(read, 3, c)).toBe(10);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('gives up with null at the timeout, tolerates read errors, and stops when asked', async () => {
    const c = clock();
    expect(await pollForRise(async () => 3, 3, { ...c, intervalMs: 2000, timeoutMs: 10_000 })).toBeNull();
    let n = 0;
    expect(await pollForRise(async () => { if (++n < 3) throw new Error('offline'); return 4; }, 3, clock())).toBe(4);
    expect(await pollForRise(async () => 3, 3, { ...clock(), stop: () => true })).toBeNull();
  });
});
