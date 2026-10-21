// Pack Battles: two players split the cost of a gacha pull, play one Quick Play game, and the winner gets the pull.
//
// Each player pays half the machine price into escrow when they post or accept a battle. Cancelling before
// anyone accepts refunds your half. Once the game starts, leaving forfeits. When the game ends, the server
// spends the pot on one pull from the matching Collector Crypt gacha machine and sends what comes out to
// the winner's wallet (see PackSource). Buying after the result, not before, means a cancelled or disputed
// battle never leaves you holding a pull nobody paid for.
//
// This is paid entry for a prize decided by a game, which many places regulate as gambling. Washington
// treats any contest where chance plays a "material" part as gambling even when skill dominates, and
// arcade basketball has randomness on every shot. RESTRICTED_REGIONS below blocks Washington by default.
// Have a gaming lawyer set that list (and confirm you can operate at all from where you are) before
// any real money moves. The region a player picks in the browser is not enough on its own: the server
// must verify location (IP or a geolocation provider) and age before taking an entry.
//
// This file is the only place the screens talk to "the server". LocalBattleService fakes one in
// localStorage with play money so the whole flow can be built and tested now. When you add a real
// backend, implement BattleService against it and swap it in at the bottom of this file.
//
// The real server must decide who won: run the game itself, or replay both players' inputs with a
// shared seed. Never pay out on a score the browser reports, or someone will edit it and take every pot.

import type { PokeType } from '../data/pokemon';

/** Collector Crypt machine codes (`packType` in their Gacha Machine API). */
export type PackTier = 'pokemon_25' | 'pokemon_50' | 'pokemon_100';

/**
 * One tier per public Collector Crypt Pokémon machine. Prices (cents) and odds were read from
 * GET https://gacha.collectorcrypt.com/api/machines on 2026-10-21. The server should refresh both from that
 * endpoint and refuse a battle if a machine's price changed, so players always pay what the pull costs.
 */
export const PACK_TIERS: Record<PackTier, {
  label: string; ccName: string; short: string; color: string; color2: string; price: number;
  odds: { Common: number; Uncommon: number; Rare: number; Epic: number };
}> = {
  pokemon_25: { label: 'Starter Pack', ccName: 'Starter Pokémon Gacha Pack', short: 'STARTER', color: '#3b6fd8', color2: '#0f1a45', price: 2500, odds: { Common: 0.75, Uncommon: 0.2, Rare: 0.04, Epic: 0.01 } },
  pokemon_50: { label: 'Elite Pack', ccName: 'Elite Pokémon Gacha Pack', short: 'ELITE', color: '#e3350d', color2: '#3d0a03', price: 5000, odds: { Common: 0.8, Uncommon: 0.15, Rare: 0.04, Epic: 0.01 } },
  pokemon_100: { label: 'Bronze Pack', ccName: 'Bronze Pokémon Gacha Pack', short: 'BRONZE', color: '#ffcb05', color2: '#5c3d00', price: 10000, odds: { Common: 0.8, Uncommon: 0.15, Rare: 0.04, Epic: 0.01 } },
};

/**
 * Where prize pulls come from. Server-side only: it holds the escrowed pot in a USDC wallet.
 * server/collector-crypt.ts implements it with Collector Crypt's public Gacha Machine API
 * (https://docs.collectorcrypt.com/gacha/api). Called once, after the result is final.
 */
export interface PackSource {
  award(machine: PackTier, winnerWallet: string, battleId: string): Promise<{ memo: string; mode: 'gift' | 'open'; rarity?: string; nftAddress?: string }>;
}

export const TIER_ORDER: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_100'];
export const BATTLE_QUARTERS = [60, 120, 180] as const;
export const entryOf = (t: PackTier) => PACK_TIERS[t].price / 2;
export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** Where paid battles are off. Your lawyer sets this list; Washington is blocked by default. */
export const RESTRICTED_REGIONS: string[] = ['WA'];

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

export interface Challenger {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  /** Player handle shown on the card and in the pre-game intro. */
  handle: string;
  /** Types the challenger favors in the draft (the CPU stand-in uses them). */
  types: PokeType[];
}

export type BattleStatus = 'open' | 'ready' | 'won' | 'lost';

export interface Battle {
  id: string;
  tier: PackTier;
  quarterLen: number;
  /** The other player: the host of an open battle, or whoever accepted yours. */
  rival: Challenger | null;
  /** You created this battle and are waiting for a challenger. */
  mine: boolean;
  status: BattleStatus;
  createdAt: number;
  score?: [number, number];
  forfeit?: boolean;
}

