// Maps the server's rating rows to what the Ranked screen shows. The client never computes a rating: the numbers
// come from pokejam_profiles (via pokejam_ensure_profile) and are only diffed here to say what the last match did.
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
}

const EVENTS: readonly unknown[] = ['promoted', 'demoted', 'shielded', 'placed', 'zenith'];
const nullable = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Reads the server's rank answer; null for anything that isn't the Season 1 shape (nothing, or the old Elo columns). */
export function parseRankResult(raw: unknown): RankedResult | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object' || typeof r.placing !== 'boolean') return null;
  return {
    placing: r.placing,
    event: EVENTS.includes(r.event) ? (r.event as RankedResult['event']) : null,
    placementsPlayed: nullable(r.placements_played), before: nullable(r.before), after: nullable(r.after), delta: nullable(r.delta),
    divIdx: nullable(r.div_idx), points: nullable(r.points),
  };
}

/** The wait left on a Ranked cooldown, from find_match's refusal ('ranked cooldown: N seconds left'); null for any other error. */
export function cooldownSeconds(message: string): number | null {
  const m = /ranked cooldown: (\d+) seconds? left/i.exec(message);
  return m ? Number(m[1]) : null;
}
