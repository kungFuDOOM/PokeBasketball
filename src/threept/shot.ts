// Contest shot math. Fixed friendly meter, wide open (contest = 1). Stubs: see TASKS.md task 4.
import type { Ratings } from '../data/pokemon';
import type { ShotResult } from './types';

export type ContestGrade = 'perfect' | 'good' | 'early' | 'late' | 'very-early' | 'very-late';

/** TODO(task 4): fixed green half-width as a function of sht only (no difficulty setting, no catch-up). */
export function contestGreenWindow(r: Ratings): number {
  void r;
  return 0.05; // TODO
}

/** TODO(task 4): grade a release meter value (0..1.2) against IDEAL_RELEASE. */
export function gradeRelease(meter: number, r: Ratings): ContestGrade {
  void meter; void r;
  return 'good'; // TODO
}

/** TODO(task 4): make probability for an open three at the arc, matching game.ts releaseShot with contest = 1. */
export function makeProbability(grade: ContestGrade, r: Ratings): number {
  void grade; void r;
  return 0; // TODO
}

export function resolveShot(grade: ContestGrade, r: Ratings, rng: () => number = Math.random): ShotResult {
  return rng() < makeProbability(grade, r) ? 'make' : 'miss';
}
