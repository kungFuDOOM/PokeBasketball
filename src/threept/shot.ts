// Contest shot constants. The shot itself is the main game's own (src/game/game.ts startShot / releaseShot /
// launchShot / updateShot): the contest runs a real Game and never re-implements the meter, odds or ball flight.
import { IDEAL_RELEASE, METER_TIME } from '../game/game';
import type { Difficulty } from '../game/types';

export { IDEAL_RELEASE, METER_TIME };

/**
 * The difficulty whose green window the contest uses: the game's default (src/main.ts starts every player on Pro).
 * It is fixed so every contest score is comparable: the menu difficulty does not apply.
 */
export const CONTEST_DIFFICULTY: Difficulty = 'pro';
/** The meter auto-releases here (Player.meter's 0..1.25 range in the main game). */
export const METER_MAX = 1.25;
