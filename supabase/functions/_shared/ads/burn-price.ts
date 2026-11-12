// Buy-and-burn ad prices: 20% off the matching USDC price, in $PJAM, at the live token price.
// tokens = (USDC price * 0.80) / token price in USD. No API key. The page and pokejam-ads-live both use this.

/** The page asks again on this cadence. Also the server's success cache. */
export const TOKEN_PRICE_POLL_MS = 45_000;
export const TOKEN_PRICE_CACHE_MS = 30_000;

/**
 * A shown amount within this many basis points of a fresh quote is the same price (token prices move).
 * 500 = 5%. Further below the fresh quote is an underpayment and is refused.
 */
export const BURN_PRICE_TOLERANCE_BPS = 500;

/** Shown under a live burn price, plus the clock time the quote was fetched. */
export const BURN_PRICE_NOTE = '20% off vs USDC, live price';
export const PRICE_UNAVAILABLE = 'Price unavailable, try again';

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';

export interface TokenUsd { usd: string; at: string }

export type BurnQuote =
  | { kind: 'catalog'; amount: bigint | null }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'live'; amount: bigint; at: string };

interface UsdParts { num: bigint; scale: bigint }

/** A positive decimal USD price. Null for zero, blank, or anything that is not a plain decimal. */
function parseUsd(raw: string): UsdParts | null {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const digits = `${whole}${frac}`.replace(/^0+/, '') || '0';
  if (digits === '0') return null;
  return { num: BigInt(digits), scale: 10n ** BigInt(frac.length) };
}

/**
 * $PJAM base units for a USDC price (also base units, 6 decimals) at `tokenPriceUsd` per whole token.
 * `(usdcBase * 4/5) / price`, rounded half-up to the nearest whole token.
 * Null when the price is missing or the result rounds to zero: never a zero charge.
 */
export function burnTokensForUsdc(usdcBase: bigint, tokenPriceUsd: string, decimals = 6): bigint | null {
  if (usdcBase <= 0n || decimals < 0 || decimals > 18) return null;
  const price = parseUsd(tokenPriceUsd);
  if (!price) return null;
  const unit = 10n ** BigInt(decimals);
  const raw = (usdcBase * 4n * price.scale) / (5n * price.num);
  const whole = (raw + unit / 2n) / unit;
  if (whole <= 0n) return null;
  return whole * unit;
}

/** True when `shown` is within BURN_PRICE_TOLERANCE_BPS of `fresh` (either way). */
export function withinBurnTolerance(shown: bigint, fresh: bigint, bps = BURN_PRICE_TOLERANCE_BPS): boolean {
  if (shown <= 0n || fresh <= 0n || bps < 0 || bps > 10_000) return false;
  const delta = shown > fresh ? shown - fresh : fresh - shown;
  return delta * 10_000n <= fresh * BigInt(bps);
}

/** What a burn tier should display. A matching USDC price makes it live; no match keeps the catalog amount. */
export function burnQuote(o: {
  usdcBase: bigint | null;
  catalogBase: bigint | null;
  /** undefined: still waiting. null: the fetch failed. A string: the live USD price. */
  tokenUsd: string | null | undefined;
  at?: string | null;
  decimals?: number;
}): BurnQuote {
  if (o.usdcBase === null || o.usdcBase <= 0n) return { kind: 'catalog', amount: o.catalogBase };
  if (o.tokenUsd === undefined) return { kind: 'loading' };
  if (typeof o.tokenUsd !== 'string') return { kind: 'unavailable' };
  const amount = burnTokensForUsdc(o.usdcBase, o.tokenUsd, o.decimals ?? 6);
  if (amount === null) return { kind: 'unavailable' };
  const at = o.at && Number.isFinite(Date.parse(o.at)) ? o.at : '';
  return { kind: 'live', amount, at };
}

/** The amount to charge, or null while loading or unavailable. Never zero. */
export function burnAmount(q: BurnQuote): bigint | null {
  switch (q.kind) {
    case 'live': return q.amount;
    case 'catalog': return q.amount;
    case 'loading':
    case 'unavailable': return null;
    default: {
      const never: never = q;
      return never;
    }
  }
}

export function burnPriceNote(at: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return BURN_PRICE_NOTE;
  const time = new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${BURN_PRICE_NOTE} · updated ${time}`;
}

interface DexPair {
  chainId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  baseToken?: { address?: string };
}

/** The deepest Solana pool's priceUsd for this mint, or null. */
export function priceFromDexScreener(body: unknown, mint: string): string | null {
  const pairs = body && typeof body === 'object' && 'pairs' in body ? (body as { pairs?: unknown }).pairs : null;
  if (!Array.isArray(pairs)) return null;
  let best: { usd: string; liq: number } | null = null;
  for (const row of pairs) {
    if (!row || typeof row !== 'object') continue;
    const pair = row as DexPair;
    if (pair.chainId !== 'solana' || pair.baseToken?.address !== mint) continue;
    if (typeof pair.priceUsd !== 'string' || !parseUsd(pair.priceUsd)) continue;
    const liq = typeof pair.liquidity?.usd === 'number' && Number.isFinite(pair.liquidity.usd) ? pair.liquidity.usd : 0;
    if (!best || liq > best.liq) best = { usd: pair.priceUsd, liq };
  }
  return best?.usd ?? null;
}

/** Live $PJAM price in USD from DexScreener. Null on any failure: callers must not keep a previous price. */
export async function fetchDexScreenerPrice(mint: string, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<TokenUsd | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  try {
    const res = await fetchImpl(`${DEXSCREENER_TOKENS}${mint}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const usd = priceFromDexScreener(await res.json(), mint);
    if (!usd) return null;
    return { usd, at: now().toISOString() };
  } catch {
    return null;
  }
}
