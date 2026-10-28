// Pack Battles tiers: one per public Collector Crypt Pokémon machine. The pot each battle escrows is the
// machine's price; machines.ts pauses a tier whenever CC's live price stops matching it.

/** USDC has 6 decimals; every amount here is an integer number of base units. */
export const MICRO = 1_000_000;

export type PackTier = 'pokemon_25' | 'pokemon_50' | 'pokemon_100';

export const PACK_TIERS: Record<PackTier, { label: string; ccName: string; price: number }> = {
  pokemon_25: { label: 'Starter Pack', ccName: 'Starter Pokémon Gacha Pack', price: 25 * MICRO },
  pokemon_50: { label: 'Elite Pack', ccName: 'Elite Pokémon Gacha Pack', price: 50 * MICRO },
  pokemon_100: { label: 'Bronze Pack', ccName: 'Bronze Pokémon Gacha Pack', price: 100 * MICRO },
};

export const TIER_ORDER: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_100'];

export const isTier = (t: unknown): t is PackTier => typeof t === 'string' && t in PACK_TIERS;

/** "$25" / "$12.50" from base units. */
export const usd = (micro: number) => {
  const d = micro / MICRO;
  return `$${d.toFixed(Number.isInteger(d) ? 0 : 2)}`;
};