export interface WonPack {
  id: string;
  tier: PackTier;
  rival: string;
  score: [number, number];
  wonAt: number;
  claimed: boolean;
}

export interface Eligibility {
  adult: boolean;
  region: string;
}

export interface BattleService {
  /** Open battles from other players, newest first. */
  open(): Battle[];
  /** Your battles: waiting for a challenger, ready to play, or finished. */
  mine(): Battle[];
  prizes(): WonPack[];
  /** Your balance in cents. */
  balance(): number;
  addFunds(cents: number): void;
  eligibility(): Eligibility | null;
  setEligibility(e: Eligibility): void;
  /** Null when paid battles are allowed, otherwise the reason they are not. */
  blocked(): string | null;
  /** Post a battle and pay your half into escrow. */
  create(tier: PackTier, quarterLen: number): Battle;
  /** Take an open battle and pay your half into escrow. */
  accept(id: string): Battle;
  /** Cancel a battle nobody has accepted yet and refund your half. */
  cancel(id: string): void;
  /** Report a finished game. In production the server decides this, not the client. */
  finish(id: string, score: [number, number]): { won: boolean; prize: WonPack | null };
  /** Leaving a started game loses it. */
  forfeit(id: string): void;
  claim(id: string): void;
}

// ---------------------------------------------------------------- local stand-in (play money)

const KEY = 'pokejam.battles';
const START_BALANCE = 5000;

const RIVALS: Challenger[] = [
  { name: 'Route 1 Runners', abbr: 'RT1', color: '#3fae5a', color2: '#10351b', handle: 'Dunkmaster99', types: ['Grass', 'Bug'] },
  { name: 'Lavender Lights', abbr: 'LAV', color: '#8a5cc7', color2: '#24133d', handle: 'gh0styhoops', types: ['Ghost', 'Psychic'] },
  { name: 'Seafoam Sharks', abbr: 'SEA', color: '#2bb3c9', color2: '#08323a', handle: 'tidepool', types: ['Water', 'Ice'] },
  { name: 'Mt. Moon Miners', abbr: 'MTM', color: '#9b8a7a', color2: '#2b241d', handle: 'rockbottom', types: ['Rock', 'Ground'] },
  { name: 'Power Plant Volts', abbr: 'PWR', color: '#f2c12e', color2: '#3b2d03', handle: 'zapzap', types: ['Electric'] },
  { name: 'Victory Road Reds', abbr: 'VRR', color: '#d8432a', color2: '#3a0f08', handle: 'blazeit_not', types: ['Fire', 'Dragon'] },
];

interface Store {
  battles: Battle[];
  prizes: WonPack[];
  balance: number;
  eligibility: Eligibility | null;
  seq: number;
}

const uid = (s: Store) => `b${Date.now().toString(36)}${(++s.seq).toString(36)}`;

function seed(): Store {
  const s: Store = { battles: [], prizes: [], balance: START_BALANCE, eligibility: null, seq: 0 };
  const tiers: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_25', 'pokemon_100', 'pokemon_50', 'pokemon_25'];
  RIVALS.forEach((r, i) => s.battles.push({
    id: uid(s), tier: tiers[i], quarterLen: BATTLE_QUARTERS[i % 3], rival: r, mine: false, status: 'open',
    createdAt: Date.now() - i * 97_000,
  }));
  return s;
}

const isTier = (v: unknown): v is PackTier => typeof v === 'string' && v in PACK_TIERS;

/** Saves are checked on load: anything malformed is dropped rather than trusted. */
function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Store> | null;
    if (!raw || !Array.isArray(raw.battles) || !Array.isArray(raw.prizes) || typeof raw.balance !== 'number') return seed();
    const battles = raw.battles.filter((b): b is Battle =>
      !!b && typeof b.id === 'string' && isTier(b.tier) && typeof b.quarterLen === 'number'
      && ['open', 'ready', 'won', 'lost'].includes(b.status) && (b.rival === null || typeof b.rival?.name === 'string'));
    const prizes = raw.prizes.filter((p): p is WonPack =>
      !!p && typeof p.id === 'string' && isTier(p.tier) && Array.isArray(p.score) && typeof p.rival === 'string');
    const e = raw.eligibility;
    const eligibility = e && typeof e.adult === 'boolean' && US_REGIONS.some(([c]) => c === e.region) ? { adult: e.adult, region: e.region } : null;
    return { battles, prizes, balance: Math.max(0, Math.floor(raw.balance)), eligibility, seq: Number(raw.seq) || 0 };
  } catch {
    return seed();
  }
}

