// Maps the server's rating rows to what the Ranked screen shows. The client never computes a rating: the numbers
// come from pokejam_profiles (via pokejam_ensure_profile) and are only diffed here to say what the last match did.
import type { BadgeRank } from '../../ranked/badge';
import { DIVISIONS, PLACEMENTS, TIERS, view, type MatchOutcome, type RankView, type Tier } from './rank';

/** The rating columns of a pokejam_profiles row. */
export interface ServerRank {
  mmr: number;
  placements: number;
  ladder: number;
  shield: number;
  tier: string | null;
  division: string | null;
  rp: number;
  wins: number;
  losses: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Reads a profile row from the server. Anything missing falls back to a fresh player's value. */
export function parseProfile(row: unknown): ServerRank {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    mmr: num(r.mmr, 1000), placements: num(r.placements, 0), ladder: num(r.ladder, 1000), shield: num(r.shield, 0),
    tier: typeof r.tier === 'string' ? r.tier : null, division: typeof r.division === 'string' ? r.division : null,
    rp: num(r.rp, 0), wins: num(r.wins, 0), losses: num(r.losses, 0),
  };
}

/** The server's tier/division/RP as a RankView (the server computed them; this only formats). */
export function serverView(s: ServerRank): RankView {
  if (s.placements < PLACEMENTS || !s.tier || !(TIERS as readonly string[]).includes(s.tier)) {
    return view({ mmr: s.mmr, placements: Math.min(s.placements, PLACEMENTS - 1), ladder: s.ladder, shield: s.shield, wins: s.wins, losses: s.losses });
  }
  const tier = s.tier as Tier;
  const division = s.division && (DIVISIONS as readonly string[]).includes(s.division) ? (s.division as RankView['division']) : null;
  return { placed: true, tier, division, rp: s.rp, label: division ? `${tier} ${division} · ${s.rp} RP` : `${tier} · ${s.rp} RP` };
}

const position = (v: RankView) => (v.tier ? TIERS.indexOf(v.tier) * 3 + (v.division ? DIVISIONS.indexOf(v.division) : 0) : -1);

/** What one match did to a player's rating, from the server rows read before and after it. */
export function outcomeBetween(before: ServerRank, after: ServerRank): MatchOutcome {
  const b = serverView(before);
  const a = serverView(after);
  let event: MatchOutcome['event'] = null;
  if (before.placements < PLACEMENTS && after.placements >= PLACEMENTS) event = 'placed';
  else if (b.placed && a.placed && position(a) > position(b)) event = 'promoted';
  else if (b.placed && a.placed && position(a) < position(b)) event = 'demoted';
  else if (after.shield > before.shield) event = 'shielded';
  return {
    before: b, after: a, mmrDelta: after.mmr - before.mmr, event,
    state: { mmr: after.mmr, placements: after.placements, ladder: after.ladder, shield: after.shield, wins: after.wins, losses: after.losses },
  };
}

/** True once the server has counted a match for this player (their games played moved). */
export const counted = (before: ServerRank, after: ServerRank) => after.wins + after.losses > before.wins + before.losses;

/** What the Season 1 server says one Ranked match did to me (the `rank` of pokejam_report_result / pokejam_ranked_forfeit). */
export interface RankedResult {
  /** Still in placements: the numbers are withheld (null) until the placement result. */
  placing: boolean;
  event: 'promoted' | 'demoted' | 'shielded' | 'placed' | 'zenith' | null;
  placementsPlayed: number | null;
  /** Ladder scores (div_idx * 100 + points) before and after, and the change. */
  before: number | null;
  after: number | null;
  delta: number | null;
  divIdx: number | null;
  points: number | null;
  /** Rank Shield item: present only when I had one armed for this match. `saved` = points it saved (0 when it was kept). */
  shield?: { armed: boolean; used: boolean; saved: number };
}

