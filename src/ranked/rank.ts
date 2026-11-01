// Season 1 Ranked points system (docs/ranked-plan.md). Pure: no DOM, no network.
// The SQL in supabase/migrations/20261111_pokejam_ranked.sql (pokejam_ranked_step & co) mirrors this file exactly;
// keep the constants and the integer arithmetic in sync (supabase/tests/ranked.test.ts compares them).
//
// All performance maths is done in integers (m = diff / total as a fraction), so TS and SQL round identically.

export const DIV_POINTS = 100;
/** Highest ordinary division (Pokémon Master 1). */
export const TOP_DIV = 23;
/** Zenith: points-only tier above Pokémon Master 1. Stored as div_idx 24, `points` = Zenith points. */
export const ZENITH_IDX = 24;
export const ZENITH_ENTRY_POINTS = 100;
export const ZENITH_FLOOR_POINTS = 50;
export const ZENITH_DECAY_DAYS = 7;
export const ZENITH_DECAY_POINTS = 25;
/** Points you land on after dropping into the division below. */
export const DEMOTE_POINTS = 75;

export const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Prism', 'Eclipse', 'Pokémon Master'] as const;
/** Base win / full-cost loss per tier (Zenith uses Pokémon Master's). */
export const TIER_WIN = [30, 27, 25, 24, 23, 22, 21, 20] as const;
export const TIER_LOSS = [19, 19, 19, 20, 20, 21, 21, 22] as const;

export const SHIELD_MAX_DIV = 8; // Gold 1 and below
export const SHIELD_RECHARGE_LOSSES = 3;

export const PLACEMENTS = 5;
export const PLACEMENT_SHIFT_MAX = 100;
export const SEED_OFFSET = 600;
export const SEED_MAX = 1400;
export const PLACEMENT_START_MAX = 2299;

export const LEAVE_WINDOW_HOURS = 24;
export const LEAVE_HEAVY_FROM = 3;
export const LEAVE_COOLDOWN_MIN = [0, 0, 5, 15, 60] as const; // by leaves in the window: 1st none, 2nd 5, 3rd 15, 4th+ 60

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
/** round(n / d) half-up, for positive integers. */
export const roundDiv = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

// ---------- ranks, names, ladder score ----------

export function tierIndex(divIdx: number): number {
  return Math.min(Math.floor(divIdx / 3), TIERS.length - 1);
}
export function tierName(divIdx: number): string {
  return divIdx >= ZENITH_IDX ? 'Zenith' : TIERS[tierIndex(divIdx)];
}
/** 3 (lowest) .. 1 (highest) inside a tier; null for Zenith. */
export function divisionOf(divIdx: number): number | null {
  return divIdx >= ZENITH_IDX ? null : 3 - (divIdx % 3);
}
/** "Gold 2", "Pokémon Master 1", "Zenith". */
export function rankName(divIdx: number): string {
  const d = divisionOf(divIdx);
  return d === null ? 'Zenith' : `${tierName(divIdx)} ${d}`;
}
export function ladderScore(divIdx: number, points: number): number {
  return divIdx >= ZENITH_IDX ? 2400 + points : divIdx * DIV_POINTS + points;
}
/** Inverse of ladderScore for an ordinary (non-Zenith) score 0..2399. */
export function fromLadderScore(score: number): { divIdx: number; points: number } {
  const s = clamp(Math.floor(score), 0, TOP_DIV * DIV_POINTS + DIV_POINTS - 1);
  return { divIdx: Math.floor(s / DIV_POINTS), points: s % DIV_POINTS };
}
/** "Gold 2 - 40 pts", "Zenith 340". */
export function rankLabel(divIdx: number, points: number): string {
  return divIdx >= ZENITH_IDX ? `Zenith ${points}` : `${rankName(divIdx)} - ${points} pts`;
}

export function baseWin(divIdx: number): number { return TIER_WIN[tierIndex(divIdx)]; }
export function baseLoss(divIdx: number): number { return TIER_LOSS[tierIndex(divIdx)]; }

/** The documented win/loss ranges of a division's tier. */
export function tierRanges(divIdx: number) {
  const W = baseWin(divIdx), L = baseLoss(divIdx);
  return { winMin: roundDiv(4 * W, 5), winMax: roundDiv(3 * W, 2), lossMin: roundDiv(3 * L, 5), lossMax: L };
}

// ---------- performance ----------

/** Margin share as a fraction diff/total (m = (W - L) / (W + L)). No usable score means a photo finish (m = 0). */
export interface Margin { diff: number; total: number }
export const NO_MARGIN: Margin = { diff: 0, total: 1 };

