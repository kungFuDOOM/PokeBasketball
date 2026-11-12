/** Share of the ads-and-tips mix that is tips while paid ads are booked. One tip after every five ads. */
export const TICKER_TIP_RATIO = 1 / 6;

export type TickerSlot =
  | { kind: 'ad'; text: string }
  | { kind: 'tip'; text: string };

/** Paid-ad slots before each tip. 1/6 → 5. A ratio of 0 or less means ads only. */
function adsBetweenTips(tipRatio: number): number {
  if (!(tipRatio > 0)) return Infinity;
  if (tipRatio >= 1) return 0;
  return Math.max(0, Math.round((1 - tipRatio) / tipRatio));
}

/** Drop a tip that repeats the previous one. A single distinct tip is kept once, so the line is not empty. */
function withoutRepeatedTips(tips: readonly string[]): TickerSlot[] {
  const out: TickerSlot[] = [];
  for (const text of tips) {
    const prev = out[out.length - 1];
    if (prev?.kind === 'tip' && prev.text === text) continue;
    out.push({ kind: 'tip', text });
  }
  return out;
}

/**
 * Ads for one pass of the ticker: paid ads alternating with house slots.
 * One paid ad reads paid, first house, paid, second house, paid.
 * Each paid ad is given at least as many of `slots` as each house item, and the same ad is not
 * placed twice in a row when another one exists.
 */
export function adBlockPool(paid: readonly string[], house: readonly string[], slots: number): string[] {
  if (slots <= 0) return [];
  if (paid.length === 0) return Array.from({ length: slots }, (_, i) => house[i % house.length]);
  if (house.length === 0) return Array.from({ length: slots }, (_, i) => paid[i % paid.length]);
  const k = Math.max(1, Math.ceil(paid.length / house.length));
  const out: string[] = [];
  let p = 0;
  let h = 0;
  while (out.length < slots) {
    for (let i = 0; i < k && out.length < slots; i++) {
      out.push(paid[p % paid.length]);
      p += 1;
    }
    if (out.length < slots) {
      out.push(house[h % house.length]);
      h += 1;
    }
  }
  return balancePaidSlots(out, paid, house);
}

/** Swap a surplus house slot for a paid ad that has fallen behind, without repeating either neighbor. */
function balancePaidSlots(seq: readonly string[], paid: readonly string[], house: readonly string[]): string[] {
  const out = [...seq];
  const uniq = (list: readonly string[]) => [...new Set(list)];
  const paidU = uniq(paid);
  const houseU = uniq(house);
  const count = (text: string) => out.reduce((n, t) => n + (t === text ? 1 : 0), 0);
  const minPaid = () => Math.min(...paidU.map(count));
  const maxHouse = () => Math.max(...houseU.map(count));
  let guard = out.length;
  while (guard > 0 && minPaid() < maxHouse()) {
    guard -= 1;
    const lagging = paidU.filter((t) => count(t) === minPaid());
    const heavy = new Set(houseU.filter((t) => count(t) === maxHouse()));
    let replaced = false;
    for (let i = out.length - 1; i >= 0 && !replaced; i--) {
      if (!heavy.has(out[i])) continue;
      for (const ad of lagging) {
        const prev = i > 0 ? out[i - 1] : null;
        const next = i + 1 < out.length ? out[i + 1] : null;
        if (ad !== prev && ad !== next) {
          out[i] = ad;
          replaced = true;
          break;
        }
      }
    }
    if (!replaced) break;
  }
  return out;
}

/**
 * Scrolling order of paid ads and tips.
 * Ads lead, and a tip is inserted every `adsBetweenTips(tipRatio)` ads (the default is five).
 * Pass `house` (the $PJAM line and the open slot) so those fill the ad blocks with the paid ads.
 * Each tip is shown once per pass. The same tip is never placed twice in a row when a different one exists.
 * With no ads, the tips themselves (still without a repeat in a row), so the ticker stays filled.
 */
export function tickerRotation(
  ads: readonly string[],
  tips: readonly string[],
  tipRatio: number = TICKER_TIP_RATIO,
  house: readonly string[] = [],
): TickerSlot[] {
  if (ads.length === 0) return withoutRepeatedTips(tips);
  if (tips.length === 0) return ads.map((text) => ({ kind: 'ad', text }));
  const gap = adsBetweenTips(tipRatio);
  if (!Number.isFinite(gap)) return ads.map((text) => ({ kind: 'ad', text }));
  const pooled = house.length > 0 && gap > 0 ? adBlockPool(ads, house, tips.length * gap) : null;
  const out: TickerSlot[] = [];
  let adAt = 0;
  let previousTip: string | null = null;
  for (const text of tips) {
    for (let a = 0; a < gap; a++) {
      out.push({ kind: 'ad', text: pooled ? pooled[adAt] : ads[adAt % ads.length] });
      adAt += 1;
    }
    // No ads between tips: skip a repeat. Ads between them already keep a repeat from sitting in a row.
    if (gap === 0 && text === previousTip) continue;
    out.push({ kind: 'tip', text });
    previousTip = text;
  }
  return out;
}
