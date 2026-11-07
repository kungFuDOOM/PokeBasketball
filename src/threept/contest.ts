// Pure contest logic (spots, scoring, clock). Stubs: see /workspace/pj-3pt-ref/TASKS.md.
import type { Mon } from '../data/pokemon';
import {
  BALLS_PER_RACK, CONTEST_SECONDS, RACKS, TOTAL_BALLS,
  type BallResult, type ContestState, type ContestSummary, type FeaturedShooter, type RackId, type ShotResult, type Spot,
} from './types';

/** TODO(task 1): five rack spots just outside the arc on the home hoop, left corner to right corner. */
export function rackSpots(): Spot[] {
  return [];
}

/** TODO(task 2): is ball `index` (0..4) of a rack a money ball? Last ball, or every ball on the chosen rack. */
export function isMoneyBall(rack: RackId, index: number, moneyRack: RackId): boolean {
  void rack; void index; void moneyRack;
  return false; // TODO
}

/** TODO(task 2): points for one ball (1 or 2 on a make, 0 on a miss). */
export function ballPoints(rack: RackId, index: number, moneyRack: RackId, result: ShotResult): number {
  void rack; void index; void moneyRack; void result;
  return 0; // TODO
}

export function newContest(shooter: Mon, moneyRack: RackId): ContestState {
  return { shooter, moneyRack, phase: 'ready', timeLeft: CONTEST_SECONDS, ballIndex: 0, results: [] };
}

/** TODO(task 3): advance the clock; only while 'live'. Ends the contest at 0. */
export function tick(s: ContestState, dt: number): void {
  void s; void dt;
}

/** TODO(task 3): record a resolved shot and advance; finish after TOTAL_BALLS. */
export function recordShot(s: ContestState, result: ShotResult): BallResult | null {
  void s; void result;
  return null;
}

/** TODO(task 2): totals for the results screen. */
export function summarize(s: ContestState): ContestSummary {
  return { score: 0, makes: 0, attempts: s.results.length, moneyMakes: 0, timeLeft: s.timeLeft, finishedEarly: false };
}

export const rackOf = (ballIndex: number): RackId => Math.floor(ballIndex / BALLS_PER_RACK) as RackId;
export const isLastBall = (ballIndex: number) => ballIndex >= TOTAL_BALLS - 1;
export const RACK_COUNT = RACKS;

/** King Kabuto is not implemented. Future hook: return a featured shooter to badge/boost in the picker. */
export function featuredShooter(): FeaturedShooter {
  return null;
}
