// Shared by the client and the server: how an online match turns into a game, so both build the same one.

import { monByDex } from '../data/pokemon';
import type { GameConfig } from '../game/types';
import type { MatchStart } from './protocol';

/** Online battles are always this difficulty: no assists, no catch-up, no CPU boosts. */
export const ONLINE_DIFFICULTY = 'allstar' as const;

/** Snake order for a two-player, five-round draft starting with `first`. */
export function snakeOrder(first: 0 | 1, rounds = 5): (0 | 1)[] {
  const other = (1 - first) as 0 | 1;
  const out: (0 | 1)[] = [];
  for (let r = 0; r < rounds; r++) out.push(...(r % 2 ? [other, first] : [first, other]));
  return out;
}

export function configFromStart(start: MatchStart): GameConfig {
  const team = (t: MatchStart['home']) => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, roster: t.roster.map(monByDex), human: true });
  return {
    home: team(start.home),
    away: team(start.away),
    quarterLen: start.quarterLen,
    difficulty: ONLINE_DIFFICULTY,
    autoSwitch: true,
    seed: start.seed,
  };
}
