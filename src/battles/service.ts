// Pack Battles: two players, one Quick Play game, the winner takes a prize pack.
//
// Entry is free. Prize packs come from the house prize pool, never from the players, so nobody
// stakes anything on the result. Keep it that way unless a lawyer signs off on paid entry for
// the places you operate: Washington (and several other states) treats paid entry into a game
// with a material element of chance as gambling, even when skill matters most.
//
// This file is the only place the screens talk to "the server". LocalBattleService fakes one in
// localStorage so the whole flow can be built and tested now. When you add a real backend,
// implement BattleService against it and swap it in at the bottom of this file.
//
// The real server must decide who won: run the game itself, or replay both players' inputs
// with a shared seed. Never award a pack on a score the browser reports, or someone will
// edit the score and empty the prize pool.

import type { PokeType } from '../data/pokemon';

export type PackTier = 'starter' | 'rare' | 'elite';

export const PACK_TIERS: Record<PackTier, { label: string; short: string; color: string; color2: string }> = {
  starter: { label: 'Starter Pack', short: 'STARTER', color: '#3b6fd8', color2: '#0f1a45' },
  rare: { label: 'Rare Pack', short: 'RARE', color: '#e3350d', color2: '#3d0a03' },
  elite: { label: 'Elite Pack', short: 'ELITE', color: '#ffcb05', color2: '#5c3d00' },
};
export const TIER_ORDER: PackTier[] = ['starter', 'rare', 'elite'];
export const BATTLE_QUARTERS = [60, 120, 180] as const;

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
}

export interface WonPack {
  id: string;
  tier: PackTier;
  rival: string;
  score: [number, number];
  wonAt: number;
  claimed: boolean;
}

export interface BattleService {
  /** Open battles from other players, newest first. */
  open(): Battle[];
  /** Your battles: waiting for a challenger, ready to play, or finished. */
  mine(): Battle[];
  /** Packs left in the house prize pool, by tier. */
  stock(): Record<PackTier, number>;
  prizes(): WonPack[];
  create(tier: PackTier, quarterLen: number): Battle;
  /** Reserve an open battle so nobody else can take it. */
  accept(id: string): Battle;
  cancel(id: string): void;
  /** Report a finished game. In production the server decides this, not the client. */
  finish(id: string, score: [number, number]): { won: boolean; prize: WonPack | null };
  claim(id: string): void;
}

// ---------------------------------------------------------------- local stand-in

const KEY = 'pokejam.battles';

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
  stock: Record<PackTier, number>;
  seq: number;
}

const uid = (s: Store) => `b${Date.now().toString(36)}${(++s.seq).toString(36)}`;

function seed(): Store {
  const s: Store = { battles: [], prizes: [], stock: { starter: 24, rare: 10, elite: 3 }, seq: 0 };
  const tiers: PackTier[] = ['starter', 'rare', 'starter', 'elite', 'rare', 'starter'];
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
    if (!raw || !Array.isArray(raw.battles) || !Array.isArray(raw.prizes) || !raw.stock) return seed();
    const battles = raw.battles.filter((b): b is Battle =>
      !!b && typeof b.id === 'string' && isTier(b.tier) && typeof b.quarterLen === 'number'
      && ['open', 'ready', 'won', 'lost'].includes(b.status) && (b.rival === null || typeof b.rival?.name === 'string'));
    const prizes = raw.prizes.filter((p): p is WonPack =>
      !!p && typeof p.id === 'string' && isTier(p.tier) && Array.isArray(p.score) && typeof p.rival === 'string');
    const stock = { starter: 0, rare: 0, elite: 0 };
    for (const t of TIER_ORDER) stock[t] = Math.max(0, Math.floor(Number(raw.stock[t]) || 0));
    return { battles, prizes, stock, seq: Number(raw.seq) || 0 };
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

  open() {
    // Keep the lobby lively in the stand-in: refill it when it runs low.
    if (this.s.battles.filter((b) => !b.mine && b.status === 'open').length < 3) {
      const r = RIVALS[Math.floor(Math.random() * RIVALS.length)];
      const tier = TIER_ORDER.filter((t) => this.s.stock[t] > 0)[Math.floor(Math.random() * 2)] ?? 'starter';
      this.s.battles.push({ id: uid(this.s), tier, quarterLen: 120, rival: r, mine: false, status: 'open', createdAt: Date.now() });
      this.save();
    }
    return this.s.battles.filter((b) => !b.mine && b.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
  }

  mine() {
    // Stand-in matchmaking: a challenger accepts your battle a few seconds after you post it.
    for (const b of this.s.battles) {
      if (b.mine && b.status === 'open' && Date.now() - b.createdAt > 4000) {
        b.rival = RIVALS[Math.floor(Math.random() * RIVALS.length)];
        b.status = 'ready';
        this.save();
      }
    }
    return this.s.battles.filter((b) => b.mine || b.status !== 'open').sort((a, b) => b.createdAt - a.createdAt);
  }

  stock() {
    return { ...this.s.stock };
  }

  prizes() {
    return [...this.s.prizes].sort((a, b) => b.wonAt - a.wonAt);
  }

  create(tier: PackTier, quarterLen: number) {
    if (this.s.stock[tier] <= 0) throw new Error(`No ${PACK_TIERS[tier].label}s left in the prize pool.`);
    const b: Battle = { id: uid(this.s), tier, quarterLen, rival: null, mine: true, status: 'open', createdAt: Date.now() };
    this.s.battles.push(b);
    this.save();
    return b;
  }

  accept(id: string) {
    const b = this.find(id);
    if (b.status !== 'open' || b.mine) throw new Error('Someone already took that battle.');
    b.status = 'ready';
    this.save();
    return b;
  }

  cancel(id: string) {
    this.s.battles = this.s.battles.filter((b) => !(b.id === id && b.mine && b.status === 'open'));
    this.save();
  }

  finish(id: string, score: [number, number]) {
    const b = this.find(id);
    if (b.status !== 'ready') return { won: b.status === 'won', prize: null };
    const won = score[0] > score[1];
    b.status = won ? 'won' : 'lost';
    b.score = score;
    let prize: WonPack | null = null;
    // The pack leaves the pool either way: the other player takes it when you lose.
    this.s.stock[b.tier] = Math.max(0, this.s.stock[b.tier] - 1);
    if (won) {
      prize = { id: uid(this.s), tier: b.tier, rival: b.rival?.name ?? 'Challenger', score, wonAt: Date.now(), claimed: false };
      this.s.prizes.push(prize);
    }
    this.save();
    return { won, prize };
  }

  claim(id: string) {
    const p = this.s.prizes.find((x) => x.id === id);
    if (p) p.claimed = true;
    this.save();
  }
}

export const battles: BattleService = new LocalBattleService();
