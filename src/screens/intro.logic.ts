/** Pre-game intro (lineups screen) rules, kept free of DOM so they can be tested. */
export type IntroMode = 'full' | 'quick' | 'off';
export type IntroCtx = 'ranked' | 'social' | 'quick' | 'cpu' | 'franchise';

export const INTRO_MODES: readonly IntroMode[] = ['full', 'quick', 'off'];
export const INTRO_LEN_MS = 6000;
export const INTRO_QUICK_LEN_MS = 3000;
export const INTRO_CAP_MS = 10000;

export function isIntroMode(v: unknown): v is IntroMode {
  return typeof v === 'string' && (INTRO_MODES as readonly string[]).includes(v);
}

/** 'off' only turns off the offline intros; Ranked and Social always show it. */
export function introEnabled(mode: IntroMode, ctx: IntroCtx): boolean {
  if (ctx === 'ranked' || ctx === 'social') return true;
  return mode !== 'off';
}

/**
 * The starting five on the court before tip-off. Offline only in 'full' mode (any ctx, so games without the pre-game
 * card follow the setting too). Online only when the peer plays it as well (never skippable there), whatever the mode.
 */
export function startingFiveEnabled(mode: IntroMode, _ctx: IntroCtx, online: boolean, peerSupports: boolean): boolean {
  if (online) return peerSupports;
  return mode === 'full';
}

export interface IntroTiming {
  lengthMs: number;
  capMs: number;
  /** Offline, Skip ends the intro at once; online it needs both players. */
  instantSkip: boolean;
}

/** Online games always run the full length (both sides must agree); offline 'quick' is shorter. */
export function introLength(ctx: IntroCtx, online: boolean, mode: IntroMode = 'full'): IntroTiming {
  if (online) return { lengthMs: INTRO_LEN_MS, capMs: INTRO_CAP_MS, instantSkip: false };
  const lengthMs = mode === 'quick' && ctx !== 'ranked' && ctx !== 'social' ? INTRO_QUICK_LEN_MS : INTRO_LEN_MS;
  return { lengthMs, capMs: lengthMs, instantSkip: true };
}

/** Online skip votes: the intro ends early only when both players want to skip. */
export class IntroVotes {
  mine = false;
  theirs = false;

  vote(side: 'mine' | 'theirs', skip: boolean) {
    this[side] = skip;
  }

  both(): boolean {
    return this.mine && this.theirs;
  }

  label(): string {
    if (this.both()) return '2/2 ready';
    if (this.mine) return 'Waiting for opponent';
    if (this.theirs) return '1/2 ready';
    return 'Skip';
  }
}
