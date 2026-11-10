import { describe, expect, it } from 'vitest';
import {
  BURN_PRICE_NOTE, BURN_PRICE_TOLERANCE_BPS, PRICE_UNAVAILABLE, TOKEN_PRICE_POLL_MS,
  burnAmount, burnPriceNote, burnQuote, burnTokensForUsdc, fetchDexScreenerPrice, priceFromDexScreener, withinBurnTolerance,
} from './burn-price.ts';

const M = 1_000_000n;
/** Week on the live board: 150 USDC. */
const WEEK_USDC = 150n * M;
/** 0.0001124 USD, the shape DexScreener returns. */
const USD = '0.0001124';

describe('buy-and-burn price', () => {
  it('is 20% off the USDC price at the live token price, rounded to a whole token', () => {
    // 150 * 0.80 / 0.0001124 = 1,067,615.658… tokens → 1,067,616
    expect(burnTokensForUsdc(WEEK_USDC, USD)).toBe(1_067_616n * M);
    expect(burnTokensForUsdc(100n * M, '0.5')).toBe(160n * M); // 100 * 0.80 / 0.5 = 160
    expect(burnTokensForUsdc(10n * M, '0.03')).toBe(267n * M); // 8 / 0.03 = 266.666… → 267
  });

  it('is null for a missing, zero, or unusable price, never a zero charge', () => {
    expect(burnTokensForUsdc(WEEK_USDC, '0')).toBeNull();
    expect(burnTokensForUsdc(WEEK_USDC, '0.000')).toBeNull();
    expect(burnTokensForUsdc(WEEK_USDC, '')).toBeNull();
    expect(burnTokensForUsdc(WEEK_USDC, '-1')).toBeNull();
    expect(burnTokensForUsdc(WEEK_USDC, '1e-4')).toBeNull();
    expect(burnTokensForUsdc(0n, USD)).toBeNull();
    expect(burnTokensForUsdc(1n, '1000000')).toBeNull();
  });

  it('accepts a quote within 5% and refuses a larger gap', () => {
    const fresh = 1_000_000n * M;
    const slop = fresh / 20n; // 5%
    expect(BURN_PRICE_TOLERANCE_BPS).toBe(500);
    expect(withinBurnTolerance(fresh, fresh)).toBe(true);
    expect(withinBurnTolerance(fresh - slop, fresh)).toBe(true);
    expect(withinBurnTolerance(fresh + slop, fresh)).toBe(true);
    expect(withinBurnTolerance(fresh - slop - 1n, fresh)).toBe(false);
    expect(withinBurnTolerance(fresh / 2n, fresh)).toBe(false);
    expect(withinBurnTolerance(0n, fresh)).toBe(false);
  });

  it('shows a live amount, and loading or unavailable instead of a stale or zero amount', () => {
    const live = burnQuote({ usdcBase: WEEK_USDC, catalogBase: 7_500_000n * M, tokenUsd: USD, at: '2026-11-10T22:00:00.000Z' });
    expect(live).toMatchObject({ kind: 'live', amount: 1_067_616n * M });
    expect(burnAmount(live)).toBe(1_067_616n * M);

    const loading = burnQuote({ usdcBase: WEEK_USDC, catalogBase: 7_500_000n * M, tokenUsd: undefined });
    expect(loading.kind).toBe('loading');
    expect(burnAmount(loading)).toBeNull();

    for (const tokenUsd of [null, '0', 'nope']) {
      const down = burnQuote({ usdcBase: WEEK_USDC, catalogBase: 7_500_000n * M, tokenUsd });
      expect(down.kind).toBe('unavailable');
      expect(burnAmount(down)).toBeNull();
    }

    // No matching USDC tier: the catalog burn price stays.
    expect(burnQuote({ usdcBase: null, catalogBase: 100_000n * M, tokenUsd: null })).toEqual({ kind: 'catalog', amount: 100_000n * M });
  });

  it('notes the discount and when the price was fetched', () => {
    expect(PRICE_UNAVAILABLE).toMatch(/unavailable/i);
    expect(burnPriceNote('not-a-date')).toBe(BURN_PRICE_NOTE);
    expect(burnPriceNote('2026-11-10T22:04:00.000Z')).toMatch(/^20% off vs USDC, live price · updated /);
    expect(TOKEN_PRICE_POLL_MS).toBeGreaterThanOrEqual(30_000);
    expect(TOKEN_PRICE_POLL_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('DexScreener price', () => {
  const mint = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
  const body = {
    pairs: [
      { chainId: 'solana', priceUsd: '0.00004727', liquidity: { usd: 100 }, baseToken: { address: mint } },
      { chainId: 'solana', priceUsd: '0.0001124', liquidity: { usd: 24778.78 }, baseToken: { address: mint } },
      { chainId: 'ethereum', priceUsd: '9', liquidity: { usd: 1_000_000 }, baseToken: { address: mint } },
      { chainId: 'solana', priceUsd: '0', liquidity: { usd: 99_000 }, baseToken: { address: mint } },
    ],
  };

  it('uses the deepest Solana pool and ignores other chains and bad prices', () => {
    expect(priceFromDexScreener(body, mint)).toBe('0.0001124');
    expect(priceFromDexScreener({ pairs: [] }, mint)).toBeNull();
    expect(priceFromDexScreener(null, mint)).toBeNull();
  });

  it('returns null when the request fails, and does not invent a price', async () => {
    const at = new Date('2026-11-10T22:04:00.000Z');
    const ok = async () => new Response(JSON.stringify(body), { status: 200 });
    expect(await fetchDexScreenerPrice(mint, ok, () => at)).toEqual({ usd: '0.0001124', at: at.toISOString() });
    expect(await fetchDexScreenerPrice(mint, async () => new Response('no', { status: 500 }))).toBeNull();
    expect(await fetchDexScreenerPrice(mint, async () => { throw new Error('offline'); })).toBeNull();
    expect(await fetchDexScreenerPrice('not-a-mint', ok)).toBeNull();
  });
});
