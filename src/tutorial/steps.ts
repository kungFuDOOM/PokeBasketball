/**
 * Tutorial step logic: pure data + a reducer. No DOM, no Game import.
 * The watcher (engine -> signals) feeds `reduce`; the UI reads `currentStep` / `hintFor`.
 */

export type TutorialStep = 'move' | 'pass' | 'shoot' | 'dunk' | 'special' | 'defense' | 'steal';
export type InputKind = 'keys' | 'touch';

/** Engine events the tutorial cares about (a subset of GameEvent kinds, plus 'pass'). */
export type TutorialEventKind = 'pass' | 'release' | 'score' | 'special' | 'steal' | 'block';

export type Signal =
  /** The user's player moved `dist` feet this frame. */
  | { type: 'moved'; dist: number }
  /** The user spent `dt` seconds on defense this frame. */
  | { type: 'defending'; dt: number }
  /** An engine event; `byUser` is true when the user's team/player did it. */
  | { type: 'event'; kind: TutorialEventKind; byUser: boolean; how?: 'jump' | 'layup' | 'dunk' }
  | { type: 'skipStep' }
  | { type: 'skipAll' };

export interface StepDef {
  id: TutorialStep;
  title: string;
  prompt: Record<InputKind, string>;
  /** Progress needed (feet moved, seconds defending, or 1 for one-shot events). */
  goal: number;
  /** How much progress this signal adds to the step (0 = no effect). */
  progress: (s: Signal) => number;
}

const userEvent = (s: Signal, kind: TutorialEventKind) => s.type === 'event' && s.byUser && s.kind === kind;

export const MOVE_GOAL_FT = 12;
export const DEFENSE_GOAL_S = 3;

export const STEPS: readonly StepDef[] = [
  {
    id: 'move',
    title: 'Move',
    prompt: { keys: 'Move with WASD or the arrow keys', touch: 'Drag the stick to move' },
    goal: MOVE_GOAL_FT,
    progress: (s) => (s.type === 'moved' && s.dist > 0 ? s.dist : 0),
  },
  {
    id: 'pass',
    title: 'Pass',
    prompt: { keys: 'Press K to pass to a teammate', touch: 'Tap A to pass to a teammate' },
    goal: 1,
    progress: (s) => (userEvent(s, 'pass') ? 1 : 0),
  },
  {
    id: 'shoot',
    title: 'Shoot',
    prompt: {
      keys: 'Hold J or Space to shoot, release at the top',
      touch: 'Hold X to shoot, release at the top',
    },
    goal: 1,
    progress: (s) =>
      userEvent(s, 'release') || (userEvent(s, 'score') && s.type === 'event' && s.how !== 'dunk') ? 1 : 0,
  },
  {
    id: 'dunk',
    title: 'Dunk',
    prompt: {
      keys: 'Hold Shift and shoot near the rim to dunk',
      touch: 'Hold RB and tap X near the rim to dunk',
    },
    goal: 1,
    progress: (s) => (userEvent(s, 'score') && s.type === 'event' && s.how === 'dunk' ? 1 : 0),
  },
  {
    id: 'special',
    title: 'Special',
    prompt: { keys: 'Press I or E to use your special move', touch: 'Tap Y to use your special move' },
    goal: 1,
    progress: (s) => (userEvent(s, 'special') ? 1 : 0),
  },
  {
    id: 'defense',
    title: 'Defense',
    prompt: {
      keys: 'On defense: stay between your man and the hoop',
      touch: 'On defense: use the stick to stay between your man and the hoop',
    },
    goal: DEFENSE_GOAL_S,
    progress: (s) => (s.type === 'defending' && s.dt > 0 ? s.dt : 0),
  },
  {
    id: 'steal',
    title: 'Steal',
    prompt: { keys: 'Press L near the ball handler to steal', touch: 'Tap B near the ball handler to steal' },
    goal: 1,
    progress: (s) => (userEvent(s, 'steal') ? 1 : 0),
  },
];

export interface TutorialState {
  /** Index into STEPS; equals STEPS.length once done. */
  index: number;
  /** Progress toward the current step's goal. */
  progress: number;
  done: boolean;
  /** True if the player finished via skipAll. */
  skipped: boolean;
}

export const initialState = (): TutorialState => ({ index: 0, progress: 0, done: false, skipped: false });

export const currentStep = (s: TutorialState): StepDef | null => (s.done ? null : STEPS[s.index] ?? null);

const advance = (s: TutorialState): TutorialState => {
  const index = s.index + 1;
  return index >= STEPS.length
    ? { ...s, index: STEPS.length, progress: 0, done: true }
    : { ...s, index, progress: 0 };
};

/** Pure reducer: returns the same object when the signal changes nothing. */
export function reduce(state: TutorialState, signal: Signal): TutorialState {
  if (state.done) return state;
  if (signal.type === 'skipAll') return { ...state, index: STEPS.length, progress: 0, done: true, skipped: true };
  if (signal.type === 'skipStep') return advance(state);
  const step = STEPS[state.index];
  const add = step.progress(signal);
  if (!(add > 0)) return state;
  const progress = state.progress + add;
  return progress >= step.goal ? advance(state) : { ...state, progress };
}

export function hintFor(step: TutorialStep, input: InputKind): string {
  const def = STEPS.find((d) => d.id === step);
  return def ? def.prompt[input] : '';
}
