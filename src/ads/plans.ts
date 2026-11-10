// What the Advertise page offers. The server is the only source of prices: the plans come from the board
// (pokejam_live_ad_plans), so a price change needs no client rebuild. Before the board has loaded, the page shows the usual
// plan names with no price, and paying stays off.
export type Plan = 'hour' | 'day' | 'week' | 'month';
export type PayMethod = 'burn' | 'usdc';

/** One row of the board's `plans`. `amount` is in base units. */
export interface BoardPlan { method: PayMethod; plan: Plan; hours: number; amount: string }
export interface PlanOffer { plan: Plan; hours: number; amount: bigint | null }

const HOURS: Record<Plan, number> = { hour: 1, day: 24, week: 168, month: 720 };
const ALL: Plan[] = ['hour', 'day', 'week', 'month'];
/** Display only, until the board answers. Every tier can be USDC or burn. */
const FALLBACK: Record<PayMethod, Plan[]> = { burn: ALL, usdc: ALL };

export const isPlan = (p: unknown): p is Plan => typeof p === 'string' && p in HOURS;

/** The plans for one way to pay, shortest first: the server's list once it's loaded, else names with no price. */
export function offers(plans: BoardPlan[] | null | undefined, method: PayMethod): PlanOffer[] {
  if (!plans) return FALLBACK[method].map((plan) => ({ plan, hours: HOURS[plan], amount: null }));
  return plans.filter((p) => p.method === method && isPlan(p.plan) && /^\d+$/.test(p.amount))
    .map((p) => ({ plan: p.plan, hours: p.hours, amount: BigInt(p.amount) }))
    .sort((a, b) => a.hours - b.hours);
}

/**
 * Burn cards follow the USDC tiers. The token amount is not stored: the page prices it from the live
 * $PJAM price. A board with no USDC rows (the devnet test site) uses its own burn rows.
 */
export function burnOffers(plans: BoardPlan[] | null | undefined): PlanOffer[] {
  const usdc = offers(plans, 'usdc');
  if (usdc.length) return usdc.map((o) => ({ plan: o.plan, hours: o.hours, amount: null }));
  return offers(plans, 'burn');
}

/** `want` if it's on offer, else the plan closest to the middle of the list. */
export function pickPlan(list: PlanOffer[], want: Plan): Plan {
  return list.some((o) => o.plan === want) ? want : (list[Math.floor((list.length - 1) / 2)]?.plan ?? want);
}

/**
 * Separate badges for a plan card. "Best value" and "Save N%" are two chips so a narrow card can wrap them
 * instead of running the words together across the next card.
 */
export function planBadges(save: number, best: boolean): string {
  const bits: string[] = [];
  if (best) bits.push('<span class="ad-badge best">Best value</span>');
  if (save >= 5) bits.push(`<span class="ad-badge save">Save ${save}%</span>`);
  return bits.length ? `<span class="ad-badges">${bits.join('')}</span>` : '';
}

/** Whole percent saved per hour against the shortest plan on offer (0 for that plan itself, or with no prices yet). */
export function savePercent(o: PlanOffer, list: PlanOffer[]): number {
  const base = list[0];
  if (o.amount === null || !base || base.amount === null || base.amount <= 0n || o.hours <= base.hours) return 0;
  const full = (base.amount * BigInt(o.hours)) / BigInt(base.hours);
  return full > o.amount ? Number(((full - o.amount) * 100n) / full) : 0;
}

/** Arranged by DM and paid in SOL: shown for information, with no checkout. */
export const DM_ONLY: { name: string; prices: string }[] = [
  { name: 'Ticker ad', prices: '$75 a week · $250 a month' },
  { name: 'Ticker + courtside combo', prices: '$650 a month' },
];
export const DM_CONTACTS: { label: string; href: string }[] = [
  { label: 'X @pokejamsol', href: 'https://x.com/pokejamsol' },
  { label: 't.me/PokeJamSol', href: 'https://t.me/PokeJamSol' },
];
