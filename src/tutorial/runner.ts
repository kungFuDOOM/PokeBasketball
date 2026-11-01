/**
 * Drill runner: a pure state machine (intro → countdown → active → done) over the drills in drills.ts.
 * No DOM, no Game import. The tutorial screen feeds it actions (clock ticks, watcher signals,
 * button presses) and reacts to the emits (coach lines, marker requests, countdown, results).
 *
 * Sequencing: a run is a queue of drill ids. `startRun(id)` queues one drill; `startRunAll()` queues
 * all six. After a drill's results ('done'), `next` advances (or finishes the run), `retry` restarts it.
 * `skip` abandons the current drill (recorded as skipped) and moves on; `exit` ends the whole run.
 */
import {
  DRILL_IDS,
  applySignal,
  coachLineId,
  drill,
  emptyStats,
  grade,
  isComplete,
  resultSlot,
  type CoachLineId,
  type DrillId,
  type DrillResult,
  type DrillSignal,
  type DrillStats,
} from './drills';

export type RunnerPhase = 'intro' | 'countdown' | 'active' | 'done';

/** Seconds the intro card shows before the countdown (a `start` action skips it). */
export const INTRO_S = 2.5;
/** Countdown length in whole seconds (3, 2, 1, then GO). */
export const COUNTDOWN_S = 3;
/** If no rep has landed this many seconds into a drill, the coach gives the tip line once. */
export const TIP_AFTER_S = 8;

/** Shot zones the renderer can ring on the floor (shared with the game's `Marker`). */
import type { ShotZone } from '../game/types';
export type { ShotZone };

/**
 * What the screen should draw on the court floor. Game-agnostic: the screen/game resolves these
 * to world positions (spot coordinates, the open teammate, zone radii).
 */
export type MarkerRequest =
  /** Movement target spot `index` (0-based, of `of`). */
  | { kind: 'spot'; index: number; of: number }
  /** Arrow from the user's player to the open teammate. */
  | { kind: 'passLane' }
  | { kind: 'zone'; zone: ShotZone };

export interface DrillOutcome extends DrillResult {
  id: DrillId;
  /** True when the drill was skipped (score 0, 0 stars; never counts toward best stars). */
  skipped: boolean;
}

export interface RunnerState {
  /** Drills in this run, in order. */
  queue: readonly DrillId[];
  /** Index into `queue` of the current drill. */
  index: number;
  /** True when the run was started with "Run all". */
  runAll: boolean;
  phase: RunnerPhase;
  /** Seconds spent in the current phase. */
  phaseT: number;
  stats: DrillStats;
  /** Set when the current drill reaches 'done' (or is skipped). */
  result: DrillOutcome | null;
  /** Outcomes for every drill finished or skipped so far, in order (retries replace earlier entries). */
  outcomes: readonly DrillOutcome[];
  /** Whether the tip line was already given this attempt. */
  tipped: boolean;
  /** True once the whole run is over (last drill passed, or exited). */
  finished: boolean;
  /** True if the run ended via `exit`. */
  exited: boolean;
}

export type RunnerAction =
  | { type: 'tick'; dt: number }
  | { type: 'signal'; signal: DrillSignal }
  /** Skip the intro and start the countdown now. */
  | { type: 'start' }
  /** From results: go to the next drill (or finish). */
  | { type: 'next' }
  /** From results (or mid-drill): restart the current drill from its intro. */
  | { type: 'retry' }
  /** Abandon the current drill and move on. */
  | { type: 'skip' }
  /** End the whole run. */
  | { type: 'exit' };

export type RunnerEmit =
  | { kind: 'coach'; line: CoachLineId }
  /** The full marker set changed (empty = clear). */
  | { kind: 'markers'; markers: MarkerRequest[] }
  /** Countdown tick: 3, 2, 1, then 0 = GO. */
  | { kind: 'countdown'; n: number }
  /** A drill entered its intro (new drill or retry). */
  | { kind: 'drill'; id: DrillId }
  /** A drill ended (completed or skipped). */
  | { kind: 'result'; outcome: DrillOutcome }
  /** The whole run is over. */
  | { kind: 'finished'; exited: boolean; outcomes: DrillOutcome[] };

export interface RunnerStep {
  state: RunnerState;
  emits: RunnerEmit[];
}

/** The drill currently loaded (null once finished). */
export const currentDrill = (s: RunnerState): DrillId | null => (s.finished ? null : s.queue[s.index] ?? null);

/** Seconds left on the current drill's clock (its full limit before 'active'). */
export function timeLeft(s: RunnerState): number {
  const id = currentDrill(s);
  return id ? Math.max(0, drill(id).timeLimit - s.stats.elapsed) : 0;
}

