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
 * Scrolling order of paid ads and tips.
 * Ads lead, and a tip is inserted every `adsBetweenTips(tipRatio)` ads (the default is five).
 * Each tip is shown once per pass. The same tip is never placed twice in a row when a different one exists.
 * With no ads, the tips themselves (still without a repeat in a row), so the ticker stays filled.
 */
export function tickerRotation(
  ads: readonly string[],
  tips: readonly string[],
  tipRatio: number = TICKER_TIP_RATIO,
): TickerSlot[] {
  if (ads.length === 0) return withoutRepeatedTips(tips);
  if (tips.length === 0) return ads.map((text) => ({ kind: 'ad', text }));
  const gap = adsBetweenTips(tipRatio);
  if (!Number.isFinite(gap)) return ads.map((text) => ({ kind: 'ad', text }));
  const out: TickerSlot[] = [];
  let adAt = 0;
  let previousTip: string | null = null;
  for (const text of tips) {
    for (let a = 0; a < gap; a++) {
      out.push({ kind: 'ad', text: ads[adAt % ads.length] });
      adAt += 1;
    }
    // No ads between tips: skip a repeat. Ads between them already keep a repeat from sitting in a row.
    if (gap === 0 && text === previousTip) continue;
    out.push({ kind: 'tip', text });
    previousTip = text;
  }
  return out;
}
