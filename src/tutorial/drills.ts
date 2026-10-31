/**
 * Training drills: pure data + scoring. No DOM, no Game import.
 * Each drill has a goal, a rep target and/or time limit, a scoring function,
 * 1–3 star thresholds and short coach lines. The runner (runner.ts) feeds it signals.
 */

export type InputKind = 'keys' | 'touch';

/** Engine events the tutorial cares about (a subset of GameEvent kinds, plus 'pass'). */
export type TutorialEventKind = 'pass' | 'release' | 'score' | 'special' | 'steal' | 'block';

/** Signals produced by the watcher (watcher.ts) from engine state. */
export type Signal =
  /** The user's player moved `dist` feet this frame. */
  | { type: 'moved'; dist: number }
  /** The user spent `dt` seconds on defense this frame. */
  | { type: 'defending'; dt: number }
  /** An engine event; `byUser` is true when the user's team/player did it. */
  | { type: 'event'; kind: TutorialEventKind; byUser: boolean; how?: 'jump' | 'layup' | 'dunk' }
  | { type: 'skipStep' }
  | { type: 'skipAll' };

/** Signals a drill can consume: watcher signals plus "the user reached the target spot". */
export type DrillSignal = Signal | { type: 'spot' };

export type DrillId = 'movement' | 'layups' | 'jumpshots' | 'passing' | 'defense' | 'steals';

export const DRILL_IDS: readonly DrillId[] = ['movement', 'layups', 'jumpshots', 'passing', 'defense', 'steals'];

export type Stars = 0 | 1 | 2 | 3;

/** What a drill run produced; the runner accumulates it. */
export interface DrillStats {
  /** Successful reps (spots hit, buckets made, passes completed, stops, steals). */
  reps: number;
  /** Shots released (shooting drills only; used for accuracy). */
  attempts: number;
  /** Seconds spent defending (defense drill only). */
  defendS: number;
  /** Points the CPU scored on the user (defense drill only). */
  allowed: number;
  /** Seconds elapsed when the drill ended. */
  elapsed: number;
}

export const emptyStats = (): DrillStats => ({ reps: 0, attempts: 0, defendS: 0, allowed: 0, elapsed: 0 });

/** How a single signal changes the stats (all fields additive; omitted = 0). */
export type StatDelta = Partial<Omit<DrillStats, 'elapsed'>>;

/** Coach line slots every drill provides. Ids are `${drill}.${slot}`. */
export type CoachSlot = 'intro' | 'tip' | 'rep' | 'great' | 'good' | 'retry';
export type CoachLineId = `${DrillId}.${CoachSlot}`;

export interface DrillDef {
  id: DrillId;
  title: string;
  /** One-line objective, per input method (≤ ~60 chars). */
  goal: Record<InputKind, string>;
  /** Drill ends early once this many reps are done (null = runs the full time limit). */
  repTarget: number | null;
  /** Seconds before the drill ends. */
  timeLimit: number;
  /** Ascending score thresholds for 1, 2 and 3 stars. */
  stars: readonly [number, number, number];
  /** Maps a signal to a stats change (null = ignored). */
  count: (s: DrillSignal) => StatDelta | null;
  /** Final score from the run's stats. Always an integer ≥ 0. */
  score: (st: DrillStats) => number;
  coach: Record<CoachSlot, string>;
}

/** Max length for any coach/goal line so it fits the prompt strip. */
export const MAX_LINE = 60;

type EventSignal = Extract<Signal, { type: 'event' }>;

/** The user's event of `kind`, or null. (Not a type guard: that would narrow events out of else-branches.) */
const userEvent = (s: DrillSignal, kind: TutorialEventKind): EventSignal | null =>
  s.type === 'event' && s.byUser && s.kind === kind ? s : null;

const clampInt = (n: number) => Math.max(0, Math.round(Number.isFinite(n) ? n : 0));

/** Seconds left on the clock (never negative). */
const timeLeft = (st: DrillStats, limit: number) => Math.max(0, limit - st.elapsed);