/**
 * Run-all position prefix for the strip label ("Drill 3/6 · "), empty for a single drill. Spelled out so it
 * never reads as a rep counter: a bare "3/6" next to "Jump Shots" looked like 3 of 6 makes.
 */
export const runPos = (s: RunnerState): string => (s.runAll ? `Drill ${s.index + 1}/${s.queue.length} · ` : '');

/** Live strip tag while a drill is active: clock, then "reps/target" or, for scored timed drills, "N made". */
export function activeTag(s: RunnerState): string {
  const id = currentDrill(s);
  if (!id) return '';
  const def = drill(id);
  const secs = Math.ceil(timeLeft(s));
  let tag = ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  if (def.repTarget) tag += ` · ${s.stats.reps}/${def.repTarget}`;
  else if (id === 'layups' || id === 'jumpshots') tag += ` · ${s.stats.reps} made`;
  return tag;
}

/** Markers to draw for a drill in a given phase: from the drill's intro, through the countdown, until it's done. */
export function markersFor(id: DrillId | null, phase: RunnerPhase, stats: DrillStats): MarkerRequest[] {
  if (!id || phase === 'done') return [];
  switch (id) {
    case 'movement': {
      const of = drill(id).repTarget ?? 0;
      return stats.reps < of ? [{ kind: 'spot', index: stats.reps, of }] : [];
    }
    case 'layups':
      return [{ kind: 'zone', zone: 'layup' }];
    case 'jumpshots':
      return [
        { kind: 'zone', zone: 'mid' },
        { kind: 'zone', zone: 'three' },
      ];
    case 'passing':
      return [{ kind: 'passLane' }];
    default:
      return [];
  }
}

const sameMarkers = (a: MarkerRequest[], b: MarkerRequest[]) =>
  a.length === b.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));

function introOf(base: Omit<RunnerState, 'phase' | 'phaseT' | 'stats' | 'result' | 'tipped'>): RunnerState {
  return { ...base, phase: 'intro', phaseT: 0, stats: emptyStats(), result: null, tipped: false };
}

function initial(queue: DrillId[], runAll: boolean): RunnerStep {
  const state = introOf({ queue, index: 0, runAll, outcomes: [], finished: queue.length === 0, exited: false });
  if (state.finished) return { state, emits: [{ kind: 'finished', exited: false, outcomes: [] }] };
  return { state, emits: enterIntroEmits(state) };
}

/** Starts a single-drill run. */
export const startRun = (id: DrillId): RunnerStep => initial([id], false);

/** Starts "Run all": the six drills in order. */
export const startRunAll = (): RunnerStep => initial([...DRILL_IDS], true);

function enterIntroEmits(s: RunnerState): RunnerEmit[] {
  const id = s.queue[s.index];
  return [
    { kind: 'drill', id },
    { kind: 'coach', line: coachLineId(id, 'intro') },
    { kind: 'markers', markers: markersFor(id, 'intro', s.stats) },
  ];
}

const recordOutcome = (outcomes: readonly DrillOutcome[], o: DrillOutcome): DrillOutcome[] => [
  ...outcomes.filter((x) => x.id !== o.id),
  o,
];

/** Moves past the current drill: next drill's intro, or finished. */
function advance(s: RunnerState): RunnerStep {
  const index = s.index + 1;
  if (index >= s.queue.length) {
    const state: RunnerState = { ...s, finished: true };
    return { state, emits: [{ kind: 'markers', markers: [] }, { kind: 'finished', exited: false, outcomes: [...s.outcomes] }] };
  }
  const state = introOf({ ...s, index });
  return { state, emits: enterIntroEmits(state) };
}

/** Ends the active drill: grades it and moves to 'done'. */
function complete(s: RunnerState, id: DrillId): RunnerStep {
  const res = grade(drill(id), s.stats);
  const outcome: DrillOutcome = { id, ...res, skipped: false };
  const state: RunnerState = { ...s, phase: 'done', phaseT: 0, result: outcome, outcomes: recordOutcome(s.outcomes, outcome) };
  return {
    state,
    emits: [
      { kind: 'markers', markers: [] },
      { kind: 'coach', line: coachLineId(id, resultSlot(res.stars)) },
      { kind: 'result', outcome },
    ],
  };
}

const safeDt = (dt: number) => (Number.isFinite(dt) && dt > 0 ? dt : 0);

