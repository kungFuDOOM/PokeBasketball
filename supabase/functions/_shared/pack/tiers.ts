// Pack Battles tiers: one per Collector Crypt Pokémon machine price. The pot each battle escrows is the machine's
// price; machines.ts pauses a tier whenever the live price stops matching it. `house` is CC's own machine at that
// price; `partner` is the builder-fee machine a partner key adopts to earn a fee on every pack (machines.ts uses our
// adopted copy of it when the key owns one).

/** USDC has 6 decimals; every amount here is an integer number of base units. */
export const MICRO = 1_000_000;

export type PackTier = 'pokemon_25' | 'pokemon_50' | 'pokemon_100';

export const PACK_TIERS: Record<PackTier, { label: string; ccName: string; price: number; partner: string }> = {
  pokemon_25: { label: 'Starter Pack', ccName: 'Starter Pokémon Gacha Pack', price: 25 * MICRO, partner: 'bf_poke25' },
  pokemon_50: { label: 'Elite Pack', ccName: 'Elite Pokémon Gacha Pack', price: 50 * MICRO, partner: 'bf_poke50' },
  pokemon_100: { label: 'Bronze Pack', ccName: 'Bronze Pokémon Gacha Pack', price: 100 * MICRO, partner: 'bf_poke100' },
};

export const TIER_ORDER: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_100'];

export const isTier = (t: unknown): t is PackTier => typeof t === 'string' && t in PACK_TIERS;

/** "$25" / "$12.50" from base units. */
export const usd = (micro: number) => {
  const d = micro / MICRO;
  return `$${d.toFixed(Number.isInteger(d) ? 0 : 2)}`;
};
