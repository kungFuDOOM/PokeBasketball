// Offline preview of Pack Battles: play money in localStorage and CPU challengers, with the same shapes
// and rules as the real server (server/), so the screens behave the same either way.

import type { PokeType } from '../data/pokemon';
import { MICRO, type BattleView, type Me, type PrizeView, type PublicConfig } from '../net/protocol';
import type { Backend } from './backend';
import { ApiError } from './backend';
import { PACK_TIERS, TIER_ORDER, US_REGIONS, type PackTier } from './service';

export interface Rival {
  wallet: string;
  teamName: string;
  abbr: string;
  color: string;
  color2: string;
  types: PokeType[];
}

export const RIVALS: Rival[] = [
  { wallet: 'Dunkmaster99', teamName: 'Route 1 Runners', abbr: 'RT1', color: '#3fae5a', color2: '#10351b', types: ['Grass', 'Bug'] },
  { wallet: 'gh0styhoops', teamName: 'Lavender Lights', abbr: 'LAV', color: '#8a5cc7', color2: '#24133d', types: ['Ghost', 'Psychic'] },
  { wallet: 'tidepool', teamName: 'Seafoam Sharks', abbr: 'SEA', color: '#2bb3c9', color2: '#08323a', types: ['Water', 'Ice'] },
  { wallet: 'rockbottom', teamName: 'Mt. Moon Miners', abbr: 'MTM', color: '#9b8a7a', color2: '#2b241d', types: ['Rock', 'Ground'] },
  { wallet: 'zapzap', teamName: 'Power Plant Volts', abbr: 'PWR', color: '#f2c12e', color2: '#3b2d03', types: ['Electric'] },
  { wallet: 'blazeit_not', teamName: 'Victory Road Reds', abbr: 'VRR', color: '#d8432a', color2: '#3a0f08', types: ['Fire', 'Dragon'] },
];
export const rivalOf = (wallet: string) => RIVALS.find((r) => r.wallet === wallet) ?? RIVALS[0];

const KEY = 'pokejam.battles.v2';
const ME = 'preview';
const START_BALANCE = 50 * MICRO;
const priceOf = (t: PackTier) => PACK_TIERS[t].price * (MICRO / 100);
const entryOf = (t: PackTier) => priceOf(t) / 2;

interface Store {
  battles: BattleView[];
  prizes: PrizeView[];
  balance: number;
  teamName: string;
  eligibility: { adult: boolean; region: string } | null;
  seq: number;
}

const uid = (s: Store) => `b${Date.now().toString(36)}${(++s.seq).toString(36)}`;

function seed(): Store {
  const s: Store = { battles: [], prizes: [], balance: START_BALANCE, teamName: 'Pallet Town', eligibility: null, seq: 0 };
  const tiers: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_25', 'pokemon_100', 'pokemon_50', 'pokemon_25'];
  RIVALS.forEach((r, i) => s.battles.push(openBattle(s, r, tiers[i], [60, 120, 180][i % 3], Date.now() - i * 97_000)));
  return s;
}

function openBattle(s: Store, r: Rival, tier: PackTier, quarterLen: number, createdAt = Date.now()): BattleView {
  return {
    id: uid(s), tier, quarterLen, state: 'open', host: { wallet: r.wallet, teamName: r.teamName }, guest: null,
    winner: null, score: null, forfeit: false, commit: '', createdAt, side: null, pull: null,
  };
}

/** Saves are checked on load: anything malformed is dropped rather than trusted. */
function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Store> | null;
    if (!raw || !Array.isArray(raw.battles) || !Array.isArray(raw.prizes) || typeof raw.balance !== 'number') return seed();
    const isTier = (t: unknown): t is PackTier => typeof t === 'string' && t in PACK_TIERS;
    const e = raw.eligibility;
    return {
      battles: raw.battles.filter((b) => b && typeof b.id === 'string' && isTier(b.tier) && typeof b.host?.wallet === 'string'),
      prizes: raw.prizes.filter((p) => p && typeof p.id === 'string' && isTier(p.tier)),
      balance: Math.max(0, Math.floor(raw.balance)),
      teamName: typeof raw.teamName === 'string' ? raw.teamName.slice(0, 20) : 'Pallet Town',
      eligibility: e && typeof e.adult === 'boolean' && US_REGIONS.some(([c]) => c === e.region) ? { adult: e.adult, region: e.region } : null,
      seq: Number(raw.seq) || 0,
    };
  } catch {
    return seed();
  }
}

