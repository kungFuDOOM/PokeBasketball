// Collector Crypt's live machines: price, stock and odds per Pack Battles tier.
//
// A battle's pot is the tier's price from tiers.ts, so a pull is only safe to buy while CC still sells it
// at that price. A tier is paused when its machine is missing, not public, out of a prize tier
// ("Machine is empty"), or repriced. The payout worker checks right before buying; the machines function
// refreshes pokejam_pack_machines for the lobby.

import { PACK_TIERS, TIER_ORDER, MICRO, usd, type PackTier } from './tiers.ts';

export interface MachineInfo {
  code: string;
  /** Price in USDC base units. */
  price: number;
  available: boolean;
  /** CC's own reason it isn't available (not a price mismatch). */
  why: string | null;
  odds: Record<string, number> | null;
  /** Expected insured value in dollars, and the instant-buyback rate (0..1). */
  ev: number | null;
  buyback: number | null;
}

interface RawMachine {
  code?: string; price?: number; public?: boolean; instantBuyback?: number; ev?: number;
  odds?: Record<string, number>; stock?: Record<string, number>;
}

/** CC's GET /api/machines, keyed by machine code. */
export function parseMachines(raw: unknown): Map<string, MachineInfo> {
  const out = new Map<string, MachineInfo>();
  for (const m of ((raw as { machines?: RawMachine[] } | null)?.machines ?? [])) {
    if (!m?.code || typeof m.price !== 'number') continue;
    const odds = m.odds && typeof m.odds === 'object' ? m.odds : null;
    const emptyTier = odds && m.stock ? Object.keys(odds).find((k) => odds[k] > 0 && !(Number(m.stock![k]) > 0)) : undefined;
    const why = m.public === false ? 'not public' : emptyTier ? `out of ${emptyTier} cards` : null;
    out.set(m.code, {
      code: m.code, price: Math.round(m.price * MICRO), available: !why, why, odds,
      ev: typeof m.ev === 'number' ? m.ev : null,
      buyback: typeof m.instantBuyback === 'number' ? m.instantBuyback / 100 : null,
    });
  }
  return out;
}

/** Why a tier's pull can't be bought right now, or null when it can. */
export function blockedReason(tier: PackTier, m: MachineInfo | null | undefined): string | null {
  const t = PACK_TIERS[tier];
  if (!m) return `Collector Crypt isn't offering the ${t.ccName} right now.`;
  if (!m.available) return `Collector Crypt's ${t.ccName} machine is ${m.why} right now.`;
  if (m.price !== t.price) return `Collector Crypt changed the ${t.ccName} price to ${usd(m.price)}, so it no longer matches the ${usd(t.price)} pot.`;
  return null;
}

/** Rows for pokejam_pack_upsert_machines: every Pack Battles tier, offered or not. */
export function machineRows(machines: Map<string, MachineInfo>) {
  return TIER_ORDER.map((tier) => {
    const m = machines.get(tier) ?? null;
    return {
      code: tier, price_micro: m?.price ?? null, available: !blockedReason(tier, m), why: blockedReason(tier, m),
      odds: m?.odds ?? null, ev: m?.ev ?? null, buyback: m?.buyback ?? null,
    };
  });
}
