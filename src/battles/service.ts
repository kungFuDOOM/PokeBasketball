// Pack Battles: two players split the cost of a Collector Crypt gacha pull, snake-draft five Pokémon
// each, play one game, and the winner gets the pull.
//
// Pull first, then play: after the draft, the house wallet buys and opens the pull with both players'
// entries, so they see the exact card they're playing for. Collector Crypt's VRF picks that card, and
// its output also seeds the game (mixed with the server's committed seed and both players' seeds), so
// nobody, the server included, can choose the game's random rolls. After the game the card is
// transferred to the winner.
//
// Shared constants and types for the game client and the server. The server (server/) holds the money,
// runs the draft and the game, decides the winner and buys the pull; the screens only show what it says.
// Without a server configured, the game falls back to LocalBackend (battles/local.ts): play money and CPU
// challengers, so the flow can be tried offline.

/** Collector Crypt machine codes (`packType` in their Gacha Machine API). */
export type PackTier = 'pokemon_25' | 'pokemon_50' | 'pokemon_100';

/**
 * One tier per public Collector Crypt Pokémon machine. Prices are in cents. Prices and odds were read from
 * GET https://gacha.collectorcrypt.com/api/machines on 2026-10-21; check them against that endpoint
 * before launch and whenever Collector Crypt changes a machine.
 */
export const PACK_TIERS: Record<PackTier, {
  label: string; ccName: string; short: string; color: string; color2: string; price: number;
  odds: { Common: number; Uncommon: number; Rare: number; Epic: number };
}> = {
  pokemon_25: { label: 'Starter Pack', ccName: 'Starter Pokémon Gacha Pack', short: 'STARTER', color: '#3b6fd8', color2: '#0f1a45', price: 2500, odds: { Common: 0.75, Uncommon: 0.2, Rare: 0.04, Epic: 0.01 } },
  pokemon_50: { label: 'Elite Pack', ccName: 'Elite Pokémon Gacha Pack', short: 'ELITE', color: '#e3350d', color2: '#3d0a03', price: 5000, odds: { Common: 0.8, Uncommon: 0.15, Rare: 0.04, Epic: 0.01 } },
  pokemon_100: { label: 'Bronze Pack', ccName: 'Bronze Pokémon Gacha Pack', short: 'BRONZE', color: '#ffcb05', color2: '#5c3d00', price: 10000, odds: { Common: 0.8, Uncommon: 0.15, Rare: 0.04, Epic: 0.01 } },
};
export const TIER_ORDER: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_100'];
export const BATTLE_QUARTERS = [60, 120, 180] as const;

/** A pull the house bought for a battle: the card, and Collector Crypt's VRF record for it. */
export interface Pull {
  /** Collector Crypt's memo for the purchase; it names the pack in every CC verification tool. */
  memo: string;
  nftAddress: string;
  name: string;
  image: string | null;
  /** Collector Crypt's insured value for the card, in dollars. */
  insuredValue: number | null;
  grade: string | null;
  rarity: string | null;
  /** The tier roll CC's VRF produced (1..100,000,000). */
  roll: number | null;
  /** The VRF output this game is seeded from: CC's beta (hex) when published, else the roll. */
  entropy: string;
  /** CC's VRF verification record for the memo, exactly as returned (null if it wasn't available). */
  vrf: unknown;
}

/** Where prize pulls come from. Server-side only; server/collector-crypt.ts implements it. */
export interface PackSource {
  /** House buys and opens one pull from `machine`; the card lands in the house wallet. */
  buy(machine: PackTier, battleId: string, hooks?: BuyHooks): Promise<Pull>;
  /** Send a card the house holds to `to`. Returns the transaction signature. */
  deliver(nftAddress: string, to: string): Promise<string>;
  /** Who owns a card right now (for safe retries after a crash). */
  ownerOf(nftAddress: string): Promise<string | null>;
}

export interface BuyHooks {
  /** Called as soon as the purchase is paid, before anything can fail after it. Save the memo then. */
  onPaid?(memo: string): void;
  /** Finish a purchase that was already paid (from onPaid) instead of buying again. */
  resumeMemo?: string;
}

export const US_REGIONS: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'],
  ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'],
  ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'],
  ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'],
  ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];
export const regionName = (code: string) => US_REGIONS.find(([c]) => c === code)?.[1] ?? code;
