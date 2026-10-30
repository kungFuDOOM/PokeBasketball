// The cheat-check tag for a reported player and the Reported tab's sort order, as pure functions (no page, no server).

/** One match among a player's open reports, as returned in `checks` by pokejam_admin_reports (migration 20261123). */
export interface MatchCheck {
  match_id: string; queue: string | null; has_evidence: boolean;
  /** The stored judge verdict (pokejam_match_verdicts); null when the match has not been judged. */
  status: 'final' | 'incomplete' | 'forfeit' | 'invalid' | null;
  agrees: boolean | null; cheater_is_reported: boolean | null;
}
export type CheatTag = 'clean' | 'flagged' | 'none';

/** This many open reports or more marks a player as repeat-reported. */
export const REPEAT_MIN = 2;

const flags = (c: MatchCheck) =>
  c.status === 'invalid' || (c.status === 'final' && c.agrees === false) || (c.status === 'forfeit' && c.cheater_is_reported === true);

/** Flagged if any verdict counts against the reported player; clean if at least one final verdict agrees and nothing is
 *  flagged; otherwise no check (Social, no uploads, incomplete, or not yet judged). An opponent's forfeit does not flag. */
export function cheatTag(checks: readonly MatchCheck[] | null | undefined): CheatTag {
  const list = checks ?? [];
  if (list.some(flags)) return 'flagged';
  if (list.some((c) => c.status === 'final' && c.agrees === true)) return 'clean';
  return 'none';
}

/** Flagged first, then repeat-reported, then more reports, then the most recent report. Stable for ties; does not mutate. */
export function sortReported<T extends { reports: number; last_at: string; checks?: readonly MatchCheck[] | null }>(rows: readonly T[]): T[] {
  const key = (r: T) => [cheatTag(r.checks) === 'flagged' ? 1 : 0, r.reports >= REPEAT_MIN ? 1 : 0, r.reports, Date.parse(r.last_at) || 0];
  return rows
    .map((r) => ({ r, k: key(r) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i] - a.k[i];
      return 0;
    })
    .map(({ r }) => r);
}
