// Contest shot math. Fixed friendly meter, wide open (contest = 1), no effort or fire. Mirrors game.ts
// greenWindow / releaseShot / the three-point branch of baseProb so make odds match the main game.
import type { Ratings } from '../data/pokemon';
import { IDEAL_RELEASE, METER_TIME } from '../game/game';
import type { ShotResult } from './types';

export { IDEAL_RELEASE, METER_TIME };

export type ContestGrade = 'perfect' | 'good' | 'early' | 'late' | 'very-early' | 'very-late';

/**
 * One fixed, friendly multiplier on the green window for everyone (the menu difficulty does not apply).
 * 1.4 is a touch wider than Pro (1.35) and keeps a full meter (1.2) a very-late release even at 100 Sht.
 */
export const CONTEST_GREEN_MULT = 1.4;
/** The meter auto-releases here. */
export const METER_MAX = 1.2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Green half-width: game.ts greenWindow for an untouched shooter, times CONTEST_GREEN_MULT. Scales with Sht. */
export function contestGreenWindow(r: Ratings): number {
  return (0.022 + (r.sht / 100) * 0.034) * CONTEST_GREEN_MULT;
}

/** Grade a release meter value (0..1.2) against IDEAL_RELEASE with releaseShot's bands. */
export function gradeRelease(meter: number, r: Ratings): ContestGrade {
  const err = meter - IDEAL_RELEASE;
  const w = contestGreenWindow(r);
  const a = Math.abs(err);
  if (a <= w) return 'perfect';
  if (a <= w * 2.3) return 'good';
  if (a <= w * 4.5) return err < 0 ? 'early' : 'late';
  return err < 0 ? 'very-early' : 'very-late';
}

/** baseProb's three branch. Spots sit within 24 ft, so the long-range term is 0 unless a distance is given. */
export function threeBase(r: Ratings, d = 24): number {
  return clamp(0.1 + r.sht * 0.0037 - Math.max(0, d - 24) * 0.03, 0.02, 0.6);
}

/** Make probability for an open three, matching releaseShot with contest = 1. */
export function makeProbability(grade: ContestGrade, r: Ratings, d = 24): number {
  const base = threeBase(r, d);
  let p: number;
  switch (grade) {
    case 'perfect': p = 0.86; break;
    case 'good': p = base + 0.06; break;
    case 'early': case 'late': p = base * 0.8; break;
    default: p = base * 0.3;
  }
  return clamp(p, 0, 1);
}

export function resolveShot(grade: ContestGrade, r: Ratings, rng: () => number = Math.random): ShotResult {
  return rng() < makeProbability(grade, r) ? 'make' : 'miss';
}
