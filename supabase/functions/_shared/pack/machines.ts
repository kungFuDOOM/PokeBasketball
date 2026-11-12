// Collector Crypt's live machines: price, stock and odds per Pack Battles tier.
//
// A battle's pot is the tier's price from tiers.ts, so a pull is only safe to buy while the machine still sells it
// at that price. A tier is paused when its machine is missing, not public or switched off, out of a prize tier
// ("Machine is empty"), or repriced. The payout worker checks right before buying; the machines function
// refreshes pokejam_pack_machines for the lobby.
//
// Builder fee: with a partner key (CC_API_KEY), CC's GET /api/v1/machines lists the machines the key owns. When we
// own an adopted copy of a tier's builder-fee machine (bf_poke25/50/100), the tier buys from it and the partner fee
// it carries is recorded, so Pack Battles charges no fee of its own on that tier (20261217_pokejam_pack_builder_fee).
// Without one, the tier uses CC's own machine at that price, as before.

import { PACK_TIERS, TIER_ORDER, MICRO, usd, type PackTier } from './tiers.ts';

export interface MachineInfo {
  code: string;
  /** Price in USDC base units. */
  price: number;
  available: boolean;
  /** Why it isn't available (not a price mismatch). */
  why: string | null;
  odds: Record<string, number> | null;
  /** Expected insured value in dollars, and the instant-buyback rate (0..1). */
  ev: number | null;
  buyback: number | null;
  /** Our partner fee on this machine, in USDC base units (0 on CC's own machines). */
  partnerFee: number;
  /** The machine's display name, when CC gives one. */
  name: string | null;
}

interface RawMachine {
  code?: string; name?: string; price?: number; public?: boolean; enabled?: boolean; instantBuyback?: number; ev?: number | null;
  odds?: Record<string, number> | null; stock?: Record<string, number>; partnerFee?: number | null;
}

/** CC's GET /api/machines (or the key's GET /api/v1/machines), keyed by machine code. */
export function parseMachines(raw: unknown): Map<string, MachineInfo> {
  const out = new Map<string, MachineInfo>();
  for (const m of ((raw as { machines?: RawMachine[] } | null)?.machines ?? [])) {
    if (!m?.code || typeof m.price !== 'number') continue;
    const odds = m.odds && typeof m.odds === 'object' ? m.odds : null;
    const emptyTier = odds && m.stock ? Object.keys(odds).find((k) => odds[k] > 0 && !(Number(m.stock![k]) > 0)) : undefined;
    const why = m.enabled === false ? 'switched off' : m.public === false ? 'not public' : emptyTier ? `out of ${emptyTier} cards` : null;
    const fee = typeof m.partnerFee === 'number' && m.partnerFee > 0 ? Math.round(m.partnerFee * MICRO) : 0;
    out.set(m.code, {
      code: m.code, price: Math.round(m.price * MICRO), available: !why, why, odds,
      ev: typeof m.ev === 'number' ? m.ev : null,
      buyback: typeof m.instantBuyback === 'number' ? m.instantBuyback / 100 : null,
      partnerFee: fee, name: typeof m.name === 'string' ? m.name : null,
    });
  }
  return out;
}

/** Our own machine for a tier on the partner key's list: the one CC_MACHINE_CODES names, else an enabled
 * Pokémon machine at the tier's price that was adopted from the tier's builder-fee machine. */
function partnerFor(tier: PackTier, partner: Map<string, MachineInfo>, codes: Partial<Record<string, string>>): MachineInfo | null {
  const named = codes[tier];
  if (named) return partner.get(named) ?? null;
  const t = PACK_TIERS[tier];
  const looksLike = (m: MachineInfo) => m.code === t.partner || m.code.startsWith(`${t.partner}_`) || /pok[eé]/i.test(`${m.code} ${m.name ?? ''}`);
  const fits = [...partner.values()].filter((m) => m.price === t.price && looksLike(m));
  return fits.find((m) => m.available) ?? fits[0] ?? null;
}

/** The machine each tier buys from: our adopted builder-fee machine when the key owns one, else CC's own. */
export function tierMachines(house: Map<string, MachineInfo>, partner: Map<string, MachineInfo> = new Map(), codes: Partial<Record<string, string>> = {}) {
  const out = new Map<PackTier, MachineInfo | null>();
  for (const tier of TIER_ORDER) out.set(tier, partnerFor(tier, partner, codes) ?? house.get(tier) ?? null);
  return out;
}

/** Why a tier's pull can't be bought right now, or null when it can. Shown to players: no third-party names. */
export function blockedReason(tier: PackTier, m: MachineInfo | null | undefined): string | null {
  const t = PACK_TIERS[tier];
  if (!m) return `The ${t.label} isn't available right now.`;
  if (!m.available) return `The ${t.label} is paused right now (${m.why}).`;
  if (m.price !== t.price) return `The ${t.label} now costs ${usd(m.price)}, which no longer matches the ${usd(t.price)} pot, so it's paused.`;
  return null;
}

/** Rows for pokejam_pack_upsert_machines: every Pack Battles tier, offered or not. */
export function machineRows(machines: Map<PackTier, MachineInfo | null>) {
  return TIER_ORDER.map((tier) => {
    const m = machines.get(tier) ?? null;
    return {
      code: tier, price_micro: m?.price ?? null, available: !blockedReason(tier, m), why: blockedReason(tier, m),
      odds: m?.odds ?? null, ev: m?.ev ?? null, buyback: m?.buyback ?? null,
      machine_code: m?.code ?? null, partner_fee_micro: m?.partnerFee ?? 0,
    };
  });
}
