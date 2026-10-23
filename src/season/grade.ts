import type { Mon } from '../data/pokemon';
import { bestLineup, teamOvr } from '../game/game';

/** Letter grade for a team overall. The one grade scale used everywhere (draft summary, season results, share card). */
export function gradeOfOvr(ovr: number): string {
  const steps: [number, string][] = [[92, 'A+'], [91, 'A'], [90, 'A-'], [89, 'B+'], [88, 'B'], [87, 'B-'], [86, 'C+'], [84, 'C'], [82, 'C-']];
  return steps.find(([min]) => ovr >= min)?.[1] ?? 'D';
}

/** A drafted team's starters overall (same number the draft screen shows) and its grade. */
export function teamGrade(roster: Mon[]): { ovr: number; grade: string } {
  const ovr = roster.length ? teamOvr(bestLineup(roster).starters) : 0;
  return { ovr, grade: gradeOfOvr(ovr) };
}
