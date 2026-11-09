// Pure contest logic (spots, scoring, clock, phases). No DOM, no canvas.
import type { Mon } from '../data/pokemon';
import { kingFeatured } from '../kabuto/king';
import { HOOP_Y, hoopX } from '../game/types';
import {
  BALLS_PER_RACK, CONTEST_SECONDS, RACKS, TOTAL_BALLS,
  type BallResult, type ContestState, type ContestSummary, type FeaturedShooter, type RackId, type ShotResult, type Spot,
} from './types';

/** Distance from the rim for the wing and top spots: just outside the 23.75 ft arc. */
export const ARC_SPOT_FT = 24;
/** Corner spots sit 22.5 ft from the hoop's centre line (the corner three line is at 22 ft), 3 ft up from the hoop. */
export const CORNER_DY = 22.5;
export const CORNER_DX = 3;

const LABELS = ['Corner L', 'Wing L', 'Top', 'Wing R', 'Corner R'] as const;

/**
 * Five rack spots on the home (right) hoop, which team 0 attacks. Ordered left corner -> right corner from the
 * shooter's point of view facing the hoop (+x), which is y increasing: rack 0 is by the far sideline (y = 0).
 */
export function rackSpots(): Spot[] {
  const hx = hoopX(0);
  const wing = ARC_SPOT_FT / Math.SQRT2;
  const pts: [number, number][] = [
    [hx - CORNER_DX, HOOP_Y - CORNER_DY],
    [hx - wing, HOOP_Y - wing],
    [hx - ARC_SPOT_FT, HOOP_Y],
    [hx - wing, HOOP_Y + wing],
    [hx - CORNER_DX, HOOP_Y + CORNER_DY],
  ];
  return pts.map(([x, y], i) => ({ rack: i as RackId, label: LABELS[i], x, y }));
}

/** Ball `index` (0..4) of a rack is a money ball: the last ball of every rack, or every ball on the chosen rack. */
export function isMoneyBall(rack: RackId, index: number, moneyRack: RackId): boolean {
  return rack === moneyRack || index === BALLS_PER_RACK - 1;
}

/** Points for one ball: 2 for a money ball make, 1 for any other make, 0 on a miss. */
export function ballPoints(rack: RackId, index: number, moneyRack: RackId, result: ShotResult): number {
  if (result !== 'make') return 0;
  return isMoneyBall(rack, index, moneyRack) ? 2 : 1;
}

export function newContest(shooter: Mon, moneyRack: RackId): ContestState {
  return { shooter, moneyRack, phase: 'ready', timeLeft: CONTEST_SECONDS, ballIndex: 0, results: [], inFlight: false };
}

/** First hold / tip: 'ready' -> 'live'. The clock only runs from here. Returns true when it started. */
export function start(s: ContestState): boolean {
  if (s.phase !== 'ready') return false;
  s.phase = 'live';
  return true;
}

export function pause(s: ContestState): boolean {
  if (s.phase !== 'live') return false;
  s.phase = 'paused';
  return true;
}

export function resume(s: ContestState): boolean {
  if (s.phase !== 'paused') return false;
  s.phase = 'live';
  return true;
}

/** Advance the clock; only while 'live'. Clamps at 0, where the contest ends ('done'). */
export function tick(s: ContestState, dt: number): void {
  if (s.phase !== 'live' || !(dt > 0)) return;
  s.timeLeft = Math.max(0, s.timeLeft - dt);
  if (s.timeLeft <= 0) s.phase = 'done';
}

/** A shot leaves the shooter's hands. Only while 'live', one at a time, never past ball 25. */
export function beginShot(s: ContestState): boolean {
  if (s.phase !== 'live' || s.inFlight || s.ballIndex >= TOTAL_BALLS) return false;
  s.inFlight = true;
  return true;
}

/**
 * Record a resolved shot and move to the next ball. Allowed while 'live', or once after the buzzer for the shot
 * that was already in the air (`inFlight`). Returns null otherwise (ready, paused, done with nothing in flight,
 * or all 25 balls taken). The contest is 'done' after ball 25.
 */
export function recordShot(s: ContestState, result: ShotResult): BallResult | null {
  const ok = s.phase === 'live' || (s.phase === 'done' && s.inFlight);
  if (!ok || s.ballIndex >= TOTAL_BALLS) return null;
  const rack = rackOf(s.ballIndex);
  const index = s.ballIndex % BALLS_PER_RACK;
  const ball: BallResult = {
    rack, index, result,
    money: isMoneyBall(rack, index, s.moneyRack),
    points: ballPoints(rack, index, s.moneyRack, result),
  };
  s.results.push(ball);
  s.ballIndex++;
  s.inFlight = false;
  if (s.ballIndex >= TOTAL_BALLS) s.phase = 'done';
  return ball;
}

export const scoreOf = (s: ContestState) => s.results.reduce((n, b) => n + b.points, 0);

/** Totals for the results screen. */
export function summarize(s: ContestState): ContestSummary {
  const makes = s.results.filter((b) => b.result === 'make');
  return {
    score: scoreOf(s),
    makes: makes.length,
    attempts: s.results.length,
    moneyMakes: makes.filter((b) => b.money).length,
    timeLeft: s.timeLeft,
    finishedEarly: s.results.length >= TOTAL_BALLS && s.timeLeft > 0,
  };
}

/** Points on offer per rack for a money-rack choice: 10 on the chosen rack, 6 elsewhere. Always sums to 34. */
export function rackPreview(moneyRack: RackId): number[] {
  return Array.from({ length: RACKS }, (_, r) => {
    let n = 0;
    for (let i = 0; i < BALLS_PER_RACK; i++) n += ballPoints(r as RackId, i, moneyRack, 'make');
    return n;
  });
}

export const rackOf = (ballIndex: number): RackId => Math.min(RACKS - 1, Math.floor(ballIndex / BALLS_PER_RACK)) as RackId;
export const isLastBall = (ballIndex: number) => ballIndex >= TOTAL_BALLS - 1;
export const RACK_COUNT = RACKS;
export { CONTEST_SECONDS };

/** Featured-shooter hook for the picker: King Kabuto (pinned first, badged) while his window is open, else null. */
export function featuredShooter(now: number = Date.now()): FeaturedShooter {
  return kingFeatured(now);
}