/** Accuracy 0..1 (0 when nothing attempted). */
const accuracy = (st: DrillStats) => (st.attempts > 0 ? Math.min(1, st.reps / st.attempts) : 0);

const DEFS: readonly DrillDef[] = [
  {
    id: 'movement',
    title: 'Movement',
    goal: { keys: 'Run to each glowing spot with WASD or arrows', touch: 'Drag the stick to each glowing spot' },
    repTarget: 6,
    timeLimit: 40,
    stars: [300, 600, 800],
    count: (s) => (s.type === 'spot' ? { reps: 1 } : null),
    // 100 per spot, plus 10 per second left if every spot was reached.
    score: (st) => clampInt(st.reps * 100 + (st.reps >= 6 ? timeLeft(st, 40) * 10 : 0)),
    coach: {
      intro: 'Footwork first. Hit every spot, fast!',
      tip: 'Cut straight to the next spot.',
      rep: 'Got it! Next spot.',
      great: 'Quick feet! That was elite.',
      good: 'Nice moves. Shave a few seconds.',
      retry: 'Keep moving. Go spot to spot.',
    },
  },
  {
    id: 'layups',
    title: 'Layups',
    goal: { keys: 'Drive to the rim and press J to lay it in', touch: 'Drive to the rim and tap X to lay it in' },
    repTarget: null,
    timeLimit: 45,
    stars: [6, 12, 18],
    count: (s) => {
      if (userEvent(s, 'release')) return { attempts: 1 };
      const made = userEvent(s, 'score');
      if (made && (made.how === 'layup' || made.how === 'dunk')) return { reps: 1 };
      return null;
    },
    // 2 points per make.
    score: (st) => clampInt(st.reps * 2),
    coach: {
      intro: 'Attack the rim. Make as many as you can!',
      tip: 'Get close before you shoot.',
      rep: 'Bucket!',
      great: 'Unstoppable at the rim!',
      good: 'Solid finishing. Keep attacking.',
      retry: 'Get all the way to the rim first.',
    },
  },
  {
    id: 'jumpshots',
    title: 'Jump Shots',
    goal: {
      keys: 'Hold J, release at the top of your jump',
      touch: 'Hold X, release at the top of your jump',
    },
    repTarget: null,
    timeLimit: 60,
    stars: [400, 800, 1200],
    count: (s) => {
      if (userEvent(s, 'release')) return { attempts: 1 };
      if (userEvent(s, 'score')?.how === 'jump') return { reps: 1 };
      return null;
    },
    // 100 per make, scaled up to +50% for accuracy.
    score: (st) => clampInt(st.reps * 100 * (1 + 0.5 * accuracy(st))),
    coach: {
      intro: 'Shoot from the rings. Timing is everything.',
      tip: 'Let go right at the top of the jump.',
      rep: 'Splash!',
      great: 'Pure shooter! Automatic.',
      good: 'Good stroke. Work on your release.',
      retry: 'Release at the very top. Try again.',
    },
  },
  {
    id: 'passing',
    title: 'Passing',
    goal: { keys: 'Press K to hit the open teammate', touch: 'Tap A to hit the open teammate' },
    repTarget: 8,
    timeLimit: 40,
    stars: [400, 800, 1000],
    count: (s) => (userEvent(s, 'pass') ? { reps: 1 } : null),
    // 100 per completed pass, plus 15 per second left if all 8 were made.
    score: (st) => clampInt(st.reps * 100 + (st.reps >= 8 ? timeLeft(st, 40) * 15 : 0)),
    coach: {
      intro: 'Move the ball. Follow the arrows!',
      tip: 'Pass to the teammate the arrow points at.',
      rep: 'Dime!',
      great: 'Floor general! Crisp passing.',
      good: 'Nice ball movement. Be quicker.',
      retry: 'Look for the arrow, then pass.',
    },
  },
  {
    id: 'defense',
    title: 'Defense',
    goal: {
      keys: 'Stay between your man and the hoop',
      touch: 'Use the stick to stay between man and hoop',
    },
    repTarget: null,
    timeLimit: 30,
    stars: [200, 350, 500],
    count: (s) => {
      if (s.type === 'defending' && s.dt > 0) return { defendS: s.dt };
      if (userEvent(s, 'block') || userEvent(s, 'steal')) return { reps: 1 };
      if (s.type === 'event' && s.kind === 'score' && !s.byUser) return { allowed: 2 }; // signals carry no point value; count a bucket as 2
      return null;
    },
    // 10 per second defended, 100 per stop (block/steal), −50 per point allowed (−100 per bucket).
    score: (st) => clampInt(st.defendS * 10 + st.reps * 100 - st.allowed * 50),
    coach: {
      intro: 'Lock them up. Stay between man and hoop.',
      tip: 'Shadow your man. Don’t let him by.',
      rep: 'Stop!',
      great: 'Lockdown defender!',
      good: 'Good D. Go for a block or steal.',
      retry: 'Stay in front. Don’t give up easy ones.',
    },
  },
  {
    id: 'steals',
    title: 'Steals',
    goal: { keys: 'Press L near the dribbler to steal', touch: 'Tap B near the dribbler to steal' },
    repTarget: 3,
    timeLimit: 45,
    stars: [100, 250, 400],
    count: (s) => (userEvent(s, 'steal') ? { reps: 1 } : null),
    // 100 per steal, plus 5 per second left if all 3 were made.
    score: (st) => clampInt(st.reps * 100 + (st.reps >= 3 ? timeLeft(st, 45) * 5 : 0)),
    coach: {
      intro: 'Pick their pocket! Get three steals.',
      tip: 'Get close, then time your swipe.',
      rep: 'Picked!',
      great: 'Quick hands! Total thief.',
      good: 'Nice hands. Be quicker next time.',
      retry: 'Get right up on the dribbler.',
    },
  },
];