export class LocalBattleService implements BattleService {
  private s = load();

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch { /* storage unavailable: battles last for this visit only */ }
  }

  private find(id: string): Battle {
    const b = this.s.battles.find((x) => x.id === id);
    if (!b) throw new Error('That battle is gone.');
    return b;
  }

  private pay(tier: PackTier) {
    const why = this.blocked();
    if (why) throw new Error(why);
    const cost = entryOf(tier);
    if (this.s.balance < cost) throw new Error(`You need ${money(cost)} for this battle. Add funds first.`);
    this.s.balance -= cost;
  }

  open() {
    // Keep the lobby lively in the stand-in: refill it when it runs low.
    if (this.s.battles.filter((b) => !b.mine && b.status === 'open').length < 3) {
      const r = RIVALS[Math.floor(Math.random() * RIVALS.length)];
      this.s.battles.push({ id: uid(this.s), tier: TIER_ORDER[Math.floor(Math.random() * 2)], quarterLen: 120, rival: r, mine: false, status: 'open', createdAt: Date.now() });
      this.save();
    }
    return this.s.battles.filter((b) => !b.mine && b.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
  }

  mine() {
    // Stand-in matchmaking: a challenger accepts your battle (and pays their half) a few seconds after you post it.
    for (const b of this.s.battles) {
      if (b.mine && b.status === 'open' && Date.now() - b.createdAt > 4000) {
        b.rival = RIVALS[Math.floor(Math.random() * RIVALS.length)];
        b.status = 'ready';
        this.save();
      }
    }
    return this.s.battles.filter((b) => b.mine || b.status !== 'open').sort((a, b) => b.createdAt - a.createdAt);
  }

  prizes() {
    return [...this.s.prizes].sort((a, b) => b.wonAt - a.wonAt);
  }

  balance() {
    return this.s.balance;
  }

  addFunds(cents: number) {
    this.s.balance += Math.max(0, Math.floor(cents));
    this.save();
  }

  eligibility() {
    return this.s.eligibility ? { ...this.s.eligibility } : null;
  }

  setEligibility(e: Eligibility) {
    this.s.eligibility = { adult: e.adult, region: e.region };
    this.save();
  }

  blocked() {
    const e = this.s.eligibility;
    if (!e) return 'Confirm your age and state to play paid battles.';
    if (!e.adult) return 'Paid battles are 18+.';
    if (RESTRICTED_REGIONS.includes(e.region)) return `Paid battles aren't available in ${regionName(e.region)}.`;
    return null;
  }

  create(tier: PackTier, quarterLen: number) {
    this.pay(tier);
    const b: Battle = { id: uid(this.s), tier, quarterLen, rival: null, mine: true, status: 'open', createdAt: Date.now() };
    this.s.battles.push(b);
    this.save();
    return b;
  }

  accept(id: string) {
    const b = this.find(id);
    if (b.status !== 'open' || b.mine) throw new Error('Someone already took that battle.');
    this.pay(b.tier);
    b.status = 'ready';
    this.save();
    return b;
  }

  cancel(id: string) {
    const b = this.s.battles.find((x) => x.id === id && x.mine && x.status === 'open');
    if (!b) return;
    this.s.balance += entryOf(b.tier);
    this.s.battles = this.s.battles.filter((x) => x !== b);
    this.save();
  }

  finish(id: string, score: [number, number]) {
    const b = this.find(id);
    if (b.status !== 'ready') return { won: b.status === 'won', prize: null };
    const won = score[0] > score[1];
    b.status = won ? 'won' : 'lost';
    b.score = score;
    let prize: WonPack | null = null;
    if (won) {
      prize = { id: uid(this.s), tier: b.tier, rival: b.rival?.name ?? 'Challenger', score, wonAt: Date.now(), claimed: false };
      this.s.prizes.push(prize);
    }
    this.save();
    return { won, prize };
  }

  forfeit(id: string) {
    const b = this.s.battles.find((x) => x.id === id);
    if (!b || b.status !== 'ready') return;
    b.status = 'lost';
    b.forfeit = true;
    this.save();
  }

  claim(id: string) {
    const p = this.s.prizes.find((x) => x.id === id);
    if (p) p.claimed = true;
    this.save();
  }
}

export const battles: BattleService = new LocalBattleService();