export class LocalBackend implements Backend {
  readonly online = false;
  private s = load();

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* storage unavailable */ }
  }

  private me_(): Me {
    const e = this.s.eligibility;
    return {
      wallet: ME, teamName: this.s.teamName, balance: this.s.balance, eligibility: e,
      blocked: !e ? 'Confirm your age and state to play paid battles.' : !e.adult ? 'Paid battles are 18+.' : null,
    };
  }

  private side(b: BattleView): BattleView {
    return { ...b, side: b.host.wallet === ME ? 0 : b.guest?.wallet === ME ? 1 : null };
  }

  private pay(tier: PackTier) {
    const why = this.me_().blocked;
    if (why) throw new ApiError(why, 403);
    if (this.s.balance < entryOf(tier)) throw new ApiError('Not enough balance for this battle. Add funds first.', 402);
    this.s.balance -= entryOf(tier);
  }

  async config(): Promise<PublicConfig> {
    return {
      cluster: 'devnet', usdcMint: '', houseWallet: '', houseUsdcAccount: '', restrictedRegions: [], minDeposit: 5 * MICRO,
      tiers: TIER_ORDER.map((t) => ({ tier: t, price: priceOf(t), entry: entryOf(t) })), pickSeconds: 20,
    };
  }

  async me() {
    return this.me_();
  }

  async open() {
    if (this.s.battles.filter((b) => b.state === 'open' && b.host.wallet !== ME).length < 3) {
      this.s.battles.push(openBattle(this.s, RIVALS[Math.floor(Math.random() * RIVALS.length)], TIER_ORDER[Math.floor(Math.random() * 2)], 120));
      this.save();
    }
    return this.s.battles.filter((b) => b.state === 'open' && b.host.wallet !== ME).sort((a, b) => b.createdAt - a.createdAt).map((b) => this.side(b));
  }

  async mine() {
    // Preview matchmaking: a CPU challenger accepts (and pays their half) a few seconds after you post.
    for (const b of this.s.battles) {
      if (b.host.wallet === ME && b.state === 'open' && Date.now() - b.createdAt > 4000) {
        const r = RIVALS[Math.floor(Math.random() * RIVALS.length)];
        b.guest = { wallet: r.wallet, teamName: r.teamName };
        b.state = 'ready';
        this.save();
      }
    }
    return this.s.battles.filter((b) => b.host.wallet === ME || b.guest?.wallet === ME).sort((a, b) => b.createdAt - a.createdAt).map((b) => this.side(b));
  }

  async prizes() {
    return [...this.s.prizes].sort((a, b) => b.createdAt - a.createdAt);
  }

  async setEligibility(adult: boolean, region: string) {
    this.s.eligibility = { adult, region };
    this.save();
    return this.me_();
  }

  async setTeamName(name: string) {
    this.s.teamName = name.trim().slice(0, 20) || 'Pallet Town';
    this.save();
    return this.me_();
  }

  async create(tier: PackTier, quarterLen: number) {
    this.pay(tier);
    const b: BattleView = { ...openBattle(this.s, { ...RIVALS[0], wallet: ME, teamName: this.s.teamName }, tier, quarterLen) };
    this.s.battles.push(b);
    this.save();
    return this.side(b);
  }

  async accept(id: string) {
    const b = this.s.battles.find((x) => x.id === id);
    if (!b || b.state !== 'open' || b.host.wallet === ME) throw new ApiError('Someone already took that battle.', 409);
    this.pay(b.tier);
    b.guest = { wallet: ME, teamName: this.s.teamName };
    b.state = 'ready';
    this.save();
    return this.side(b);
  }

  async cancel(id: string) {
    const b = this.s.battles.find((x) => x.id === id && x.host.wallet === ME && x.state === 'open');
    if (!b) return;
    this.s.balance += entryOf(b.tier);
    this.s.battles = this.s.battles.filter((x) => x !== b);
    this.save();
  }

  // ---- preview only

  addFunds(micro: number) {
    this.s.balance += Math.max(0, Math.floor(micro));
    this.save();
  }

  /** Record a CPU game. `score` is from your side's point of view: [you, them]. */
  finish(id: string, score: [number, number], forfeit = false) {
    const b = this.s.battles.find((x) => x.id === id);
    if (!b || b.state !== 'ready') return;
    const mySide = b.host.wallet === ME ? 0 : 1;
    const won = !forfeit && score[0] > score[1];
    b.state = 'done';
    b.forfeit = forfeit;
    b.score = mySide === 0 ? score : [score[1], score[0]];
    b.winner = (won ? mySide : 1 - mySide) as 0 | 1;
    if (won) {
      this.s.prizes.push({ id: uid(this.s), battleId: b.id, tier: b.tier, state: 'sent', pull: null, transferSignature: null, createdAt: Date.now() });
    }
    this.save();
  }

  /** The CPU challenger in a preview battle. */
  rivalIn(b: BattleView): Rival {
    return rivalOf(b.host.wallet === ME ? b.guest!.wallet : b.host.wallet);
  }
}