export function validScore(winner: number, loser: number): boolean {
  return Number.isInteger(winner) && Number.isInteger(loser) && winner >= 0 && winner <= 300 && loser >= 0 && loser <= 300 && winner > loser;
}
export function marginOf(winnerScore: number, loserScore: number): Margin {
  if (!validScore(winnerScore, loserScore)) return NO_MARGIN;
  return { diff: winnerScore - loserScore, total: winnerScore + loserScore };
}
export const marginShare = (m: Margin) => m.diff / m.total;

/** Opponent-division modifier: opp_idx - my_idx, clamped to +-3. */
export const opponentAdj = (myIdx: number, oppIdx: number) => clamp(oppIdx - myIdx, -3, 3);

/** win_gain = clamp(round(W * Mw) + adj, round(0.8W), round(1.5W)), Mw = clamp(0.8 + 1.4m, 0.8, 1.5). */
export function winGain(W: number, m: Margin, adj: number): number {
  const x = 2 * m.diff >= m.total ? roundDiv(3 * W, 2) : roundDiv(W * (4 * m.total + 7 * m.diff), 5 * m.total);
  return clamp(x + adj, roundDiv(4 * W, 5), roundDiv(3 * W, 2));
}
/** loss_cost = clamp(round(L * Ml) - adj, round(0.6L), L), Ml = 0.6 + 1.6 * min(m, 0.25). */
export function lossCost(L: number, m: Margin, adj: number): number {
  const x = 4 * m.diff >= m.total ? L : roundDiv(L * (3 * m.total + 8 * m.diff), 5 * m.total);
  return clamp(x - adj, roundDiv(3 * L, 5), L);
}
/** Leaver: full loss cost, no performance reduction; x1.25 from the 3rd leave in 24 h. */
export const leaverCost = (L: number, heavy: boolean) => (heavy ? roundDiv(5 * L, 4) : L);
/** The stayer's win when the opponent leaves: the minimum gain. */
export const stayerGain = (W: number) => roundDiv(4 * W, 5);

// ---------- applying a result to a ranked player ----------

export interface LadderState {
  divIdx: number;
  points: number;
  shieldCharge: 0 | 1;
  /** Losses taken while the shield is empty (recharges at SHIELD_RECHARGE_LOSSES). */
  lossesSinceShield: number;
}
export type ResultMode =
  | 'score' // finished game: winner or loser, performance formula
  | 'leave' // I left: max-cost loss, no shield, optionally x1.25
  | 'stay'; // my opponent left: minimum-gain win
export type RankEvent = 'promoted' | 'demoted' | 'shielded' | 'zenith' | null;

export interface ResultInput {
  won: boolean;
  mode?: ResultMode;
  margin?: Margin;
  /** Opponent's div_idx (a placing opponent counts as floor(seed / 100)). */
  oppIdx: number;
  /** `leave` mode: this is the 3rd+ leave in the window. */
  heavy?: boolean;
}
export interface ResultOutcome { state: LadderState; delta: number; event: RankEvent }

export function newLadderState(divIdx = 0, points = 0): LadderState {
  return { divIdx, points, shieldCharge: 1, lossesSinceShield: 0 };
}

export function applyResult(s: LadderState, i: ResultInput): ResultOutcome {
  const mode = i.mode ?? 'score';
  const margin = i.margin ?? NO_MARGIN;
  const W = baseWin(s.divIdx), L = baseLoss(s.divIdx);
  const adj = opponentAdj(s.divIdx, i.oppIdx);
  let { divIdx, points, shieldCharge, lossesSinceShield } = s;
  let event: RankEvent = null;

  if (i.won) {
    const delta = mode === 'stay' ? stayerGain(W) : winGain(W, margin, adj);
    points += delta;
    if (divIdx < ZENITH_IDX && points >= DIV_POINTS) {
      if (divIdx === TOP_DIV) { divIdx = ZENITH_IDX; points = ZENITH_ENTRY_POINTS; event = 'zenith'; }
      else { divIdx += 1; points -= DIV_POINTS; event = 'promoted'; }
    }
    return { state: { divIdx, points, shieldCharge, lossesSinceShield }, delta, event };
  }

  const cost = mode === 'leave' ? leaverCost(L, !!i.heavy) : lossCost(L, margin, adj);
  points -= cost;
  const hadShield = shieldCharge === 1;
  if (points < 0) {
    if (divIdx === 0) points = 0; // Bronze 3 floor: nothing to lose, shield untouched
    else if (divIdx === ZENITH_IDX) { divIdx = TOP_DIV; points = DEMOTE_POINTS; event = 'demoted'; }
    else if (mode !== 'leave' && divIdx <= SHIELD_MAX_DIV && hadShield) {
      points = 0; shieldCharge = 0; lossesSinceShield = 0; event = 'shielded';
    } else { divIdx -= 1; points = DEMOTE_POINTS; event = 'demoted'; }
  }
  if (!hadShield) { // an empty shield recharges after N losses (leaves count)
    lossesSinceShield += 1;
    if (lossesSinceShield >= SHIELD_RECHARGE_LOSSES) { shieldCharge = 1; lossesSinceShield = 0; }
  }
  return { state: { divIdx, points, shieldCharge, lossesSinceShield }, delta: -cost, event };
}

