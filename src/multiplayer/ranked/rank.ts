// Ranked ladder: hidden Elo-style MMR, 5 placement matches, then visible tiers with divisions and rank points.
// Pure functions only (no DOM, no storage) so it is easy to test and to move server-side in phase 2.

export const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Pokémon Master'] as const;
export type Tier = (typeof TIERS)[number];
export const DIVISIONS = ['III', 'II', 'I'] as const;

/**
 * MMR thresholds. Everyone starts at 1000 (low Silver). Each of Bronze..Diamond spans 300 MMR,
 * split into three 100-MMR divisions (III, II, I). Pokémon Master starts at 2200 and has no divisions.
 *   Bronze   <1000 (III <800, II 800-899, I 900-999; floor of the ladder is 700 for display)
 *   Silver   1000-1299   Gold 1300-1599   Platinum 1600-1899   Diamond 1900-2199
 *   Pokémon Master 2200+
 */
export const START_MMR = 1000;
export const TIER_START: Record<Tier, number> = {
  Bronze: 700, Silver: 1000, Gold: 1300, Platinum: 1600, Diamond: 1900, 'Pokémon Master': 2200,
};
export const DIVISION_SIZE = 100;
export const PLACEMENTS = 5;
/** Elo K-factor: bigger swings during placements so new players find their level fast. */
export const K_PLACEMENT = 64;
export const K_RANKED = 24;
/** Demotion protection: at the 0 RP floor of a division you get this many losses before dropping. */
export const DEMOTION_SHIELD = 2;

export interface RankState {
  mmr: number;
  /** Placement games played (0..PLACEMENTS). */
  placements: number;
  /** Visible ladder position in MMR units: drives tier/division/RP. Only moves after placements. */
  ladder: number;
  /** Losses absorbed at a division floor. */
  shield: number;
  wins: number;
  losses: number;
}

export interface RankView {
  placed: boolean;
  tier: Tier | null;
  division: (typeof DIVISIONS)[number] | null;
  /** Rank points 0-99 within the division (Pokémon Master: points above 2200). */
  rp: number;
  label: string;
}

export const newRank = (): RankState => ({ mmr: START_MMR, placements: 0, ladder: START_MMR, shield: 0, wins: 0, losses: 0 });

export function expected(mmr: number, opp: number): number {
  return 1 / (1 + 10 ** ((opp - mmr) / 400));
}

export function tierOf(ladder: number): Tier {
  for (let i = TIERS.length - 1; i > 0; i--) if (ladder >= TIER_START[TIERS[i]]) return TIERS[i];
  return 'Bronze';
}

export function view(s: RankState): RankView {
  if (s.placements < PLACEMENTS) {
    return { placed: false, tier: null, division: null, rp: 0, label: `Unranked, placements ${s.placements}/${PLACEMENTS}` };
  }
  const tier = tierOf(s.ladder);
  if (tier === 'Pokémon Master') {
    const rp = Math.round(s.ladder - TIER_START[tier]);
    return { placed: true, tier, division: null, rp, label: `Pokémon Master · ${rp} RP` };
  }
  const base = Math.max(s.ladder, TIER_START.Bronze) - TIER_START[tier];
  const d = Math.min(2, Math.floor(base / DIVISION_SIZE));
  const rp = Math.floor(base - d * DIVISION_SIZE);
  return { placed: true, tier, division: DIVISIONS[d], rp, label: `${tier} ${DIVISIONS[d]} · ${rp} RP` };
}

const rankIndex = (v: RankView) => (v.tier ? TIERS.indexOf(v.tier) * 3 + (v.division ? DIVISIONS.indexOf(v.division) : 0) : -1);

export interface MatchOutcome {
  before: RankView;
  after: RankView;
  state: RankState;
  mmrDelta: number;
  event: 'placed' | 'promoted' | 'demoted' | 'shielded' | null;
}

/** Apply one ranked result against an opponent of the given MMR. */
export function applyResult(s: RankState, oppMmr: number, won: boolean): MatchOutcome {
  const before = view(s);
  const placing = s.placements < PLACEMENTS;
  const k = placing ? K_PLACEMENT : K_RANKED;
  const delta = Math.round(k * ((won ? 1 : 0) - expected(s.mmr, oppMmr)));
  const n: RankState = { ...s, mmr: s.mmr + delta, wins: s.wins + (won ? 1 : 0), losses: s.losses + (won ? 0 : 1) };
  let event: MatchOutcome['event'] = null;
  if (placing) {
    n.placements++;
    n.ladder = n.mmr; // placements set the visible rank straight from MMR
    n.shield = 0;
    if (n.placements === PLACEMENTS) event = 'placed';
  } else if (won) {
    n.ladder = s.ladder + delta;
    n.shield = 0;
  } else {
    const v = view(s);
    const atFloor = v.tier !== 'Pokémon Master' && v.rp + delta < 0 && s.ladder > TIER_START.Bronze;
    if (atFloor && s.shield < DEMOTION_SHIELD) {
      // Protected: hold at 0 RP of the current division.
      n.ladder = s.ladder - v.rp;
      n.shield = s.shield + 1;
      event = 'shielded';
    } else {
      n.ladder = Math.max(TIER_START.Bronze, s.ladder + delta);
      n.shield = 0;
    }
  }
  const after = view(n);
  if (!placing && after.placed && before.placed) {
    const a = after.tier === 'Pokémon Master' ? 99 : rankIndex(after);
    const b = before.tier === 'Pokémon Master' ? 99 : rankIndex(before);
    if (a > b) event = 'promoted';
    else if (a < b) event = 'demoted';
  }
  return { before, after, state: n, mmrDelta: delta, event };
}

/** Plain text/colour badge for now; final badge art will come from the image generator. */
export const TIER_COLORS: Record<Tier, string> = {
  Bronze: '#b0703a', Silver: '#aab4c0', Gold: '#e6b422', Platinum: '#3fbfb0', Diamond: '#5aa8ff', 'Pokémon Master': '#e0473f',
};