const EVENTS: readonly unknown[] = ['promoted', 'demoted', 'shielded', 'placed', 'zenith'];
const nullable = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; // some gateways send numbers as strings
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Reads the server's rank answer; null for anything that isn't the Season 1 shape (nothing, or the old Elo columns). */
export function parseRankResult(raw: unknown): RankedResult | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  // `placing` is always sent by the server; if it is ever missing, placements_played < 5 on a non-placement result still says it.
  const played = nullable(r.placements_played);
  const placing = typeof r.placing === 'boolean' ? r.placing : played !== null && played < PLACEMENT_GAMES && r.event !== 'placed';
  if (typeof r.placing !== 'boolean' && played === null) return null;
  return {
    placing,
    event: EVENTS.includes(r.event) ? (r.event as RankedResult['event']) : null,
    placementsPlayed: nullable(r.placements_played), before: nullable(r.before), after: nullable(r.after), delta: nullable(r.delta),
    divIdx: nullable(r.div_idx), points: nullable(r.points), ...parseResultShield(r.shield),
  };
}

function parseResultShield(raw: unknown): { shield?: NonNullable<RankedResult['shield']> } {
  const s = raw as Record<string, unknown> | null | undefined;
  if (!s || typeof s !== 'object' || s.armed !== true) return {};
  return { shield: { armed: true, used: s.used === true, saved: Math.max(0, nullable(s.saved) ?? 0) } };
}

/** The wait left on a Ranked cooldown, from find_match's refusal ('ranked cooldown: N seconds left'); null for any other error. */
export function cooldownSeconds(message: string): number | null {
  const m = /ranked cooldown: (\d+) seconds? left/i.exec(message);
  return m ? Number(m[1]) : null;
}

/** Season 1 `pokejam_ranked_me()`: my rank, season and shield. Every field is optional on the wire; missing ones read as "not placed yet". */
export interface RankedMe {
  season: number | null;
  daysLeft: number | null;
  /** In placements: no rank or points are shown. */
  placing: boolean;
  placementsPlayed: number;
  divIdx: number | null;
  points: number | null;
  zenith: boolean;
  /** 1 = the shield can block a demotion, 0 = spent. null = unknown. */
  shieldCharge: 0 | 1 | null;
  /** While the shield is spent: losses until it recharges. */
  shieldLossesLeft: number | null;
  /** Whether the shield applies at my rank (Gold 1 and below). */
  shieldActive: boolean;
  wins: number;
  losses: number;
  /** Highest division index reached this season (only once placed). */
  peakIdx?: number | null;
  cooldownUntil: string | null;
  /** The Rank Shield item (not the automatic Demotion Guard above). Absent on an older server. */
  shieldItem?: ShieldItem;
}

/** Why the Rank Shield can't be armed right now (server: pokejam_shield_block). */
export type ShieldBlock = 'empty' | 'used_today' | 'placing' | 'zenith' | 'nothing_to_lose';
const BLOCKS: readonly unknown[] = ['empty', 'used_today', 'placing', 'zenith', 'nothing_to_lose'];

export interface ShieldItem {
  count: number;
  armed: boolean;
  /** A ranked match is on: the arm can't be toggled. */
  locked: boolean;
  /** ISO time the next shield may be used (null = now). */
  nextUseAt: string | null;
  block: ShieldBlock | null;
}

function parseItem(r: { count: unknown; armed: unknown; locked: unknown; next: unknown; block: unknown }): ShieldItem | null {
  const count = nullable(r.count);
  if (count === null) return null;
  return { count: Math.max(0, Math.floor(count)), armed: r.armed === true, locked: r.locked === true,
    nextUseAt: typeof r.next === 'string' ? r.next : null, block: BLOCKS.includes(r.block) ? (r.block as ShieldBlock) : null };
}

/** The weekly challenge that grants a free Rank Shield. */
export interface WeeklyChallenge {
  kind: 'games' | 'wins' | 'days';
  goal: number;
  progress: number;
  done: boolean;
  /** ISO time the week resets (Monday 00:00 UTC). */
  resetsAt: string | null;
}

