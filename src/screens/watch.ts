// Watch mode: a franchise game where both teams are CPU-controlled and the user just spectates.
import type { Game } from '../game/game';

/** How a franchise game the user was part of got decided. */
export type GameMode = 'played' | 'simmed' | 'watched';

export const WATCH_SPEEDS = [1, 2, 4] as const;
const STEP = 1 / 60;
/** Same safety cap as simulate(): a game never takes this many ticks. */
const MAX_STEPS = 400000;

/** The next speed in the 1x → 2x → 4x → 1x cycle (anything unknown goes back to 1x). */
export function nextSpeed(cur: number): number {
  const i = WATCH_SPEEDS.indexOf(cur as (typeof WATCH_SPEEDS)[number]);
  return i < 0 ? 1 : WATCH_SPEEDS[(i + 1) % WATCH_SPEEDS.length];
}

/** The results-screen tag: "Week 3 · Simulated". Played games carry no suffix. */
export function resultTag(label: string, mode: GameMode): string {
  return mode === 'simmed' ? `${label} · Simulated` : mode === 'watched' ? `${label} · Watched` : label;
}

/** Runs up to `steps` fixed ticks with no rendering; returns true once the game is over. */
export function stepHeadless(g: Game, steps: number): boolean {
  for (let i = 0; i < steps && g.phase !== 'final'; i++) {
    g.update(STEP);
    g.events.length = 0;
    g.sfx.length = 0;
  }
  return g.phase === 'final';
}

/** After a CPU-vs-CPU Quick Play game: mark the home side as the user's so results (headline, Share) read as theirs. */
export function claimUserTeam(g: Game): void {
  g.teams[0].human = true;
}

/** Finishes a game from its current state with the same step function the sim uses. */
export function finishGame(g: Game, maxSteps = MAX_STEPS): Game {
  stepHeadless(g, maxSteps);
  return g;
}
