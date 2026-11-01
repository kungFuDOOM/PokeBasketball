/**
 * Training drill setups for practice games (GameConfig.practice + GameConfig.drill). Pure data in court feet:
 * where each player stands and who has the ball when a drill (re)starts. Written for a user team that attacks
 * the right hoop (team 0); `stageX` mirrors x for a user on team 1. Never used by normal games.
 */
import { COURT_L, type TeamId } from './types';

export type PracticeDrill = 'movement' | 'layups' | 'jumpshots' | 'passing' | 'alleyoop' | 'defense' | 'steals';

export const PRACTICE_DRILLS: readonly PracticeDrill[] = ['movement', 'layups', 'jumpshots', 'passing', 'alleyoop', 'defense', 'steals'];

type Pt = readonly [number, number];
/** One court spot per roster slot, 0 PG … 4 C. */
type Five = readonly [Pt, Pt, Pt, Pt, Pt];

export interface PracticeStage {
  /** True: the user's point guard starts with the ball. False: the CPU's point guard does (user defends). */
  userBall: boolean;
  /** Spots by slot for the user's team and the CPU's (user attacking right). */
  user: Five;
  cpu: Five;
  /** CPU ball handler only dribbles: never shoots or passes (steals drill). */
  cpuDribbleOnly: boolean;
  /** Whether the shot clock runs (only when the CPU runs plays: otherwise the drill timer owns time). */
  shotClock: boolean;
  /**
   * Alley-oop drill: every player except the user and the ball handler holds their stage spot (the user's center
   * waits on the oop marker), and a teammate other than the point guard ending up holding the ball (a plain pass,
   * a rebound) restarts the rep.
   */
  holdSpots?: boolean;
}

/**
 * Alley-oop drill: the marker the user's center waits on (user attacking right), ~9 ft from the rim on the left block
 * side, well inside the 17 ft an alley-oop pass needs.
 */
export const OOP_SPOT: Pt = [82, 19];

/** CPU players parked deep in the user's backcourt, out of the way of offense drills. */
const BENCHED: Five = [[20, 10], [20, 40], [14, 18], [14, 32], [10, 25]];
/** User teammates spread around the arc of the right hoop, clear of the lane. */
const SPREAD: Five = [[62, 25], [70, 5], [70, 45], [86, 3], [86, 47]];

export const PRACTICE_STAGES: Readonly<Record<PracticeDrill, PracticeStage>> = {
  // Run the cones: the user dribbles from half court; the CPU is parked far away.
  movement: { userBall: true, user: [[56, 25], [70, 5], [70, 45], [86, 3], [86, 47]], cpu: BENCHED, cpuDribbleOnly: false, shotClock: false },
  // Wing start ~17 ft out with an open lane; defenders trail behind at half court.
  layups: { userBall: true, user: [[74, 33], [64, 8], [62, 42], [86, 3], [86, 47]], cpu: [[52, 30], [50, 12], [48, 40], [46, 20], [46, 32]], cpuDribbleOnly: false, shotClock: false },
  // Free-throw-line start (mid range), defenders sagging back toward half court.
  jumpshots: { userBall: true, user: [[73, 25], [64, 6], [64, 44], [86, 3], [86, 47]], cpu: [[52, 25], [50, 10], [50, 40], [46, 18], [46, 32]], cpuDribbleOnly: false, shotClock: false },
  // Point guard up top with four spread teammates; defenders sit back so every lane is open.
  passing: { userBall: true, user: SPREAD, cpu: BENCHED, cpuDribbleOnly: false, shotClock: false },
  // Point guard up top; the center waits on the oop marker by the rim, the other three stay out past 17 ft so the lob
  // goes to the marker. Defenders are parked in the backcourt.
  alleyoop: { userBall: true, user: [[64, 25], [66, 4], [66, 46], [70, 44], OOP_SPOT], cpu: BENCHED, cpuDribbleOnly: false, shotClock: false, holdSpots: true },
  // CPU runs plays at the left hoop; the user guards their point guard, set between him and the basket.
  defense: { userBall: false, user: [[28, 25], [20, 10], [20, 40], [12, 18], [12, 32]], cpu: [[36, 25], [26, 6], [26, 44], [16, 14], [16, 36]], cpuDribbleOnly: false, shotClock: true },
  // CPU point guard dribbles near half court, the user's point guard right on him; everyone else far away.
  steals: { userBall: false, user: [[38, 25], [70, 5], [70, 45], [86, 3], [86, 47]], cpu: [[42, 25], [20, 6], [20, 44], [10, 14], [10, 36]], cpuDribbleOnly: true, shotClock: false },
};

/** Movement drill cones in order (user attacking right; mirror with `stageX`). Six, matching the drill's rep target. */
export const MOVEMENT_SPOTS: readonly Pt[] = [[66, 10], [80, 40], [84, 14], [62, 38], [76, 25], [58, 12]];

/** How close (feet) the user has to get to a cone for it to count. */
export const SPOT_REACH = 2.5;

/** Mirrors a stage x when the user is on team 1 (attacking the left hoop). */
export const stageX = (x: number, userTeam: TeamId): number => (userTeam === 0 ? x : COURT_L - x);

/** The alley-oop marker in court feet for the user's team. */
export const oopSpot = (userTeam: TeamId): { x: number; y: number } => ({ x: stageX(OOP_SPOT[0], userTeam), y: OOP_SPOT[1] });

/** Movement cone `i` in court feet for the user's team. */
export function movementSpot(i: number, userTeam: TeamId): { x: number; y: number } | null {
  const s = MOVEMENT_SPOTS[i];
  return s ? { x: stageX(s[0], userTeam), y: s[1] } : null;
}

/** True when `p` stands on movement cone `i`. */
export function reachedSpot(p: { x: number; y: number }, i: number, userTeam: TeamId): boolean {
  const s = movementSpot(i, userTeam);
  return !!s && Math.hypot(p.x - s.x, p.y - s.y) <= SPOT_REACH;
}

export const isPracticeDrill = (x: unknown): x is PracticeDrill =>
  typeof x === 'string' && (PRACTICE_DRILLS as readonly string[]).includes(x);