/** Zenith inactivity: after 7 idle days, 25 points per full 7 days, never below 50 (already-lower scores are kept). */
export function zenithDecay(points: number, idleDays: number): number {
  if (idleDays < ZENITH_DECAY_DAYS) return points;
  return Math.max(Math.min(points, ZENITH_FLOOR_POINTS), points - ZENITH_DECAY_POINTS * Math.floor(idleDays / ZENITH_DECAY_DAYS));
}

// ---------- leavers ----------

export interface LeaveState { leaves: number; windowStartMs: number | null }
export interface LeaveOutcome { leaves: number; windowStartMs: number; cooldownMin: number; heavy: boolean; flag: boolean }

/** Register a leave at `nowMs`: rolling 24 h window from its first leave. */
export function registerLeave(s: LeaveState, nowMs: number): LeaveOutcome {
  const fresh = s.windowStartMs === null || nowMs - s.windowStartMs > LEAVE_WINDOW_HOURS * 3600_000;
  const leaves = (fresh ? 0 : s.leaves) + 1;
  return {
    leaves,
    windowStartMs: fresh ? nowMs : s.windowStartMs!,
    cooldownMin: LEAVE_COOLDOWN_MIN[Math.min(leaves, LEAVE_COOLDOWN_MIN.length - 1)],
    heavy: leaves >= LEAVE_HEAVY_FROM,
    flag: leaves >= 4,
  };
}

// ---------- seed & placements ----------

/** Season seed: clamp(last_final_score - 600, 0, 1400); a new player (no archived season) seeds at 0. */
export function seedScore(lastFinalScore: number | null): number {
  return lastFinalScore === null ? 0 : clamp(lastFinalScore - SEED_OFFSET, 0, SEED_MAX);
}

export type PlacementKind = 'score' | 'leave' | 'stay';
export interface PlacementInput {
  won: boolean;
  kind?: PlacementKind;
  margin?: Margin;
  /** Opponent's ladder score (their seed while they are placing). */
  oppScore: number;
  seed: number;
}
/** w_i = (0.6 + 0.4q) * (1 + clamp((opp - seed) / 1000, -0.2, 0.2)); a leaver weighs 1.0, the stayer 0.6. */
export function placementWeight(i: PlacementInput): number {
  if (i.kind === 'leave') return 1;
  if (i.kind === 'stay') return 0.6;
  const m = i.margin ?? NO_MARGIN;
  const q = Math.min(1, (4 * m.diff) / m.total);
  return (0.6 + 0.4 * q) * (1 + clamp((i.oppScore - i.seed) / 1000, -0.2, 0.2));
}
export const placementShift = (raw: number) => clamp(Math.floor(20 * raw + 0.5), -PLACEMENT_SHIFT_MAX, PLACEMENT_SHIFT_MAX);
export const placementStartScore = (seed: number, raw: number) => clamp(seed + placementShift(raw), 0, PLACEMENT_START_MAX);

export interface PlacementState { played: number; raw: number; seed: number }
export interface PlacementOutcome {
  state: PlacementState;
  /** Set on the fifth match: where the player lands. */
  placed: { divIdx: number; points: number; shift: number } | null;
}
export function applyPlacement(s: PlacementState, i: Omit<PlacementInput, 'seed'>): PlacementOutcome {
  const w = placementWeight({ ...i, seed: s.seed });
  const state = { played: s.played + 1, raw: s.raw + (i.won ? w : -w), seed: s.seed };
  if (state.played < PLACEMENTS) return { state, placed: null };
  const start = fromLadderScore(placementStartScore(s.seed, state.raw));
  return { state, placed: { ...start, shift: placementShift(state.raw) } };
}