export const DRILLS: Readonly<Record<DrillId, DrillDef>> = Object.fromEntries(DEFS.map((d) => [d.id, d])) as Record<
  DrillId,
  DrillDef
>;

export const drill = (id: DrillId): DrillDef => DRILLS[id];

export const isDrillId = (x: unknown): x is DrillId => typeof x === 'string' && (DRILL_IDS as readonly string[]).includes(x);

/** Applies a signal to stats; returns the same object when the drill ignores it. */
export function applySignal(def: DrillDef, st: DrillStats, s: DrillSignal): DrillStats {
  const d = def.count(s);
  if (!d) return st;
  return {
    reps: st.reps + (d.reps ?? 0),
    attempts: st.attempts + (d.attempts ?? 0),
    defendS: st.defendS + (d.defendS ?? 0),
    allowed: st.allowed + (d.allowed ?? 0),
    elapsed: st.elapsed,
  };
}

/** True once the rep target is met or time is up. */
export const isComplete = (def: DrillDef, st: DrillStats): boolean =>
  st.elapsed >= def.timeLimit || (def.repTarget !== null && st.reps >= def.repTarget);

/** Star grade for a score against ascending thresholds (0 = below the 1-star bar). */
export function gradeStars(score: number, thresholds: readonly [number, number, number]): Stars {
  if (!(score >= thresholds[0])) return 0;
  if (score >= thresholds[2]) return 3;
  if (score >= thresholds[1]) return 2;
  return 1;
}

export interface DrillResult {
  score: number;
  stars: Stars;
}

export function grade(def: DrillDef, st: DrillStats): DrillResult {
  const score = def.score(st);
  return { score, stars: gradeStars(score, def.stars) };
}

/** Coach line id for the end-of-drill reaction. */
export const resultSlot = (stars: Stars): CoachSlot => (stars >= 3 ? 'great' : stars >= 1 ? 'good' : 'retry');

export const coachLineId = (id: DrillId, slot: CoachSlot): CoachLineId => `${id}.${slot}`;

export function coachLine(lineId: CoachLineId): string {
  const [id, slot] = lineId.split('.') as [DrillId, CoachSlot];
  return DRILLS[id]?.coach[slot] ?? '';
}

export const goalFor = (id: DrillId, input: InputKind): string => DRILLS[id].goal[input];