/** `pokejam_shield_me()`: the item and this week's challenge. */
export interface ShieldStatus extends ShieldItem {
  weekly: WeeklyChallenge | null;
}

/** Reads `pokejam_shield_me()` / `pokejam_shield_arm()`; null for anything unusable. Never throws. */
export function parseShieldStatus(raw: unknown): ShieldStatus | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const item = parseItem({ count: r.count, armed: r.armed, locked: r.locked, next: r.next_use_at, block: r.arm_block });
  if (!item) return null;
  const w = r.weekly as Record<string, unknown> | null | undefined;
  const goal = w && typeof w === 'object' ? nullable(w.goal) : null;
  const weekly: WeeklyChallenge | null = !w || goal === null || goal < 1 ? null : {
    kind: w.kind === 'wins' || w.kind === 'days' ? w.kind : 'games', goal, progress: Math.min(goal, Math.max(0, nullable(w.progress) ?? 0)),
    done: w.done === true, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null };
  return { ...item, weekly };
}

const PLACEMENT_GAMES = 5;

/** Reads `pokejam_ranked_me()`; null for anything that isn't an object. Never throws, never returns NaN. */
export function parseMe(raw: unknown): RankedMe | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const played = Math.min(PLACEMENT_GAMES, Math.max(0, nullable(r.placements_played) ?? 0));
  const divIdx = nullable(r.div_idx);
  const placing = r.status === 'placing' || (r.status !== 'ranked' && (divIdx === null || played < PLACEMENT_GAMES));
  const charge = nullable(r.shield_charge);
  return {
    season: nullable(r.season), daysLeft: nullable(r.days_left), placing, placementsPlayed: placing ? played : PLACEMENT_GAMES,
    divIdx: placing ? null : divIdx, points: placing ? null : nullable(r.points), zenith: !placing && (r.zenith === true || divIdx === 24),
    shieldCharge: charge === null ? null : charge > 0 ? 1 : 0, shieldLossesLeft: nullable(r.shield_losses_left),
    shieldActive: r.shield_active === true, wins: nullable(r.wins) ?? 0, losses: nullable(r.losses) ?? 0, peakIdx: placing ? null : nullable(r.peak_idx),
    cooldownUntil: typeof r.cooldown_until === 'string' ? r.cooldown_until : null,
    ...itemOf(r),
  };
}

function itemOf(r: Record<string, unknown>): { shieldItem?: ShieldItem } {
  const item = parseItem({ count: r.shield_item_count, armed: r.shield_item_armed, locked: r.shield_item_locked, next: r.shield_item_next_use, block: r.shield_item_block });
  return item ? { shieldItem: item } : {};
}

/** One player's public rank from `pokejam_match_ranks`: placed (division index), in placements, or none; undefined when unusable. */
function parseSideRank(raw: unknown): BadgeRank | undefined {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  if (r.status === 'unranked') return null;
  if (r.status === 'placing') {
    const of = nullable(r.placements_total) ?? PLACEMENT_GAMES;
    return { placing: Math.min(of, Math.max(0, nullable(r.placements_played) ?? 0)), of };
  }
  const d = nullable(r.div_idx);
  return r.status === 'ranked' && d !== null && d >= 0 && d <= 24 ? { divIdx: Math.floor(d) } : undefined;
}

/** `pokejam_match_ranks(match)` for the player on `side` (0 = host, 1 = guest): my badge and my opponent's. A side the server did not describe stays undefined (no badge shown). */
export function parseMatchRanks(raw: unknown, side: 0 | 1): { me?: BadgeRank; opp?: BadgeRank } {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return {};
  const mine = parseSideRank(side === 0 ? r.host : r.guest);
  const theirs = parseSideRank(side === 0 ? r.guest : r.host);
  const out: { me?: BadgeRank; opp?: BadgeRank } = {};
  if (mine !== undefined) out.me = mine;
  if (theirs !== undefined) out.opp = theirs;
  return out;
}