function tick(s: RunnerState, id: DrillId, dt: number): RunnerStep {
  dt = safeDt(dt);
  if (dt === 0) return { state: s, emits: [] };
  switch (s.phase) {
    case 'intro': {
      const phaseT = s.phaseT + dt;
      if (phaseT < INTRO_S) return { state: { ...s, phaseT }, emits: [] };
      return beginCountdown(s, id);
    }
    case 'countdown': {
      const phaseT = s.phaseT + dt;
      const before = Math.floor(s.phaseT);
      const after = Math.floor(phaseT);
      if (phaseT >= COUNTDOWN_S) {
        const state: RunnerState = { ...s, phase: 'active', phaseT: 0 };
        return { state, emits: [{ kind: 'countdown', n: 0 }] };
      }
      const emits: RunnerEmit[] = [];
      for (let k = before + 1; k <= after; k++) emits.push({ kind: 'countdown', n: COUNTDOWN_S - k });
      return { state: { ...s, phaseT }, emits };
    }
    case 'active': {
      const def = drill(id);
      const elapsed = Math.min(def.timeLimit, s.stats.elapsed + dt);
      let state: RunnerState = { ...s, phaseT: s.phaseT + dt, stats: { ...s.stats, elapsed } };
      if (isComplete(def, state.stats)) return complete(state, id);
      const emits: RunnerEmit[] = [];
      if (!state.tipped && state.stats.reps === 0 && elapsed >= TIP_AFTER_S) {
        state = { ...state, tipped: true };
        emits.push({ kind: 'coach', line: coachLineId(id, 'tip') });
      }
      return { state, emits };
    }
    case 'done':
      return { state: { ...s, phaseT: s.phaseT + dt }, emits: [] };
  }
}

function beginCountdown(s: RunnerState, id: DrillId): RunnerStep {
  const state: RunnerState = { ...s, phase: 'countdown', phaseT: 0 };
  return {
    state,
    emits: [
      { kind: 'countdown', n: COUNTDOWN_S },
      { kind: 'markers', markers: markersFor(id, 'countdown', state.stats) },
    ],
  };
}

function signal(s: RunnerState, id: DrillId, sig: DrillSignal): RunnerStep {
  // Legacy skip signals from the old step flow map onto runner actions.
  if (sig.type === 'skipStep') return step(s, { type: 'skip' });
  if (sig.type === 'skipAll') return step(s, { type: 'exit' });
  if (s.phase !== 'active') return { state: s, emits: [] };
  const def = drill(id);
  const stats = applySignal(def, s.stats, sig);
  if (stats === s.stats) return { state: s, emits: [] };
  const state: RunnerState = { ...s, stats };
  if (isComplete(def, stats)) return complete(state, id);
  const emits: RunnerEmit[] = [];
  if (stats.reps > s.stats.reps) emits.push({ kind: 'coach', line: coachLineId(id, 'rep') });
  const before = markersFor(id, 'active', s.stats);
  const after = markersFor(id, 'active', stats);
  if (!sameMarkers(before, after)) emits.push({ kind: 'markers', markers: after });
  return { state, emits };
}

/** Pure reducer. Returns the same state object (and no emits) when an action changes nothing. */
export function step(s: RunnerState, a: RunnerAction): RunnerStep {
  const id = currentDrill(s);
  if (!id) return { state: s, emits: [] };
  switch (a.type) {
    case 'tick':
      return tick(s, id, a.dt);
    case 'signal':
      return signal(s, id, a.signal);
    case 'start':
      return s.phase === 'intro' ? beginCountdown(s, id) : { state: s, emits: [] };
    case 'next':
      return s.phase === 'done' ? advance(s) : { state: s, emits: [] };
    case 'retry': {
      const state = introOf(s);
      return { state, emits: enterIntroEmits(state) };
    }
    case 'skip': {
      // A single-drill run (picked from the Training menu) moves on to the next drill as a new single
      // run, like Next on its results card. Only skipping the last drill (or the end of Run all) finishes.
      const after = s.runAll ? null : DRILL_IDS[DRILL_IDS.indexOf(id) + 1] ?? null;
      const move = (st: RunnerState) => (after ? startRun(after) : advance(st));
      if (s.phase === 'done') return move(s);
      const outcome: DrillOutcome = { id, score: 0, stars: 0, skipped: true };
      // Keep an earlier real result for this drill (e.g. a retry that was then skipped).
      const outcomes = s.outcomes.some((o) => o.id === id) ? s.outcomes : recordOutcome(s.outcomes, outcome);
      const r = move({ ...s, outcomes, result: outcome });
      return { state: r.state, emits: [{ kind: 'result', outcome }, ...r.emits] };
    }
    case 'exit': {
      const state: RunnerState = { ...s, finished: true, exited: true };
      return { state, emits: [{ kind: 'markers', markers: [] }, { kind: 'finished', exited: true, outcomes: [...s.outcomes] }] };
    }
  }
}

/** Applies a list of actions in order, concatenating emits (handy for tests and frame batching). */
export function run(s: RunnerState, actions: readonly RunnerAction[]): RunnerStep {
  const emits: RunnerEmit[] = [];
  for (const a of actions) {
    const r = step(s, a);
    s = r.state;
    emits.push(...r.emits);
  }
  return { state: s, emits };
}
